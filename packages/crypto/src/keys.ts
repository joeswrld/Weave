/**
 * Weave (WVE) keypair generation.
 *
 * Uses secp256k1 via @noble/curves rather than the browser's native
 * Web Crypto API, because Web Crypto's SubtleCrypto does not support the
 * secp256k1 curve (it supports P-256/P-384/P-521 for ECDSA, but not the
 * curve Bitcoin/Ethereum-style addresses are built on). Since the
 * consensus params lock in "secp256k1 keys, base58check addresses" (see
 * docs/consensus-params.md / build spec), every key in Weave uses this
 * curve — there is no separate P-256 code path, to avoid two incompatible
 * address formats existing in the same network.
 *
 * @noble/curves is audited, has no native bindings, and runs identically
 * in Node and the browser — the same reasoning as hash.ts in
 * packages/core for why platform-specific crypto APIs are avoided here.
 *
 * Private keys are handled as raw bytes (Uint8Array) in this module. This
 * module does NOT decide how a key is stored (in memory, in IndexedDB,
 * as a non-extractable CryptoKey wrapper, etc.) — that's the wallet's
 * keystore.ts. Keeping key *generation* and key *storage* separate means
 * core signing logic doesn't need to know anything about IndexedDB or the
 * DOM, and can be unit tested in plain Node.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface KeyPair {
  /** 32-byte secp256k1 private key. */
  privateKey: Uint8Array;
  /** 33-byte SEC1-compressed secp256k1 public key. */
  publicKey: Uint8Array;
}

/**
 * Generates a new random secp256k1 keypair using the platform's CSPRNG
 * (Web Crypto's getRandomValues under the hood, via @noble/curves — same
 * underlying entropy source in Node and the browser).
 */
export function generateKeyPair(): KeyPair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, /* isCompressed */ true);
  return { privateKey, publicKey };
}

/**
 * Derives the compressed public key from an existing private key. Useful
 * when a private key has been imported (e.g. from a backup) and the
 * public key needs to be re-derived rather than generated fresh.
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, /* isCompressed */ true);
}

/** Validates that bytes represent a valid secp256k1 private key. */
export function isValidPrivateKey(privateKey: Uint8Array): boolean {
  return secp256k1.utils.isValidPrivateKey(privateKey);
}

// --- hex convenience wrappers --------------------------------------------
//
// Keys are generated/consumed as raw bytes above (the form signing and
// address derivation actually want), but callers at the edges — CLI
// tools, JSON wire messages, wallet import/export UI — usually want hex
// strings. These wrappers exist so every part of the codebase encodes
// keys as hex the same way, rather than each caller rolling its own
// bytesToHex/hexToBytes calls.

export function privateKeyToHex(privateKey: Uint8Array): string {
  return bytesToHex(privateKey);
}

export function privateKeyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}

export function publicKeyToHex(publicKey: Uint8Array): string {
  return bytesToHex(publicKey);
}

export function publicKeyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}