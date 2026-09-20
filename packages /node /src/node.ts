/**
 * WeaveNode — the long-running node object that ties together chain state,
 * mempool, persistence, P2P, miner (toggleable) and the event bus that feeds
 * the WebSocket API. Every block/tx that enters — from peers, the local
 * miner, or the HTTP API — is independently re-validated, persisted,
 * indexed, announced and pushed to wallets.
 */
import { EventEmitter } from "node:events";
import {
  ChainState, UtxoSet, buildGenesisTemplate, compactToTarget, createLockingScript,
  deserializeTransaction, getBlockHash, getBlockHashHex, getBlockRewardSmallestUnits, getTxIdHex,
  hashToHex, hashMeetsTarget, parseLockingScript, validateTransaction,
  type Block, type Transaction, type UTXO,
} from "@weave/core";
import { addressToPubKeyHash } from "@weave/crypto";
import type { Message } from "@weave/protocol";
import type { ChainStore, UtxoStore, UtxoOp } from "./storage/types";
import { Mempool } from "./mempool";
import { assembleCandidateBlock, mineBlock } from "./miner";
import { GossipService } from "./p2p/gossip";
import { PeerManager, generateNodeNonce } from "./p2p/peerManager";
import type { NodeConfig } from "./config";
import { wireSignatureVerification } from "./validation";

export type NodeEvent =
  | { type: "block"; hash: string; height: number; txCount: number; timestamp: number; touched?: string[] }
  | { type: "tx"; txid: string; fee: string; sizeInputs: number; sizeOutputs: number; touched?: string[] }
  | { type: "reorg"; disconnected: string[]; connected: string[]; tip: string };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class WeaveNode extends EventEmitter {
  chain!: ChainState;
  readonly mempool = new Mempool();
  peers!: PeerManager;
  gossip!: GossipService;
  /** pubkeyHash(hex) -> Set of "txid:index" — makes getbalance/listunspent O(#addr utxos). */
  private readonly addrIndex = new Map<string, Set<string>>();
  private minerTimer?: NodeJS.Timeout;
  private mining = false;
  private hashrate = 0;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly config: NodeConfig,
    private readonly utxoStore: UtxoStore,
    private readonly chainStore: ChainStore,
  ) {
    super();
    wireSignatureVerification();
  }

  // ------------------------------------------------------------------ boot

  async start(): Promise<void> {
    await this.loadOrCreateChain();
    this.rebuildAddrIndex();

    this.peers = new PeerManager({
      local: {
        userAgent: "weave-node/0.0.1",
        nonce: generateNodeNonce(),
        genesisHashHex: getBlockHashHex(this.genesisBlock().header),
        listenAddress: this.config.publicP2pAddress,
        getHeight: () => this.chain.height,
        getTipHashHex: () => this.chain.tip.hashHex,
      },
      seedAddresses: this.config.seeds,
      onPeerReady: (p) => this.gossip.onPeerReady(p),
      onPeerMessage: (p, m) => this.gossip.onMessage(p, m),
      onPeerDisconnect: (p) => this.gossip.onPeerDisconnect(p),
    });
    this.gossip = new GossipService(this.chain, this.mempool, this.peers, {
      onBlockAccepted: (b, h, height) => this.afterBlockConnected(b, h, height),
      onReorg: (d, c, tip) => this.emitEvent({ type: "reorg", disconnected: d, connected: c, tip }),
      onTxAccepted: (tx, id) => this.afterTxAccepted(tx, id),
    });
    if (this.config.mining.enabled) this.startMining();
  }

  async stop(): Promise<void> {
    this.stopMining();
    this.peers?.stop();
    await this.persistQueue;
  }

  private genesisBlock(): Block {
    const g = this.config.genesis;
    const pkh = g.payoutAddress ? addressToPubKeyHash(g.payoutAddress) : null;
    if (g.payoutAddress && !pkh) throw new Error("GENESIS_ADDRESS is not a valid Weave address");
    const template = buildGenesisTemplate({
      timestamp: g.timestamp,
      difficultyTarget: g.difficultyTarget,
      // Unspendable-by-anyone default (all-zero hash) if no address configured.
      genesisPayoutLockingScript: createLockingScript(pkh ?? new Uint8Array(20)),
      rewardSmallestUnits: BigInt(getBlockRewardSmallestUnits(0)),
    });
    const target = compactToTarget(template.header.difficultyTarget)!;
    for (let nonce = 0; nonce <= 0xffff_ffff; nonce++) {
      const header = { ...template.header, nonce };
      if (hashMeetsTarget(getBlockHash(header), target)) return { header, transactions: template.transactions };
    }
    throw new Error("could not mine genesis block; lower GENESIS_BITS difficulty");
  }

  /** Restore from disk (full re-validation via ChainState) or start from genesis. */
  private async loadOrCreateChain(): Promise<void> {
    const genesis = this.genesisBlock();
    this.chain = ChainState.fromGenesis(genesis, new UtxoSet());
    const tip = await this.chainStore.getTip();
    if (!tip) {
      await this.persistBlock(genesis);
      await this.utxoStore.batch([...this.chain.utxoSet.snapshot().values()].map((utxo) => ({ type: "put" as const, utxo })));
      await this.chainStore.setTip(this.chain.tip.hashHex);
      await this.chainStore.setHashAtHeight(0, this.chain.tip.hashHex);
      return;
    }
    // Replay the best chain from disk through ChainState — a node never trusts even its own disk blindly.
    const hashes: string[] = [];
    for (let h = 1; ; h++) {
      const hh = await this.chainStore.getHashAtHeight(h);
      if (!hh) break;
      hashes.push(hh);
    }
    for (const hh of hashes) {
      const block = await this.chainStore.getBlock(hh);
      if (!block) continue; // pruned body
      const r = this.chain.addBlock(block);
      if (r.status === "rejected") throw new Error(`stored block ${hh} failed re-validation: ${r.reason}`);
    }
  }

  // ------------------------------------------------------- accept choke points

  /** Accept a block from the local miner or HTTP submit. Peer blocks flow through GossipService instead. */
  acceptLocalBlock(block: Block): { ok: boolean; status: string; reason?: string; hash: string } {
    const res = this.chain.addBlock(block);
    const hash = getBlockHashHex(block.header);
    if (res.status === "rejected") return { ok: false, status: res.status, reason: res.reason, hash };
    if (res.status === "duplicate" || res.status === "orphan") return { ok: false, status: res.status, hash };
    if (res.status === "accepted-reorg") {
      this.emitEvent({ type: "reorg", disconnected: res.disconnected, connected: res.connected, tip: hash });
    }
    if (res.status !== "accepted-side-branch") {
      this.afterBlockConnected(block, hash, res.height);
    }
    this.peers?.broadcast({ type: "inv", items: [{ type: "block", hashHex: hash }] } as Message);
    return { ok: true, status: res.status, hash };
  }

  /** Validate against OUR utxo set, add to mempool, relay, push to wallets. */
  acceptTransaction(tx: Transaction): { ok: boolean; txid: string; reason?: string } {
    const txid = getTxIdHex(tx);
    if (this.mempool.has(txid)) return { ok: false, txid, reason: "already in mempool" };
    const v = validateTransaction(tx, this.chain.utxoSet, this.chain.height + 1);
    if (!v.valid) return { ok: false, txid, reason: v.reason };
    // Reject conflicts with pending txs (simple double-spend guard within mempool).
    const pending = this.mempoolSpends;
    for (const input of tx.inputs) {
      const k = `${hashToHex(input.prevTxId)}:${input.outputIndex}`;
      if (pending.has(k)) return { ok: false, txid, reason: `input ${k} already spent by a pending transaction` };
    }
    const added = this.mempool.add(tx, v.fee);
    if (!added.accepted) return { ok: false, txid, reason: added.reason };
    this.afterTxAccepted(tx, txid, v.fee);
    this.peers?.broadcast({ type: "inv", items: [{ type: "tx", hashHex: txid }] } as Message);
    return { ok: true, txid };
  }

  private get mempoolSpends(): Set<string> {
    const s = new Set<string>();
    for (const tx of this.mempool.getPrioritized())
      for (const i of tx.inputs) s.add(`${hashToHex(i.prevTxId)}:${i.outputIndex}`);
    return s;
  }

  private afterTxAccepted(tx: Transaction, txid: string, fee?: bigint): void {
    this.emitEvent({
      type: "tx", txid, fee: (fee ?? 0n).toString(), sizeInputs: tx.inputs.length, sizeOutputs: tx.outputs.length,
      touched: this.pkhsOfOutputs(tx),
    });
  }

  private afterBlockConnected(block: Block, hash: string, height: number): void {
    this.rebuildAddrIndex(); // simple + reorg-safe; see "known limits"
    this.mempool.removeAll(block.transactions);
    this.emitEvent({
      type: "block", hash, height, txCount: block.transactions.length, timestamp: block.header.timestamp,
      touched: [...new Set(block.transactions.flatMap((t) => this.pkhsOfOutputs(t)))],
    });
    this.enqueuePersist();
  }

  private pkhsOfOutputs(tx: Transaction): string[] {
    const out: string[] = [];
    for (const o of tx.outputs) {
      const p = parseLockingScript(o.lockingScript);
      if (p) out.push(hex(p.pubKeyHash));
    }
    return out;
  }

  private emitEvent(e: NodeEvent): void {
    this.emit("event", e);
  }

  // ------------------------------------------------------------- persistence

  private enqueuePersist(): void {
    this.persistQueue = this.persistQueue.then(() => this.persistBestChain()).catch((e) => console.error("persist failed", e));
  }

  private async persistBlock(block: Block): Promise<void> {
    const hash = getBlockHashHex(block.header);
    const ib = this.chain.getByHash(hash);
    if (!ib) return;
    await this.chainStore.putBlock(block, {
      hashHex: hash, height: ib.height, cumulativeWork: ib.cumulativeWork.toString(), onBestChain: ib.onBestChain,
    });
  }

  private async persistBestChain(): Promise<void> {
    const tip = this.chain.tip;
    // Walk back from tip until a height whose stored hash already matches; persist everything above.
    const toWrite: typeof tip[] = [];
    let cur: typeof tip | undefined = tip;
    while (cur) {
      const stored = await this.chainStore.getHashAtHeight(cur.height);
      if (stored === cur.hashHex) break;
      toWrite.unshift(cur);
      cur = cur.height === 0 ? undefined : this.chain.getByHash(hashToHex(cur.block.header.prevHash));
    }
    for (const ib of toWrite) {
      await this.persistBlock(ib.block);
      await this.chainStore.setHashAtHeight(ib.height, ib.hashHex);
    }
    // Drop stale height entries if a reorg shortened the chain.
    for (let h = tip.height + 1; (await this.chainStore.getHashAtHeight(h)) !== null; h++) {
      await this.chainStore.deleteHashAtHeight(h);
    }
    await this.chainStore.setTip(tip.hashHex);
    await this.syncUtxoStore();
    await this.prune();
  }

  /** Diff live UTXO set vs persisted set and apply atomically. */
  private async syncUtxoStore(): Promise<void> {
    const live = this.chain.utxoSet.snapshot();
    const ops: UtxoOp[] = [];
    const seen = new Set<string>();
    for await (const u of this.utxoStore.all()) {
      const k = `${hashToHex(u.txid)}:${u.outputIndex}`;
      seen.add(k);
      if (!live.has(k)) ops.push({ type: "delete", txidHex: hashToHex(u.txid), outputIndex: u.outputIndex });
    }
    for (const [k, u] of live) if (!seen.has(k)) ops.push({ type: "put", utxo: u });
    if (ops.length) await this.utxoStore.batch(ops);
  }

  /** Anti-centralization: keep only `retainBlocks` recent block bodies. Meta + height index stay (tiny). */
  private async prune(): Promise<void> {
    const keep = this.config.retainBlocks;
    if (!keep) return;
    const cutoff = this.chain.height - keep;
    if (cutoff <= 0) return;
    const store = this.chainStore as ChainStore & { deleteBlockBody?: (h: string) => Promise<void> };
    if (!store.deleteBlockBody) return;
    for (let h = Math.max(1, cutoff - 50); h <= cutoff; h++) {
      const hh = await this.chainStore.getHashAtHeight(h);
      if (hh) await store.deleteBlockBody(hh);
    }
  }

  // --------------------------------------------------------------- addr index

  private rebuildAddrIndex(): void {
    this.addrIndex.clear();
    for (const [k, u] of this.chain.utxoSet.snapshot()) {
      const parsed = parseLockingScript(u.lockingScript);
      if (!parsed) continue;
      const pkh = hex(parsed.pubKeyHash);
      let set = this.addrIndex.get(pkh);
      if (!set) this.addrIndex.set(pkh, (set = new Set()));
      set.add(k);
    }
  }

  utxosForAddress(address: string): UTXO[] | null {
    const pkh = addressToPubKeyHash(address);
    if (!pkh) return null;
    const keys = this.addrIndex.get(hex(pkh));
    if (!keys) return [];
    const snap = this.chain.utxoSet.snapshot();
    return [...keys].map((k) => snap.get(k)!).filter(Boolean);
  }

  // ------------------------------------------------------------------- mining

  get isMining(): boolean {
    return this.mining;
  }

  startMining(payoutAddress = this.config.mining.payoutAddress): void {
    if (this.mining) return;
    const pkh = payoutAddress ? addressToPubKeyHash(payoutAddress) : null;
    if (!pkh) throw new Error("mining requires a valid MINER_ADDRESS / payout address");
    this.mining = true;
    const script = createLockingScript(pkh);
    let extra = 0;
    const slice = () => {
      if (!this.mining) return;
      const started = Date.now();
      const tip = this.chain.tip;
      const { block } = assembleCandidateBlock({
        height: tip.height + 1,
        prevHash: tip.hash,
        difficultyTarget: this.chain.nextDifficultyBits(),
        payoutLockingScript: script,
        mempool: this.mempool,
        coinbaseExtraData: new Uint8Array(new Uint32Array([extra++]).buffer),
        timestamp: Math.max(Math.floor(Date.now() / 1000), tip.block.header.timestamp + 1),
      });
      const attempts = this.config.mining.maxAttemptsPerSlice;
      const found = mineBlock(block, { maxAttempts: attempts });
      const dt = Math.max(1, Date.now() - started);
      this.hashrate = Math.round(((found?.hashesTried ?? attempts) * 1000) / dt);
      if (found) {
        const r = this.acceptLocalBlock(found.block);
        if (!r.ok) console.warn(`mined block rejected: ${r.status} ${r.reason ?? ""}`);
      }
      // Yield to the event loop between slices so API/P2P stay responsive while mining.
      this.minerTimer = setTimeout(slice, 0);
    };
    this.minerTimer = setTimeout(slice, 0);
  }

  stopMining(): void {
    this.mining = false;
    this.hashrate = 0;
    if (this.minerTimer) clearTimeout(this.minerTimer);
  }

  // ----------------------------------------------------------- read helpers

  async getBlockByHashOrHeight(id: string): Promise<{ block: Block; hash: string; height: number; confirmations: number } | null> {
    let hash = id;
    if (/^\d+$/.test(id)) {
      const h = await this.chainStore.getHashAtHeight(Number(id));
      if (!h) return null;
      hash = h;
    }
    const indexed = this.chain.getByHash(hash);
    const block = indexed?.block ?? (await this.chainStore.getBlock(hash));
    if (!block) return null;
    const meta = indexed ?? (await this.chainStore.getMeta(hash));
    if (!meta) return null;
    return { block, hash, height: meta.height, confirmations: meta.onBestChain ? this.chain.height - meta.height + 1 : 0 };
  }

  blockchainInfo() {
    const tip = this.chain.tip;
    return {
      chain: "weave",
      height: tip.height,
      bestBlockHash: tip.hashHex,
      difficultyBits: "0x" + tip.block.header.difficultyTarget.toString(16),
      nextDifficultyBits: "0x" + this.chain.nextDifficultyBits().toString(16),
      cumulativeWork: tip.cumulativeWork.toString(),
      utxoCount: this.chain.utxoSet.size,
      mempoolSize: this.mempool.size(),
      peers: this.peers?.readyPeers.length ?? 0,
      mining: this.mining,
      hashrate: this.hashrate,
      retainBlocks: this.config.retainBlocks,
      orphanBlocks: this.chain.orphanCount,
    };
  }

  parseTx(txHex: string): Transaction {
    return deserializeTransaction(new Uint8Array(Buffer.from(txHex, "hex")));
  }
}