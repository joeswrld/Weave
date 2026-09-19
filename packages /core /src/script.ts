/**
 * Weave locking/unlocking script model (Phase 2).
 *
 * Real Bitcoin has a full stack-based Script language. The build spec is
 * explicit that Weave should skip that initially and ship a fixed
 * P2PKH-equivalent instead: a `TxOutput.lockingScript` commits to a
 * public-key hash, and the `TxInput.unlockingScript` that spends it
 * supplies a signature plus the public key that hashes to it.
 *
 * This module owns the wire encoding of both scripts and the *structural*
 * checks a node can run without touching ECDSA at all (right script type,
 * right lengths, unlocking pubkey actually hashes to the locking script's
 * pubKeyHash). Actual signature verification needs secp256k1, which lives
 * in `@weave/crypto` — core deliberately has no curve dependency, so the
 * final "is this signature valid" check is `@weave/crypto`'s
 * `verifyP2PKHUnlockingScript` (sign.ts), built on top of the parsing
 * helpers here plus `getSigningHash` in transaction.ts.
 *
 * Encoding (not a real bytecode language — just two fixed-shape records):
 *
 *   locking script:
 *     scriptType   u8      (SCRIPT_TYPE_P2PKH)
 *     pubKeyHash   20 bytes
 *
 *   unlocking script:
 *     scriptType   u8      (SCRIPT_TYPE_P2PKH)
 *     signature    varint length + bytes   (DER-encoded ECDSA)
 *     publicKey    varint length + bytes   (33-byte compressed secp256k1)
 */

import { ByteReader, ByteWriter, DecodeError } from "./bytes";
import { hash160 } from "./hash";

/** The only script type Phase 2 supports. Left as a tag byte so a real
 * Script language (or additional fixed types) can be added later without
 * an incompatible wire format change. */
export const SCRIPT_TYPE_P2PKH = 0x01;

export const PUBKEY_HASH_LENGTH = 20;
/** A compressed secp256k1 public key is always exactly 33 bytes. */
export const COMPRESSED_PUBKEY_LENGTH = 33;
/** DER-encoded secp256k1 ECDSA signatures are at most 72 bytes (30 + two
 * up-to-33-byte INTEGER fields with sign-padding); reject anything longer
 * outright rather than let an oversized value into a block. */
export const MAX_SIGNATURE_LENGTH = 72;
/** Smallest a well-formed DER signature can be. */
export const MIN_SIGNATURE_LENGTH = 8;

export interface P2PKHLockingScript {
  type: "p2pkh";
  /** HASH160(compressed pubkey) — 20 bytes. */
  pubKeyHash: Uint8Array;
}

export interface P2PKHUnlockingScript {
  /** DER-encoded ECDSA signature. */
  signature: Uint8Array;
  /** 33-byte compressed secp256k1 public key. */
  publicKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Locking script
// ---------------------------------------------------------------------------

/** Builds a P2PKH locking script for `pubKeyHash` (as produced by
 * `hash160(compressedPublicKey)`). This is what a `TxOutput.lockingScript`
 * holds — "pay to whoever can prove they hold the private key for this
 * pubkey hash". */
export function createLockingScript(pubKeyHash: Uint8Array): Uint8Array {
  if (pubKeyHash.length !== PUBKEY_HASH_LENGTH) {
    throw new RangeError(
      `pubKeyHash must be ${PUBKEY_HASH_LENGTH} bytes, got ${pubKeyHash.length}`,
    );
  }
  return new ByteWriter().writeU8(SCRIPT_TYPE_P2PKH).writeBytes(pubKeyHash).toBytes();
}

/**
 * Parses `script` as a P2PKH locking script. Returns null (never throws)
 * for anything malformed or of an unrecognized type — callers doing
 * validation want a plain yes/no, matching the pattern
 * `address.ts:addressToPubKeyHash` already uses.
 */
export function parseLockingScript(script: Uint8Array): P2PKHLockingScript | null {
  try {
    const r = new ByteReader(script);
    const scriptType = r.readU8();
    if (scriptType !== SCRIPT_TYPE_P2PKH) return null;
    const pubKeyHash = r.readBytes(PUBKEY_HASH_LENGTH);
    r.assertEnd();
    return { type: "p2pkh", pubKeyHash };
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
}

export function isP2PKHLockingScript(script: Uint8Array): boolean {
  return parseLockingScript(script) !== null;
}

// ---------------------------------------------------------------------------
// Unlocking script
// ---------------------------------------------------------------------------

/** Builds a P2PKH unlocking script from a signature and the public key it
 * was made with. This is what goes in `TxInput.unlockingScript` once
 * `@weave/crypto`'s `signP2PKHInput` has produced the signature. */
export function createUnlockingScript(
  signature: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  if (signature.length < MIN_SIGNATURE_LENGTH || signature.length > MAX_SIGNATURE_LENGTH) {
    throw new RangeError(
      `signature must be ${MIN_SIGNATURE_LENGTH}-${MAX_SIGNATURE_LENGTH} bytes, got ${signature.length}`,
    );
  }
  if (publicKey.length !== COMPRESSED_PUBKEY_LENGTH) {
    throw new RangeError(
      `publicKey must be ${COMPRESSED_PUBKEY_LENGTH} bytes (compressed), got ${publicKey.length}`,
    );
  }
  return new ByteWriter()
    .writeU8(SCRIPT_TYPE_P2PKH)
    .writeVarBytes(signature)
    .writeVarBytes(publicKey)
    .toBytes();
}

/**
 * Parses `script` as a P2PKH unlocking script. Returns null (never
 * throws) for anything malformed, of an unrecognized type, or with a
 * signature/pubkey of the wrong length — same "plain yes/no" convention
 * as `parseLockingScript`.
 */
export function parseUnlockingScript(script: Uint8Array): P2PKHUnlockingScript | null {
  try {
    const r = new ByteReader(script);
    const scriptType = r.readU8();
    if (scriptType !== SCRIPT_TYPE_P2PKH) return null;
    const signature = r.readVarBytes();
    const publicKey = r.readVarBytes();
    r.assertEnd();
    if (signature.length < MIN_SIGNATURE_LENGTH || signature.length > MAX_SIGNATURE_LENGTH) {
      return null;
    }
    if (publicKey.length !== COMPRESSED_PUBKEY_LENGTH) return null;
    return { signature, publicKey };
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Structural matching (crypto-free — no ECDSA here)
// ---------------------------------------------------------------------------

/**
 * True if `unlockingScript`'s public key actually hashes to
 * `lockingScript`'s pubKeyHash. This is the check every node can run
 * before spending anything on signature verification: it's cheap, and a
 * mismatch here means the input can never be valid regardless of what the
 * signature says. It does NOT check that the signature itself is valid —
 * that's `@weave/crypto`'s `verifyP2PKHUnlockingScript`, since core has no
 * secp256k1 dependency to verify ECDSA with.
 */
export function unlockingScriptMatchesLockingScript(
  lockingScript: Uint8Array,
  unlockingScript: Uint8Array,
): boolean {
  const locking = parseLockingScript(lockingScript);
  const unlocking = parseUnlockingScript(unlockingScript);
  if (!locking || !unlocking) return false;
  const derivedHash = hash160(unlocking.publicKey);
  if (derivedHash.length !== locking.pubKeyHash.length) return false;
  for (let i = 0; i < derivedHash.length; i++) {
    if (derivedHash[i] !== locking.pubKeyHash[i]) return false;
  }
  return true;
}

/**
 * Cheap, crypto-free structural check for a spend attempt, mirroring the
 * `checkTransactionStructure` / `check*Structure` pattern used elsewhere
 * in `core`: returns null if the scripts are well-formed and the pubkey
 * hash matches, or a human-readable reason if not. Still does not verify
 * the ECDSA signature itself.
 */
export function checkScriptsStructure(
  lockingScript: Uint8Array,
  unlockingScript: Uint8Array,
): string | null {
  const locking = parseLockingScript(lockingScript);
  if (!locking) return "locking script is not a recognized P2PKH script";

  const unlocking = parseUnlockingScript(unlockingScript);
  if (!unlocking) return "unlocking script is not a well-formed P2PKH unlocking script";

  if (!unlockingScriptMatchesLockingScript(lockingScript, unlockingScript)) {
    return "unlocking script's public key does not match the locking script's pubKeyHash";
  }

  return null;
}