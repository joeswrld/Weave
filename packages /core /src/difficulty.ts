/**
 * Weave difficulty retargeting (Phase 4).
 *
 * Same idea as Bitcoin's retarget, adapted to Weave's much faster interval:
 * every DIFFICULTY_RETARGET_INTERVAL_BLOCKS blocks (~1.75 days at target
 * block time, vs Bitcoin's ~2 weeks), compare how long that interval
 * actually took against how long it was supposed to take, and scale the
 * target by that ratio. Blocks came in slow -> target widens (easier).
 * Blocks came in fast -> target narrows (harder).
 *
 * Weave needs the much shorter interval specifically because browser
 * hashrate can swing far faster than Bitcoin's ASIC fleet — a wave of tabs
 * joining or leaving shows up in hours, not months — so the network has to
 * be able to react within days, not weeks, or blocks would come in far too
 * fast (spam, orphan-rate blowup) or far too slow (network stalls) for a
 * long stretch in between.
 */

import { DIFFICULTY_RETARGET_INTERVAL_BLOCKS, TARGET_BLOCK_TIME_SECONDS } from "./consensus-params";
import { compactToTarget, targetToCompact } from "./target";

const MAX_TARGET = (1n << 256n) - 1n;

/** How long one full retarget interval is supposed to take, in seconds. */
export const EXPECTED_RETARGET_TIMESPAN_SECONDS =
  DIFFICULTY_RETARGET_INTERVAL_BLOCKS * TARGET_BLOCK_TIME_SECONDS;

/**
 * Bitcoin's own clamp, reused here: never adjust difficulty by more than 4x
 * in either direction in a single retarget, no matter how far off actual
 * block times were. This matters more for Weave than for Bitcoin — a burst
 * of browser miners arriving or leaving right before a retarget boundary
 * could otherwise swing the next target to an absurd extreme off one
 * unrepresentative interval.
 */
export const MAX_RETARGET_FACTOR = 4;

export interface RetargetInput {
  /** difficultyTarget (compact bits) the interval that just ended was mined at. */
  previousBits: number;
  /** Timestamp of the first block of the interval that just ended. */
  firstBlockTimestamp: number;
  /** Timestamp of the last block of the interval that just ended. */
  lastBlockTimestamp: number;
}

/**
 * Computes the next difficultyTarget (compact bits) from how the interval
 * that just finished actually went. Every node must compute this
 * identically — it's consensus-critical, same as everything else here.
 */
export function calculateNextTarget(input: RetargetInput): number {
  const previousTarget = compactToTarget(input.previousBits);
  if (previousTarget === null) {
    throw new RangeError(`invalid previousBits: ${input.previousBits}`);
  }

  let actualTimespan = input.lastBlockTimestamp - input.firstBlockTimestamp;

  const minTimespan = EXPECTED_RETARGET_TIMESPAN_SECONDS / MAX_RETARGET_FACTOR;
  const maxTimespan = EXPECTED_RETARGET_TIMESPAN_SECONDS * MAX_RETARGET_FACTOR;
  if (actualTimespan < minTimespan) actualTimespan = minTimespan;
  if (actualTimespan > maxTimespan) actualTimespan = maxTimespan;

  // newTarget = previousTarget * (actual / expected). A longer-than-expected
  // actual timespan means blocks arrived slower than intended, so the
  // target widens (gets numerically larger, i.e. easier to meet).
  let newTarget =
    (previousTarget * BigInt(Math.round(actualTimespan))) / BigInt(EXPECTED_RETARGET_TIMESPAN_SECONDS);

  if (newTarget > MAX_TARGET) newTarget = MAX_TARGET;
  if (newTarget < 1n) newTarget = 1n;

  return targetToCompact(newTarget);
}

/**
 * True at every height where a retarget happens — the first block of a new
 * interval, mirroring Bitcoin's `height % interval === 0` rule. Height 0
 * (genesis) technically satisfies this arithmetically but always defines
 * its own bits directly rather than being "retargeted".
 */
export function isRetargetHeight(height: number): boolean {
  return height % DIFFICULTY_RETARGET_INTERVAL_BLOCKS === 0;
}

/**
 * Given the chain so far, returns the difficultyTarget (compact bits) the
 * block at `nextHeight` must use. At a non-retarget height this is just
 * the previous block's bits, unchanged; at a retarget height it's
 * `calculateNextTarget` applied to the interval that just completed.
 *
 * `getTimestampAtHeight` is injected — supplied from a ChainState
 * (chain.ts) by the caller — rather than this module reaching into chain
 * state itself, keeping difficulty.ts dependency-free and trivially
 * unit-testable with synthetic timestamps.
 */
export function nextDifficultyBits(
  nextHeight: number,
  previousBits: number,
  getTimestampAtHeight: (height: number) => number,
): number {
  if (nextHeight <= 0 || !isRetargetHeight(nextHeight)) return previousBits;

  const intervalStartHeight = nextHeight - DIFFICULTY_RETARGET_INTERVAL_BLOCKS;
  return calculateNextTarget({
    previousBits,
    firstBlockTimestamp: getTimestampAtHeight(intervalStartHeight),
    lastBlockTimestamp: getTimestampAtHeight(nextHeight - 1),
  });
}