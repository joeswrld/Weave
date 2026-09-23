
/**
 * Pluggable proof-of-work layer (Phase "WPoW").
 *
 * Everything Weave's chain already does — block wire format, difficulty
 * retargeting math, cumulative-work fork choice, UTXO/tx validation — stays
 * exactly as it is (see block.ts, difficulty.ts, target.ts, chain.ts,
 * utxo.ts). This module only factors "how is a block's proof-of-work
 * computed and checked" behind one interface, so a second concrete PoW
 * (WPoW-V1, see wpow-v1.ts) can exist side by side with the original
 * SHA-256d PoW (sha256-pow.ts, a thin adapter around the existing
 * getBlockHash/hashMeetsTarget functions — not a reimplementation) without
 * touching any of that already-working code.
 *
 * A ConsensusAlgorithm never changes the 80-byte header layout. It only
 * changes the function applied to the header bytes to produce the digest
 * that gets compared against the compact-bits target, and (for algorithms
 * that need it) the raw work-per-difficulty formula. Mining still means
 * "hold the header fixed except `nonce` and search"; verification still
 * means "recompute independently, never trust a claimed hash".
 */

import type { BlockHeader } from "../block";

/**
 * A self-contained, independently-verifiable proof that a given header's
 * nonce satisfies its algorithm's proof-of-work condition at the header's
 * own difficultyTarget. `hash` is carried for convenience/logging only —
 * verifyProof() below always recomputes it from the header rather than
 * trusting this field, exactly like the existing checkProofOfWork does for
 * plain SHA-256d.
 */
export interface ConsensusProof {
  algorithm: string;
  nonce: number;
  hash: Uint8Array;
}

export interface MineOptions {
  /** Cap on nonce attempts before giving up; defaults to the full u32 space. */
  maxAttempts?: number;
  /** Called every `progressIntervalHashes` attempts. */
  onProgress?: (hashesTried: number) => void;
  progressIntervalHashes?: number;
}

export interface MineResult {
  header: BlockHeader;
  proof: ConsensusProof;
  hashesTried: number;
  elapsedMs: number;
}

/** Same shape difficulty.ts's RetargetInput already uses — re-declared here so this module has no import-cycle back into difficulty.ts. */
export interface RetargetInput {
  previousBits: number;
  firstBlockTimestamp: number;
  lastBlockTimestamp: number;
}

/**
 * One pluggable proof-of-work algorithm. `id` is the string that would be
 * persisted alongside a header/network config to say which algorithm a
 * given chain or block uses — this layer does not itself decide which
 * algorithm any particular chain runs; that wiring is a separate,
 * deliberately-deferred step (see the module doc comment above).
 */
export interface ConsensusAlgorithm {
  readonly id: string;

  /** Human-readable one-liner, no security claims — see each implementation's own header comment for honest caveats. */
  readonly description: string;

  /**
   * Computes this algorithm's proof-of-work digest for a header. Pure
   * function of the header's bytes (including `nonce`) — same input always
   * produces the same output, in Node or a browser/WASM environment.
   */
  computeProofHash(header: BlockHeader): Uint8Array;

  /** Recomputes the proof hash from `header` and checks it against the target implied by `difficultyTarget`. Never trusts a caller-supplied hash. */
  verifyProof(header: BlockHeader, difficultyTarget: number): boolean;

  /**
   * Nonce search: holds `header` fixed except `nonce`, incrementing from
   * `header.nonce` until verifyProof succeeds or `maxAttempts` (default:
   * the whole u32 space) is exhausted. Returns null on exhaustion — normal
   * at real difficulty; the caller re-assembles with a new timestamp
   * and/or extranonce and calls again, same pattern as the existing
   * node/src/miner.ts loop.
   */
  mine(header: BlockHeader, options?: MineOptions): MineResult | null;

  /**
   * Work a single block at this difficulty contributes to cumulative
   * chain-work (see chain.ts's fork-choice rule). Every algorithm here uses
   * the same target-based definition — see work.ts's blockWork — because
   * "work" measures the a-priori probability of finding a satisfying
   * nonce, which is a property of the target alone, independent of how
   * expensive any one hash attempt is to compute.
   */
  calculateWork(difficultyTarget: number): bigint;

  /**
   * Next block's difficultyTarget (compact bits), given how the interval
   * that just ended actually went. Delegates to the existing, already
   * algorithm-agnostic difficulty.ts retarget math (see that file's
   * calculateNextTarget) — the ratio-based retarget with a 4x clamp cares
   * only about "did blocks arrive faster or slower than the target block
   * time", never about what a single hash attempt costs, so it works
   * unchanged for an algorithm whose hash attempts are far more expensive
   * than plain SHA-256d's.
   */
  nextDifficultyBits(input: RetargetInput): number;
}