/**
 * Weave (WVE) transaction signing and signature verification.
 *
 * Per the build spec (Phase 2): signing happens client-side in the browser
 * wallet; the node/server never sees a private key, only the resulting
 * signed transaction.
 *
 * The message that gets signed is `@weave/core`'s `getSigningHash(tx,
 * inputIndex, prevLockingScript)` — a domain-tagged sha256d over the whole
 * transaction with every unlocking script blanked except the signed
 * input's slot (Bitcoin's SIGHASH_ALL scheme; see transaction.ts for the
 * full rationale). That function already returns the 32-byte digest to
 * sign, so this module signs it directly rather than hashing it again.
 *
 * ECDSA over secp256k1, via @noble/curves, since Web Crypto's SubtleCrypto
 * doesn't support this curve (same reason keys.ts uses it). Signatures are
 * always produced in low-S form: transaction.ts's docs call out that a
 * signature isn't covered by what it signs, so a third party flipping a
 * high-S signature to its equally-valid low-S/high-S counterpart would
 * change the txid without invalidating anything — enforcing canonical
 * low-S signatures on both sign and verify closes that malleability hole.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  createUnlockingScript,
  getSigningHash,
  parseUnlockingScript,
  unlockingScriptMatchesLockingScript,
  type Transaction,
} from "@weave/core";

// ---------------------------------------------------------------------------
// Raw signing over a transaction's signing hash
// ---------------------------------------------------------------------------

/**
 * Signs the digest that input `inputIndex` of `tx` must sign (given the
 * locking script of the output it spends), with `privateKey`. Returns a
 * DER-encoded signature as a hex string.
 *
 * This is the low-level primitive; `signP2PKHInput` below is what a P2PKH
 * wallet actually calls, since it also assembles the ready-to-embed
 * unlocking script.
 */
export function signTransactionInput(
  tx: Transaction,
  inputIndex: number,
  prevLockingScript: Uint8Array,
  privateKey: Uint8Array,
): string {
  const messageHash = getSigningHash(tx, inputIndex, prevLockingScript);
  const signature = secp256k1.sign(messageHash, privateKey, { lowS: true });
  return signature.toDERHex();
}

/**
 * Verifies that `signatureHex` (DER-encoded, hex) is a valid, canonical
 * low-S signature over input `inputIndex` of `tx`, made by the holder of
 * the private key corresponding to `publicKey`.
 */
export function verifyTransactionInputSignature(
  tx: Transaction,
  inputIndex: number,
  prevLockingScript: Uint8Array,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  const messageHash = getSigningHash(tx, inputIndex, prevLockingScript);
  try {
    return secp256k1.verify(hexToBytes(signatureHex), messageHash, publicKey, {
      lowS: true,
    });
  } catch {
    // Malformed signature/public key bytes should be treated as "does not
    // verify", not as a thrown error the caller has to remember to catch.
    return false;
  }
}

// ---------------------------------------------------------------------------
// P2PKH convenience: sign/verify a whole unlocking script
// ---------------------------------------------------------------------------

/**
 * Signs input `inputIndex` of `tx` and returns a complete, ready-to-embed
 * P2PKH unlocking script (signature + public key, wire-encoded per
 * `@weave/core`'s script.ts) — what a wallet actually puts in
 * `TxInput.unlockingScript` before broadcasting.
 */
export function signP2PKHInput(
  tx: Transaction,
  inputIndex: number,
  prevLockingScript: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const signatureHex = signTransactionInput(tx, inputIndex, prevLockingScript, privateKey);
  return createUnlockingScript(hexToBytes(signatureHex), publicKey);
}

/**
 * Full verification of a P2PKH spend attempt: checks the unlocking
 * script's public key actually hashes to the locking script's pubKeyHash
 * (the crypto-free structural check in `@weave/core`'s script.ts), then
 * verifies the ECDSA signature over the transaction's signing hash. This
 * is what every node runs independently during transaction validation
 * (Phase 3's utxo.ts) — never trusting a peer's claim that an input is
 * validly signed.
 */
export function verifyP2PKHUnlockingScript(
  tx: Transaction,
  inputIndex: number,
  prevLockingScript: Uint8Array,
  unlockingScript: Uint8Array,
): boolean {
  if (!unlockingScriptMatchesLockingScript(prevLockingScript, unlockingScript)) {
    return false;
  }
  const unlocking = parseUnlockingScript(unlockingScript);
  if (!unlocking) return false; // unreachable given the match check above, kept for type-safety
  return verifyTransactionInputSignature(
    tx,
    inputIndex,
    prevLockingScript,
    bytesToHex(unlocking.signature),
    unlocking.publicKey,
  );
}

// ---------------------------------------------------------------------------
// Generic byte signing (not transaction-specific)
// ---------------------------------------------------------------------------

/** Convenience: sign arbitrary bytes directly (not a Transaction). */
export function signBytes(data: Uint8Array, privateKey: Uint8Array): string {
  const messageHash = sha256(data);
  const signature = secp256k1.sign(messageHash, privateKey, { lowS: true });
  return signature.toDERHex();
}

/** Convenience: verify a signature over arbitrary bytes (not a Transaction). */
export function verifyBytesSignature(
  data: Uint8Array,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  const messageHash = sha256(data);
  try {
    return secp256k1.verify(hexToBytes(signatureHex), messageHash, publicKey, {
      lowS: true,
    });
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes };