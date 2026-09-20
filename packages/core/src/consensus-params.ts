/**
 * Weave (WVE) consensus parameters.
 *
 * These values are consensus-critical: every node and every wallet doing
 * validation MUST agree on them exactly, or the network will fork. Treat
 * changes to this file as a hard fork.
 */

/** Target time between blocks, in seconds. */
export const TARGET_BLOCK_TIME_SECONDS = 120; // 2 minutes

/**
 * Number of blocks between difficulty retargets.
 * At the target block time, this is roughly one retarget per ~1.75 days.
 * (Bitcoin retargets every 2016 blocks / ~2 weeks; Weave's much faster
 * block time means it needs to retarget far more often to track hashrate
 * changes from browser miners joining/leaving.)
 */
export const DIFFICULTY_RETARGET_INTERVAL_BLOCKS = 1_260;

/**
 * Number of blocks per halving epoch.
 * Chosen as ~2 years' worth of blocks at the target block time
 * (365.25 * 24 * 60 * 60 / TARGET_BLOCK_TIME_SECONDS * 2 ≈ 525,948,
 * rounded to a clean 525,600 for readability).
 */
export const HALVING_INTERVAL_BLOCKS = 525_600;

/**
 * Block reward for the first halving epoch, in whole WVE.
 * Chosen (rather than derived) — see max-supply note below for why this
 * isn't a round number itself.
 */
export const INITIAL_BLOCK_REWARD_WVE = 95;

/**
 * Smallest indivisible unit of WVE, analogous to Bitcoin's satoshi.
 * 1 WVE = 10^DECIMALS smallest units. All amounts in Transaction outputs
 * should be represented as integers in this smallest unit — never as
 * floating-point WVE — to avoid rounding/precision bugs.
 */
export const DECIMALS = 8;
export const SMALLEST_UNITS_PER_WVE = 10 ** DECIMALS;

/**
 * Approximate maximum total supply, in whole WVE.
 *
 * This is a *consequence* of INITIAL_BLOCK_REWARD_WVE and
 * HALVING_INTERVAL_BLOCKS (reward halves every HALVING_INTERVAL_BLOCKS
 * blocks, forever) — not a number picked first and worked backwards from.
 * Bitcoin's 21,000,000 cap arose the same way, from a round 50 BTC reward.
 *
 * Sum of the infinite halving series converges to:
 *   INITIAL_BLOCK_REWARD_WVE * HALVING_INTERVAL_BLOCKS * 2
 *   = 95 * 525,600 * 2
 *   = 99,864,000 WVE
 *
 * In practice, integer-unit rounding during each halving epoch (reward
 * truncates rather than carrying fractional smallest-units forward) means
 * the real terminal supply will land slightly below this figure. Treat
 * this constant as documentation, not as an enforced cap — the actual cap
 * is *emergent* from getBlockReward() below, applied consistently forever.
 */
export const APPROX_MAX_SUPPLY_WVE = 99_864_000;

/**
 * Returns the block reward (in whole WVE) for a given block height,
 * applying the halving schedule. Every node MUST compute this identically.
 */
export function getBlockReward(blockHeight: number): number {
  const halvings = Math.floor(blockHeight / HALVING_INTERVAL_BLOCKS);

  // After ~64 halvings the reward underflows past what DECIMALS can
  // represent as a positive smallest-unit integer — treat it as zero from
  // that point on, same as Bitcoin does past its own final halving.
  if (halvings >= 64) return 0;

  return INITIAL_BLOCK_REWARD_WVE / 2 ** halvings;
}

/**
 * Returns the block reward in smallest units (integer), which is what
 * should actually be placed in a coinbase transaction output. Truncates
 * (floors) rather than rounds, matching Bitcoin's own subsidy behavior.
 */
export function getBlockRewardSmallestUnits(blockHeight: number): number {
  return Math.floor(getBlockReward(blockHeight) * SMALLEST_UNITS_PER_WVE);
}
