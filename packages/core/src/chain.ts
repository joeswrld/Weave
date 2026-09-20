/**
 * Weave chain state: block index, best-chain tracking by cumulative work,
 * and reorg logic (Phase 3/5 boundary).
 *
 * This is the piece that turns "a bunch of validated blocks" into "the one
 * chain everyone agrees is current". It mirrors Bitcoin's own model:
 *
 *  - Every accepted block (valid header + valid PoW) gets an index entry,
 *    whether or not it's on the current best chain. A block whose parent
 *    isn't known yet is held as an orphan until its parent shows up.
 *  - "Best chain" is decided by cumulative work (sum of 1/target over every
 *    block back to genesis), never by height/length alone — the same
 *    fork-choice rule the build spec calls out explicitly.
 *  - Connecting a new best-chain block means applying it to the UTXO set.
 *    If the new best chain doesn't extend the current tip directly (a
 *    competing branch overtook it), the shorter path is: disconnect blocks
 *    from the current tip back to the fork point (revertBlock, reverse
 *    order), then connect blocks from the fork point up to the new tip
 *    (applyBlock, forward order). That disconnect+connect pair is a reorg.
 *
 * ChainState owns no networking and no storage I/O directly — it's handed
 * a UtxoSet and blocks by its caller (node/p2p/gossip.ts), and the node
 * wires persistence (packages/node/src/storage) around it separately. This
 * keeps chain.ts pure and unit-testable, matching the rest of @weave/core.
 */

import { assembleBlock, checkBlockStructure, getBlockHash, getBlockHashHex, type Block, type BlockHeader } from "./block";
import { nextDifficultyBits } from "./difficulty";
import { hashToHex, isZeroHash, zeroHash, type Hash } from "./hash";
import { compactToTarget } from "./target";
import { createCoinbaseTransaction } from "./transaction";
import {
  applyBlock,
  checkProofOfWork,
  MEDIAN_TIME_PAST_WINDOW,
  revertBlock,
  UtxoSet,
  validateBlock,
  type BlockContext,
  type UTXO,
} from "./utxo";

// ---------------------------------------------------------------------------
// Block index
// ---------------------------------------------------------------------------

export interface IndexedBlock {
  block: Block;
  hash: Hash;
  hashHex: string;
  height: number;
  /** Cumulative work of the chain ending at this block (genesis included). */
  cumulativeWork: bigint;
  /** Whether this block is on the current best chain. */
  onBestChain: boolean;
}

/** work(target) = 2^256 / (target + 1), same definition Bitcoin uses — a lower target is more work. */
function blockWork(target: bigint): bigint {
  return (1n << 256n) / (target + 1n);
}

function workForHeader(header: BlockHeader): bigint | null {
  const target = compactToTarget(header.difficultyTarget);
  if (target === null) return null;
  return blockWork(target);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AddBlockResult =
  | { status: "accepted-extends-tip"; hash: string; height: number }
  | { status: "accepted-reorg"; hash: string; height: number; disconnected: string[]; connected: string[] }
  | { status: "accepted-side-branch"; hash: string; height: number }
  | { status: "orphan"; hash: string; missingParent: string }
  | { status: "duplicate"; hash: string }
  | { status: "rejected"; hash: string; reason: string };

// ---------------------------------------------------------------------------
// ChainState
// ---------------------------------------------------------------------------

export class ChainState {
  private readonly index = new Map<string, IndexedBlock>();
  /** Blocks whose parent we don't have yet, keyed by the missing parent's hex hash. */
  private readonly orphansByParent = new Map<string, Block[]>();
  private tipHex: string;
  readonly utxoSet: UtxoSet;
  /** Tracks what applyBlock removed for each best-chain block, so a later disconnect can exactly undo it. */
  private readonly appliedUtxosCache = new Map<string, UTXO[]>();

  private constructor(genesis: IndexedBlock, utxoSet: UtxoSet) {
    this.index.set(genesis.hashHex, genesis);
    this.tipHex = genesis.hashHex;
    this.utxoSet = utxoSet;
    this.appliedUtxosCache.set(genesis.hashHex, []); // set post-hoc below in fromGenesis
  }

  /**
   * Builds a fresh chain from a genesis block, applying it to a fresh (or
   * caller-provided) UtxoSet. The genesis block still goes through PoW and
   * structural checks — a chain shouldn't even start from an invalid block —
   * but skips the "must build on the expected tip" and median-time-past
   * checks that only make sense once a chain already exists.
   */
  static fromGenesis(genesis: Block, utxoSet: UtxoSet = new UtxoSet()): ChainState {
    const structuralProblem = checkBlockStructure(genesis);
    if (structuralProblem) throw new Error(`invalid genesis block: ${structuralProblem}`);
    if (!isZeroHash(genesis.header.prevHash)) {
      throw new Error("genesis block must have an all-zero prevHash");
    }
    const powProblem = checkProofOfWork(genesis.header);
    if (powProblem) throw new Error(`invalid genesis block: ${powProblem}`);

    const work = workForHeader(genesis.header);
    if (work === null) throw new Error("invalid genesis block: invalid difficultyTarget");

    const removed = applyBlock(genesis, utxoSet, 0);

    const hash = getBlockHash(genesis.header);
    const indexed: IndexedBlock = {
      block: genesis,
      hash,
      hashHex: hashToHex(hash),
      height: 0,
      cumulativeWork: work,
      onBestChain: true,
    };
    const chain = new ChainState(indexed, utxoSet);
    chain.appliedUtxosCache.set(indexed.hashHex, removed);
    return chain;
  }

  // -- Read access -----------------------------------------------------

  get tip(): IndexedBlock {
    return this.index.get(this.tipHex)!;
  }

  get height(): number {
    return this.tip.height;
  }

  getByHash(hashHex: string): IndexedBlock | undefined {
    return this.index.get(hashHex);
  }

  has(hashHex: string): boolean {
    return this.index.has(hashHex);
  }

  /** Walks the best chain backward from the tip to build a block-context for validating a would-be next block. */
  contextForNextBlock(now?: number): BlockContext {
    const tip = this.tip;
    return {
      height: tip.height + 1,
      expectedPrevHash: tip.hash,
      prevTimestamps: this.timestampsEndingAt(tip),
      now,
    };
  }

  /** The difficultyTarget (compact bits) the next block must use. */
  nextDifficultyBits(): number {
    const tip = this.tip;
    return nextDifficultyBits(tip.height + 1, tip.block.header.difficultyTarget, (h) =>
      this.blockAtHeightOnBestChain(h)!.block.header.timestamp,
    );
  }

  /** O(height) walk back from the tip. Fine for now; the node layer may cache this once storage exists (Phase 6+). */
  private blockAtHeightOnBestChain(height: number): IndexedBlock | undefined {
    let cur: IndexedBlock | undefined = this.tip;
    while (cur && cur.height > height) {
      cur = this.index.get(hashToHex(cur.block.header.prevHash));
    }
    return cur && cur.height === height ? cur : undefined;
  }

  // -- Adding blocks -----------------------------------------------------

  /**
   * Accepts a new block from any source (own miner, a peer's INV/block
   * message). Runs full validation, updates the index, and — if this block
   * or something behind it now outweighs the current tip — reorganizes the
   * UTXO set onto the new best chain. Never trusts the caller: every block
   * is independently re-validated here regardless of who sent it (see the
   * build spec's "Decentralization model").
   */
  addBlock(block: Block): AddBlockResult {
    const hash = getBlockHash(block.header);
    const hashHex = hashToHex(hash);
    if (this.index.has(hashHex)) return { status: "duplicate", hash: hashHex };

    const prevHex = hashToHex(block.header.prevHash);
    const parent = this.index.get(prevHex);
    if (!parent) {
      const list = this.orphansByParent.get(prevHex) ?? [];
      list.push(block);
      this.orphansByParent.set(prevHex, list);
      return { status: "orphan", hash: hashHex, missingParent: prevHex };
    }

    return this.connectNewBlock(block, hash, hashHex, parent);
  }

  private connectNewBlock(
    block: Block,
    hash: Hash,
    hashHex: string,
    parent: IndexedBlock,
  ): AddBlockResult {
    // Validated against a scratch clone of the UTXO set as it stood right
    // after `parent` — NOT the live tip's UtxoSet, since parent might be on
    // a side branch. This scratch validation decides whether the block is
    // even admissible to the index; the LIVE UtxoSet is only ever touched
    // in maybeReorgTo below, and only for blocks that end up on the best
    // chain. A side branch is therefore never applied to the live set on
    // the strength of this check alone.
    const context: BlockContext = {
      height: parent.height + 1,
      expectedPrevHash: parent.hash,
      prevTimestamps: this.timestampsEndingAt(parent),
    };

    const scratchUtxo = this.utxoSetAtBlock(parent);
    const result = validateBlock(block, scratchUtxo, context);
    if (!result.valid) return { status: "rejected", hash: hashHex, reason: result.reason };

    const work = workForHeader(block.header);
    if (work === null) return { status: "rejected", hash: hashHex, reason: "invalid difficultyTarget" };

    const indexed: IndexedBlock = {
      block,
      hash,
      hashHex,
      height: parent.height + 1,
      cumulativeWork: parent.cumulativeWork + work,
      onBestChain: false,
    };
    this.index.set(hashHex, indexed);

    const outcome = this.maybeReorgTo(indexed);
    this.processOrphansOf(hashHex);
    return outcome;
  }

  /** After indexing a new block, promotes it to tip if it (or a descendant) now has more cumulative work. */
  private maybeReorgTo(candidate: IndexedBlock): AddBlockResult {
    const currentTip = this.tip;
    if (candidate.cumulativeWork <= currentTip.cumulativeWork) {
      return { status: "accepted-side-branch", hash: candidate.hashHex, height: candidate.height };
    }

    const fork = this.findForkPoint(currentTip, candidate);
    const disconnectPath = this.pathToFork(currentTip, fork); // tip -> fork+1, newest first
    const connectPath = this.pathToFork(candidate, fork).reverse(); // fork+1 -> candidate, oldest first

    // Disconnect from the current tip back to (not including) the fork point.
    for (const b of disconnectPath) {
      revertBlock(b.block, this.utxoSet, this.appliedUtxosCache.get(b.hashHex) ?? []);
      b.onBestChain = false;
    }
    // Connect from just after the fork point up to the candidate.
    for (const b of connectPath) {
      const removed = applyBlock(b.block, this.utxoSet, b.height);
      this.appliedUtxosCache.set(b.hashHex, removed);
      b.onBestChain = true;
    }

    this.tipHex = candidate.hashHex;

    if (disconnectPath.length === 0) {
      return { status: "accepted-extends-tip", hash: candidate.hashHex, height: candidate.height };
    }
    return {
      status: "accepted-reorg",
      hash: candidate.hashHex,
      height: candidate.height,
      disconnected: disconnectPath.map((b) => b.hashHex),
      connected: connectPath.map((b) => b.hashHex),
    };
  }

  private findForkPoint(a: IndexedBlock, b: IndexedBlock): IndexedBlock {
    let x = a;
    let y = b;
    while (x.height > y.height) x = this.index.get(hashToHex(x.block.header.prevHash))!;
    while (y.height > x.height) y = this.index.get(hashToHex(y.block.header.prevHash))!;
    while (x.hashHex !== y.hashHex) {
      x = this.index.get(hashToHex(x.block.header.prevHash))!;
      y = this.index.get(hashToHex(y.block.header.prevHash))!;
    }
    return x;
  }

  /** Blocks strictly between `fork` (exclusive) and `from` (inclusive), ordered from `from` back toward `fork`. */
  private pathToFork(from: IndexedBlock, fork: IndexedBlock): IndexedBlock[] {
    const path: IndexedBlock[] = [];
    let cur = from;
    while (cur.hashHex !== fork.hashHex) {
      path.push(cur);
      cur = this.index.get(hashToHex(cur.block.header.prevHash))!;
    }
    return path;
  }

  /**
   * Reconstructs what the UTXO set looked like right after `target` was
   * connected, by replaying from genesis. Only used off the hot path
   * (validating a side-branch candidate) — Phase 6 storage can optimize
   * this with snapshots per block if it becomes a bottleneck.
   */
  private utxoSetAtBlock(target: IndexedBlock): UtxoSet {
    const chainToTarget: IndexedBlock[] = [];
    let cur: IndexedBlock | undefined = target;
    while (cur) {
      chainToTarget.unshift(cur);
      cur = cur.height > 0 ? this.index.get(hashToHex(cur.block.header.prevHash)) : undefined;
    }
    const scratch = new UtxoSet();
    for (const b of chainToTarget) applyBlock(b.block, scratch, b.height);
    return scratch;
  }

  private timestampsEndingAt(tip: IndexedBlock): number[] {
    const prevTimestamps: number[] = [];
    let cur: IndexedBlock | undefined = tip;
    for (let i = 0; i < MEDIAN_TIME_PAST_WINDOW && cur; i++) {
      prevTimestamps.unshift(cur.block.header.timestamp);
      cur = cur.height > 0 ? this.index.get(hashToHex(cur.block.header.prevHash)) : undefined;
    }
    return prevTimestamps;
  }

  /** After a block is connected, retries any orphans that were waiting on it. */
  private processOrphansOf(parentHex: string): void {
    const waiting = this.orphansByParent.get(parentHex);
    if (!waiting || waiting.length === 0) return;
    this.orphansByParent.delete(parentHex);
    for (const orphan of waiting) {
      // Recursive: connecting this one may unlock further orphans of its own.
      this.addBlock(orphan);
    }
  }

  /** Number of orphan blocks currently held (waiting on an unknown parent). Useful for node diagnostics / DoS limits. */
  get orphanCount(): number {
    let n = 0;
    for (const list of this.orphansByParent.values()) n += list.length;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Genesis helper
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic genesis block: one coinbase paying the initial
 * reward to `genesisPayoutLockingScript`, at a given starting difficulty.
 * Every node and wallet on the same network must use identical arguments
 * here (including timestamp) or they'll compute different genesis hashes
 * and never agree on a chain at all — this is the literal first line of
 * "same rules, same inputs" the build spec's decentralization model relies
 * on. Mining still has to find a nonce that satisfies difficultyTarget.
 */
export function buildGenesisTemplate(options: {
  timestamp: number;
  difficultyTarget: number;
  genesisPayoutLockingScript: Uint8Array;
  rewardSmallestUnits: bigint;
  extraData?: Uint8Array;
}): Block {
  const coinbase = createCoinbaseTransaction(
    0,
    [{ value: options.rewardSmallestUnits, lockingScript: options.genesisPayoutLockingScript }],
    options.extraData,
  );
  return assembleBlock({
    prevHash: zeroHash(),
    timestamp: options.timestamp,
    difficultyTarget: options.difficultyTarget,
    transactions: [coinbase],
  });
}

export { getBlockHashHex };