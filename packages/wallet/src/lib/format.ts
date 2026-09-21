
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
