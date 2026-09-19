/**
 * Difficulty target encoding and proof-of-work comparison.
 *
 * The block header stores the target in Bitcoin's 32-bit "compact" (nBits)
 * form: 1 exponent byte + 3 mantissa bytes, target = mantissa * 256^(exp-3).
 * This keeps the header at 80 bytes. Retargeting logic itself lives in
 * difficulty.ts (later phase); this file only converts and compares.
 */

import { type Hash } from "./hash";

const MAX_TARGET = (1n << 256n) - 1n;

/**
 * Expands compact bits into a 256-bit target. Returns null for encodings
 * that are invalid: negative (sign bit set), zero, or overflowing 256 bits.
 * Consensus code should treat null as "header invalid", never as an exception.
 */
export function compactToTarget(bits: number): bigint | null {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffff_ffff) return null;

  const exponent = bits >>> 24;
  const mantissa = bits & 0x007f_ffff;
  const negative = (bits & 0x0080_0000) !== 0;
  if (negative) return null;

  let target: bigint;
  if (exponent <= 3) {
    target = BigInt(mantissa) >> BigInt(8 * (3 - exponent));
  } else {
    target = BigInt(mantissa) << BigInt(8 * (exponent - 3));
  }

  if (target === 0n || target > MAX_TARGET) return null;
  return target;
}

/** Inverse of compactToTarget (canonical form; may drop low-order precision). */
export function targetToCompact(target: bigint): number {
  if (target <= 0n || target > MAX_TARGET) {
    throw new RangeError("target out of range");
  }
  let size = Math.ceil(target.toString(16).length / 2); // byte length
  let compact: bigint;
  if (size <= 3) {
    compact = target << BigInt(8 * (3 - size));
  } else {
    compact = target >> BigInt(8 * (size - 3));
  }
  // The mantissa's top bit is a sign flag; shift out of it if set.
  if ((compact & 0x0080_0000n) !== 0n) {
    compact >>= 8n;
    size += 1;
  }
  return Number(compact) | (size << 24);
}

/** Reads a hash as a big-endian unsigned 256-bit integer. */
export function hashToBigInt(hash: Hash): bigint {
  let n = 0n;
  for (const byte of hash) n = (n << 8n) | BigInt(byte);
  return n;
}

/** Proof-of-work check: hash (big-endian integer) must be strictly below target. */
export function hashMeetsTarget(hash: Hash, target: bigint): boolean {
  return hashToBigInt(hash) < target;
}