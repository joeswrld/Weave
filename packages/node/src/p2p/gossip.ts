/**
 * Weave gossip layer (Phase 5): the chain-aware logic that sits on top of
 * peer.ts/peerManager.ts. This is where `inv`/`getdata`/`getblocks` turn
 * into actual sync decisions, where incoming `block`/`tx` messages get
 * independently re-validated against this node's own `ChainState`/
 * `Mempool` before being trusted or relayed, and where orphan/reorg
 * outcomes from `@weave/core`'s `ChainState.addBlock` are turned into the
 * right network behavior (ask the sender for the missing parent; announce
 * a new tip after a reorg).
 *
 * The one rule every handler here follows, straight from the build spec's
 * "Decentralization model": a peer's message is an invitation to check
 * something, never proof of anything. `ChainState.addBlock` and
 * `validateTransaction` — this node's own independent re-verification
 * against its own state — are the only things that ever decide what this
 * node believes, regardless of who sent the message or how many peers
 * repeat it.
 */

import {
  ChainState,
  deserializeBlock,
  deserializeTransaction,
  getBlockHashHex,
  getTxIdHex,
  hashToHex,
  serializeBlock,
  serializeTransaction,
  validateTransaction,
  type Block,
  type Transaction,
} from "@weave/core";
import type { InventoryItem, Message } from "@weave/protocol";
import { MAX_LOCATOR_HASHES } from "@weave/protocol";
import type { Mempool } from "../mempool";
import type { Peer } from "./peer";
import type { PeerManager } from "./peerManager";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many blocks a single `getblocks` reply will `inv` at once — keeps initial sync from producing one giant message. */
export const GETBLOCKS_REPLY_LIMIT = 500;

/** How long we'll wait for a `getdata` reply to something we asked for before considering the peer unresponsive for that item. */
export const GETDATA_TIMEOUT_MS = 20_000;

/** Caps how many orphan blocks we'll hold at once, network-wide, as a crude DoS guard (matches the field `ChainState.orphanCount` exposes for exactly this purpose). */
export const MAX_ORPHAN_BLOCKS = 1_000;

export interface GossipEvents {
  onBlockAccepted?: (block: Block, hashHex: string, height: number) => void;
  onReorg?: (disconnected: string[], connected: string[], newTipHashHex: string) => void;
  onTxAccepted?: (tx: Transaction, txidHex: string) => void;
}

/**
 * Ties a `ChainState` + `Mempool` to a `PeerManager`, handling every
 * post-handshake message type gossip.ts is responsible for. Constructed
 * once per node (see main.ts) and wired as the `PeerManager`'s
 * `onPeerReady`/`onPeerMessage` callbacks.
 */
export class GossipService {
  private readonly chain: ChainState;
  private readonly mempool: Mempool;
  private readonly peers: PeerManager;
  private readonly events: GossipEvents;

  /** Hashes we've already announced via `inv` recently, so we don't re-broadcast something we just received right back out redundantly on every peer's ping. Cleared opportunistically; not consensus-relevant. */
  private readonly recentlyAnnounced = new Set<string>();
  private readonly RECENT_ANNOUNCE_CAP = 10_000;

  /** Items we've asked a specific peer for via `getdata`, so an unsolicited reply (or a reply from someone else) doesn't get treated as a request we made. */
  private readonly pendingRequests = new Map<Peer, Set<string>>();

  constructor(chain: ChainState, mempool: Mempool, peers: PeerManager, events: GossipEvents = {}) {
    this.chain = chain;
    this.mempool = mempool;
    this.peers = peers;
    this.events = events;
  }

  // -- Entry points, wired into PeerManager ---------------------------------

  /** Call when a peer completes its handshake: kicks off initial block sync against it if it claims more work/height than we have. */
  onPeerReady(peer: Peer): void {
    this.pendingRequests.set(peer, new Set());
    const remoteHeight = peer.remoteHeight ?? 0;
    if (remoteHeight > this.chain.height) {
      this.requestBlocksFrom(peer);
    }
  }

  onPeerDisconnect(peer: Peer): void {
    this.pendingRequests.delete(peer);
  }

  /** Call for every post-handshake message a peer sends. */
  onMessage(peer: Peer, message: Message): void {
    switch (message.type) {
      case "inv":
        this.handleInv(peer, message.items);
        return;
      case "getdata":
        this.handleGetData(peer, message.items);
        return;
      case "getblocks":
        this.handleGetBlocks(peer, message.locatorHashesHex, message.stopHashHex);
        return;
      case "block":
        this.handleBlock(peer, message.blockHex);
        return;
      case "tx":
        this.handleTx(peer, message.txHex);
        return;
      case "reject":
        // Informational only — a peer telling us it didn't like something
        // we sent. Nothing to re-verify (there's no claim to trust here),
        // so there's nothing gossip.ts needs to do beyond what a future
        // logging/metrics layer might want.
        return;
      default:
        // version/verack/ping/pong are handled entirely inside peer.ts and
        // never reach here.
        return;
    }
  }

  // -- inv / getdata ---------------------------------------------------------

  private handleInv(peer: Peer, items: InventoryItem[]): void {
    const toRequest: InventoryItem[] = [];
    for (const item of items) {
      const haveIt = item.type === "block" ? this.chain.has(item.hashHex) : this.mempool.has(item.hashHex);
      if (!haveIt) toRequest.push(item);
    }
    if (toRequest.length === 0) return;

    const pending = this.pendingRequests.get(peer) ?? new Set<string>();
    for (const item of toRequest) pending.add(requestKey(item));
    this.pendingRequests.set(peer, pending);

    peer.send({ type: "getdata", items: toRequest });
  }

  private handleGetData(peer: Peer, items: InventoryItem[]): void {
    for (const item of items) {
      if (item.type === "block") {
        const indexed = this.chain.getByHash(item.hashHex);
        if (indexed) peer.send({ type: "block", blockHex: bytesToHex(serializeBlock(indexed.block)) });
        continue;
      }
      // item.type === "tx" — mempool doesn't expose raw entries by hash for
      // re-serialization directly, so we look it up via the prioritized
      // list; fine at Weave's expected mempool sizes (Phase 6+ storage can
      // add a direct lookup if this becomes a bottleneck).
      const tx = this.mempool.getPrioritized().find((t) => getTxIdHex(t) === item.hashHex);
      if (tx) peer.send({ type: "tx", txHex: bytesToHex(serializeTransaction(tx)) });
    }
  }

  // -- getblocks (initial sync / catch-up) ------------------------------------

  /** Builds a locator (dense near the tip, sparse further back — see messages.ts) and asks a peer for anything we're missing. */
  private requestBlocksFrom(peer: Peer): void {
    const locator = this.buildLocator();
    peer.send({ type: "getblocks", locatorHashesHex: locator });
  }

  private buildLocator(): string[] {
    const locator: string[] = [];
    let height = this.chain.height;
    let step = 1;
    let indexed = this.chain.getByHash(this.chain.tip.hashHex);
    while (indexed && locator.length < MAX_LOCATOR_HASHES) {
      locator.push(indexed.hashHex);
      if (height === 0) break;
      height = Math.max(0, height - step);
      // Exponential backoff once we have a few entries, same idea as
      // Bitcoin's own getblocks locator — dense near the tip, sparse further back.
      if (locator.length >= 10) step *= 2;
      indexed = this.findAncestorAtHeight(height);
    }
    return locator;
  }

  private findAncestorAtHeight(height: number): ReturnType<ChainState["getByHash"]> {
    // ChainState doesn't expose height->block directly on the public API
    // beyond the tip walk it does internally, so we walk from the tip here
    // too. Fine for the infrequent case of building a locator; not a
    // per-block hot path.
    if (height < 0) return undefined;
    let cur = this.chain.getByHash(this.chain.tip.hashHex);
    while (cur && cur.height > height) {
      cur = this.chain.getByHash(hashToHex(cur.block.header.prevHash));
    }
    return cur && cur.height === height ? cur : undefined;
  }

  private handleGetBlocks(peer: Peer, locatorHashesHex: string[], stopHashHex?: string): void {
    // Find the highest locator hash we actually have — that's the fork point.
    let forkHeight = -1;
    for (const hashHex of locatorHashesHex) {
      const indexed = this.chain.getByHash(hashHex);
      if (indexed && indexed.onBestChain) {
        forkHeight = indexed.height;
        break;
      }
    }
    // If we don't recognize any locator hash, we can't help this peer sync
    // (most likely: genuinely different chains, already caught at
    // handshake by genesis-hash mismatch, or a very deep fork we no longer
    // have full history for). Send nothing rather than guess.
    if (forkHeight < 0) return;

    const items: InventoryItem[] = [];
    let height = forkHeight + 1;
    let cur = this.findAncestorAtHeight(height);
    while (cur && items.length < GETBLOCKS_REPLY_LIMIT) {
      items.push({ type: "block", hashHex: cur.hashHex });
      if (stopHashHex && cur.hashHex === stopHashHex) break;
      height++;
      cur = this.findAncestorAtHeight(height);
    }
    if (items.length > 0) peer.send({ type: "inv", items });
  }

  // -- block / tx propagation --------------------------------------------------

  private handleBlock(peer: Peer, blockHex: string): void {
    let block: Block;
    try {
      block = deserializeBlock(hexToBytes(blockHex));
    } catch {
      peer.reject("block", "malformed", "could not deserialize block");
      return;
    }

    const hashHex = getBlockHashHex(block.header);
    this.clearPendingRequest(peer, "block", hashHex);

    // Full independent re-validation happens inside ChainState.addBlock —
    // this node never takes the peer's word for it.
    const result = this.chain.addBlock(block);

    switch (result.status) {
      case "duplicate":
        return; // already known — nothing to do, nothing to relay again
      case "rejected":
        peer.reject("block", "invalid-block", result.reason, hashHex);
        return;
      case "orphan": {
        // We don't have this block's parent — ask the sender (who
        // presumably does) to walk us back to something we recognize,
        // rather than accepting the orphan on faith.
        if (this.chain.orphanCount < MAX_ORPHAN_BLOCKS) {
          this.requestBlocksFrom(peer);
        }
        return;
      }
      case "accepted-side-branch":
        this.announce({ type: "block", hashHex }, peer);
        return;
      case "accepted-extends-tip":
        this.events.onBlockAccepted?.(block, hashHex, result.height);
        this.mempool.removeAll(block.transactions);
        this.announce({ type: "block", hashHex }, peer);
        return;
      case "accepted-reorg":
        this.events.onBlockAccepted?.(block, hashHex, result.height);
        this.events.onReorg?.(result.disconnected, result.connected, hashHex);
        this.mempool.removeAll(block.transactions);
        this.announce({ type: "block", hashHex }, peer);
        return;
    }
  }

  private handleTx(peer: Peer, txHex: string): void {
    let tx: Transaction;
    try {
      tx = deserializeTransaction(hexToBytes(txHex));
    } catch {
      peer.reject("tx", "malformed", "could not deserialize transaction");
      return;
    }

    const txidHex = getTxIdHex(tx);
    this.clearPendingRequest(peer, "tx", txidHex);

    if (this.mempool.has(txidHex)) return; // already known

    const validation = validateTransaction(tx, this.chain.utxoSet, this.chain.height + 1);
    if (!validation.valid) {
      peer.reject("tx", "invalid-tx", validation.reason, txidHex);
      return;
    }

    const added = this.mempool.add(tx, validation.fee);
    if (!added.accepted) {
      // Fee-based or duplicate rejection from mempool policy (node-local,
      // not consensus) — not necessarily this peer's fault, so no reject
      // message, just don't relay it.
      return;
    }

    this.events.onTxAccepted?.(tx, txidHex);
    this.announce({ type: "tx", hashHex: txidHex }, peer);
  }

  /**
   * Announces a block/tx we just accepted to every other ready peer via
   * `inv` (not by pushing the full `block`/`tx` payload directly) — this is
   * the actual gossip step: peers that don't already have it will
   * `getdata` it back from us, and this node relays it onward the same way
   * every other honest node does, which is what makes propagation reach
   * the whole network without anyone needing a full peer list.
   */
  private announce(item: InventoryItem, receivedFrom: Peer): void {
    const key = requestKey(item);
    if (this.recentlyAnnounced.has(key)) return;
    this.recentlyAnnounced.add(key);
    if (this.recentlyAnnounced.size > this.RECENT_ANNOUNCE_CAP) {
      // Cheap unbounded-growth guard — drop the whole set rather than
      // tracking LRU order for something that's a pure efficiency
      // optimization, not a correctness requirement.
      this.recentlyAnnounced.clear();
    }
    this.peers.relay({ type: "inv", items: [item] }, receivedFrom);
  }

  private clearPendingRequest(peer: Peer, type: InventoryItem["type"], hashHex: string): void {
    this.pendingRequests.get(peer)?.delete(requestKey({ type, hashHex }));
  }
}

function requestKey(item: InventoryItem): string {
  return `${item.type}:${item.hashHex}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}