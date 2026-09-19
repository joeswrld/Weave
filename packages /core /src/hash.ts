/**
 * Hashing helpers for Weave.
 *
 * Weave hashes everything (txids, block hashes, merkle nodes) with
 * double-SHA256 — plain SHA-256 applied twice, same construction as Bitcoin.
 * Built on @noble/hashes so it behaves identically in Node and browsers.
 *
 * BYTE ORDER: a Hash is the raw 32-byte digest, and its hex form is those
 * bytes in natural order (NO Bitcoin-style reversal for display). For the
 * proof-of-work check, the digest is read as a big-endian 256-bit integer
 * (see target.ts). Pick one convention and use it everywhere — this is it.
 */

import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export const HASH_LENGTH = 32;

/** A 32-byte digest. Treat as immutable. */
export type Hash = Uint8Array;

/** Fresh all-zero hash (genesis prevHash, coinbase null outpoint). */
export function zeroHash(): Hash {
  return new Uint8Array(HASH_LENGTH);
}

export function sha256d(data: Uint8Array): Hash {
  return sha256(sha256(data));
}

export function hashToHex(hash: Hash): string {
  return bytesToHex(hash);
}

/** Parses a 64-char hex string into a Hash. Throws on anything malformed. */
export function hexToHash(hex: string): Hash {
  if (hex.length !== HASH_LENGTH * 2) {
    throw new Error(`hash hex must be ${HASH_LENGTH * 2} chars, got ${hex.length}`);
  }
  return hexToBytes(hex); // throws on non-hex characters
}

export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isZeroHash(hash: Uint8Array): boolean {
  return hash.length === HASH_LENGTH && hash.every((b) => b === 0);
}

/**
 * HASH160, Bitcoin's standard two-step public-key hash: RIPEMD160(SHA256(data)).
 * Lives in core (rather than @weave/crypto) because both `script.ts` here
 * (matching a P2PKH locking script's pubKeyHash) and @weave/crypto's
 * address.ts (deriving an address from a pubkey) need to compute exactly
 * the same 20-byte value — defining it once here is what keeps them from
 * silently drifting apart. @weave/crypto re-exports this rather than
 * reimplementing it.
 */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}