/**
 * Weave block mining (Phase 4): candidate block assembly and the nonce
 * search loop.
 *
 * This is the server-side miner — the build spec's suggested starting
 * point ("Mining loop (server-side first, simplest) against a fixed
 * difficulty"). The browser miner (Phase 8: Web Workers + WebAssembly) is
 * a different process, but shares the same core idea implemented here:
 * assemble a candidate block once, then vary only the header's `nonce`
 * and re-hash — everything else about the block stays fixed while mining.
 */

import {
  activeConsensusAlgorithm,
  assembleBlock,
  compactToTarget,
  createCoinbaseTransaction,
  getBlockRewardSmallestUnits,
  type Block,
  type BlockHeader,
  type Hash,
} from "@weave/core";
import type { Mempool } from "./mempool";

/** Header nonce is a u32 (see block.ts's wire format) — this is the whole search space per (timestamp, coinbaseExtraData) combination. */
const MAX_NONCE = 0xffff_ffff;

// ---------------------------------------------------------------------------
// Candidate block assembly
// ---------------------------------------------------------------------------

export interface CandidateBlockOptions {
  height: number;
  prevHash: Hash;
  difficultyTarget: number;
  /** Where the coinbase reward (subsidy + collected fees) is paid. A
   *  candidate block from this function always has exactly one coinbase
   *  output — splitting a reward across several payees (e.g. a mining
   *  pool) is Phase 8. */
  payoutLockingScript: Uint8Array;
  mempool: Mempool;
  /** Injectable for deterministic tests; defaults to the real clock. */
  timestamp?: number;
  /** Cap on transaction bytes pulled from the mempool, leaving room for
   *  the 80-byte header and coinbase. */
  maxTransactionBytes?: number;
  /** Extra bytes embedded in the coinbase's unlocking script — e.g. a pool
   *  extranonce, or just a fresh value to vary once the nonce space is
   *  exhausted (see mineBlock's doc comment). */
  coinbaseExtraData?: Uint8Array;
}

export interface CandidateBlock {
  block: Block;
  /** Total fees this candidate collects, informational — the coinbase output already reflects it. */
  totalFees: bigint;
}

/**
 * Selects transactions from the mempool (highest fee-rate first), builds a
 * coinbase paying exactly subsidy + those fees, and assembles an unmined
 * candidate block (nonce = 0, header otherwise complete, merkle root
 * included). Mining (see mineBlock below) then only needs to vary the nonce.
 */
export function assembleCandidateBlock(options: CandidateBlockOptions): CandidateBlock {
  const {
    height,
    prevHash,
    difficultyTarget,
    payoutLockingScript,
    mempool,
    timestamp = Math.floor(Date.now() / 1000),
    maxTransactionBytes = 900_000,
    coinbaseExtraData,
  } = options;

  const selected = mempool.getPrioritizedWithFees(maxTransactionBytes);
  const totalFees = selected.reduce((sum, entry) => sum + entry.feeSmallestUnits, 0n);
  const reward = BigInt(getBlockRewardSmallestUnits(height)) + totalFees;

  const coinbase = createCoinbaseTransaction(
    height,
    [{ value: reward, lockingScript: payoutLockingScript }],
    coinbaseExtraData,
  );

  const block = assembleBlock({
    prevHash,
    timestamp,
    difficultyTarget,
    transactions: [coinbase, ...selected.map((entry) => entry.transaction)],
  });

  return { block, totalFees };
}

// ---------------------------------------------------------------------------
// Nonce search loop
// ---------------------------------------------------------------------------

export interface MineOptions {
  /** Cap on nonce attempts this call will try before giving up. Defaults
   *  to the full u32 space, which at real network difficulty is far too
   *  slow to exhaust in one call — pass a smaller cap (e.g. a time-boxed
   *  chunk) if the caller needs to interleave mining with other work. */
  maxAttempts?: number;
  /** Called every `progressIntervalHashes` attempts, so a long-running
   *  search can report hashrate without the caller polling. */
  onProgress?: (hashesTried: number) => void;
  progressIntervalHashes?: number;
}

export interface MineResult {
  block: Block;
  hashesTried: number;
}

/**
 * The actual mining loop: hold everything in the header fixed except
 * `nonce`, re-hash under the network's activeConsensusAlgorithm (WPoW-V1 —
 * see @weave/core's consensus/active.ts), and check whether the result is
 * below the target — exactly what Phase 8's browser Web Worker will also
 * do, just in Node instead of a Worker thread. This delegates to
 * activeConsensusAlgorithm.mine rather than reimplementing the nonce
 * search, so there is exactly one mining loop implementation, shared with
 * WPoWV1Algorithm.mine's own unit tests/benchmark. Returns null if
 * `maxAttempts` (or the full nonce space) is exhausted without success,
 * which is completely normal at real difficulty: the caller should
 * re-assemble the candidate with a new timestamp and/or a new
 * `coinbaseExtraData` (an "extranonce" — see transaction.ts's
 * COINBASE_SCRIPT_MAX_BYTES comment) and call again, the same way a real
 * miner cycles through those once the 32-bit nonce space runs out.
 */
export function mineBlock(candidate: Block, options: MineOptions = {}): MineResult | null {
  const target = compactToTarget(candidate.header.difficultyTarget);
  if (target === null) throw new RangeError("invalid difficultyTarget");

  const maxAttempts = Math.min(options.maxAttempts ?? MAX_NONCE + 1, MAX_NONCE + 1);
  const result = activeConsensusAlgorithm.mine(candidate.header, {
    maxAttempts,
    onProgress: options.onProgress,
    progressIntervalHashes: options.progressIntervalHashes ?? 100_000,
  });
  if (result === null) return null;
  return { block: { header: result.header, transactions: candidate.transactions }, hashesTried: result.hashesTried };
}

/** Convenience: assemble + mine in one call. Returns null on the same terms as mineBlock. */
export function mineNextBlock(
  candidateOptions: CandidateBlockOptions,
  mineOptions?: MineOptions,
): (MineResult & { totalFees: bigint }) | null {
  const { block, totalFees } = assembleCandidateBlock(candidateOptions);
  const result = mineBlock(block, mineOptions);
  return result ? { ...result, totalFees } : null;
}