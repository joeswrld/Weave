/**
 * Work accounting shared by every ConsensusAlgorithm: how much work one
 * block at a given difficulty contributes, and how a set of chain tips is
 * ordered by cumulative work (chain.ts's fork-choice rule, restated here as
 * a pure function so it can be unit-tested and reused without touching
 * ChainState itself).
 */

import { blockWork } from "../chain";
import { compactToTarget } from "../target";

/**
 * work(difficultyTarget) = 2^256 / (target + 1). Reuses chain.ts's
 * blockWork (the one export changed there for this task) rather than
 * redefining it, so there is exactly one place this formula lives. Returns
 * null for a malformed difficultyTarget, mirroring compactToTarget's own
 * null-on-invalid convention — callers should treat that as "block/header
 * invalid", never throw.
 */
export function calculateWork(difficultyTarget: number): bigint | null {
  const target = compactToTarget(difficultyTarget);
  if (target === null) return null;
  return blockWork(target);
}

export interface ChainTip {
  id: string;
  cumulativeWork: bigint;
}

/**
 * Pure restatement of chain.ts's ChainState.maybeReorgTo fork-choice rule:
 * the tip with strictly greater cumulative work wins; a tie keeps the
 * current tip (no flip-flopping on equal work). Given no candidates,
 * returns null.
 */
export function selectBestTip<T extends ChainTip>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.cumulativeWork > best.cumulativeWork) best = candidate;
  }
  return best;
}