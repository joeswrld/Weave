/**
 * WVE amount formatting. Every amount in this wallet is a bigint of
 * smallest units end-to-end (matching @weave/core's own bigint-only rule
 * for money — see transaction.ts's comment on why floats are unsafe above
 * ~9e15). These helpers are the only place smallest-units <-> display
 * conversion happens, so rounding/precision behavior stays consistent
 * across every component that shows an amount.
 */
import { SMALLEST_UNITS_PER_WVE, DECIMALS } from "@weave/core";

const UNIT = BigInt(SMALLEST_UNITS_PER_WVE);

/** Formats smallest units as a WVE decimal string, trimming trailing zeros
 * but always keeping at least "0" after the point removed entirely for
 * whole numbers (e.g. 5n*UNIT -> "5", not "5.00000000"). */
export function formatWve(smallestUnits: bigint): string {
  const negative = smallestUnits < 0n;
  const abs = negative ? -smallestUnits : smallestUnits;
  const whole = abs / UNIT;
  const frac = abs % UNIT;
  if (frac === 0n) return `${negative ? "-" : ""}${whole}`;
  const fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

/** Parses a user-typed WVE amount (decimal string) into smallest units.
 * Returns null for anything that isn't a valid non-negative decimal, or
 * that has more precision than WVE supports. */
export function parseWve(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > DECIMALS) return null;
  const paddedFrac = fracPart.padEnd(DECIMALS, "0");
  try {
    return BigInt(wholePart) * UNIT + BigInt(paddedFrac || "0");
  } catch {
    return null;
  }
}

export function shortenAddress(address: string, lead = 8, tail = 6): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function shortenTxid(txid: string): string {
  return shortenAddress(txid, 10, 8);
}

export function formatHashrate(hashesPerSecond: number): string {
  if (hashesPerSecond >= 1_000_000) return `${(hashesPerSecond / 1_000_000).toFixed(2)} MH/s`;
  if (hashesPerSecond >= 1_000) return `${(hashesPerSecond / 1_000).toFixed(2)} KH/s`;
  return `${hashesPerSecond.toFixed(0)} H/s`;
}

/**
 * Rough estimate of the network's total hashrate, derived from the current
 * PoW target: at a target T out of the full 2^256 hash space, the expected
 * number of hashes to find one block is 2^256 / T, and the network as a
 * whole does that (in expectation) once per TARGET_BLOCK_TIME_SECONDS —
 * the same back-of-envelope formula every PoW chain's "network hashrate"
 * figure comes from (Bitcoin's included). This is an *expectation*, not a
 * measurement: actual time to the next block is exponentially distributed
 * around it, so treat the result as an order-of-magnitude figure, not a
 * countdown timer.
 */
export function estimateNetworkHashrate(targetHex: string, targetBlockTimeSeconds: number): number {
  const target = BigInt("0x" + targetHex);
  if (target <= 0n) return 0;
  const maxTarget = (1n << 256n) - 1n;
  const expectedHashes = maxTarget / target;
  return Number(expectedHashes) / targetBlockTimeSeconds;
}

/**
 * Expected time (in seconds) for a miner doing `myHashesPerSecond` to find
 * one block on its own, given the current network difficulty implies
 * `networkHashesPerSecond` total (see estimateNetworkHashrate). Standard
 * PoW-lottery math: expected hashes to find a block is 2^256/target
 * (already folded into networkHashesPerSecond * targetBlockTimeSeconds),
 * so time for *this* miner alone to search that many hashes at its own
 * rate is (networkHashesPerSecond * targetBlockTimeSeconds) / myHashesPerSecond.
 * This is the mean of an exponential distribution — real outcomes vary
 * widely around it (a solo miner can go several multiples of this without
 * a hit, or get lucky well before it) — so treat it as an order-of-
 * magnitude figure, not a countdown. Returns Infinity if there's nothing
 * to estimate from yet (zero hashrate on either side).
 */
export function estimateSecondsToBlock(
  myHashesPerSecond: number,
  networkHashesPerSecond: number,
  targetBlockTimeSeconds: number,
): number {
  if (myHashesPerSecond <= 0 || networkHashesPerSecond <= 0) return Infinity;
  const expectedHashesToFindABlock = networkHashesPerSecond * targetBlockTimeSeconds;
  return expectedHashesToFindABlock / myHashesPerSecond;
}

/**
 * Human-readable ETA string for the mining panel — "~3 hours", "~2 days",
 * etc. — or a plain-language "effectively never at this rate" for
 * astronomically large estimates, since a literal "~4,000 years" number
 * reads as a bug rather than as the honest (if discouraging) answer it
 * actually is for solo browser mining at real network difficulty.
 */
export function formatEtaSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const YEAR = 365.25 * 24 * 3600;
  if (seconds > 1000 * YEAR) return "effectively never at this rate";
  const units: [string, number][] = [
    ["year", YEAR],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const n = Math.round(seconds / size);
      return `~${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return "< 1 second";
}