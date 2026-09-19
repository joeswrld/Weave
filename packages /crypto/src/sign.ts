/**
 * Weave (WVE) transaction signing and signature verification.
 *
 * Per the build spec (Phase 2): signing happens client-side in the browser
 * wallet, using the transaction's canonical "for signing" serialization
 * from @weave/core (which blanks out unlockingScript fields, since a
 * signature can't cover data that contains itself). The node/server never
 * sees a private key — only the resulting signed transaction.
 *
 * ECDSA over secp256k1, via @noble/curves, for the same reason keys.ts
 * uses it: Web Crypto doesn't support this curve.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { serializeTransactionForSigning, type Transaction } from "@weave/core";

/**
 * Signs a transaction's signing-serialization with the given private key.
 * Returns a DER-encoded signature as a hex string, suitable for embedding
 * directly in a TransactionInput's unlockingScript (see script.ts for how
 * unlockingScript is actually assembled for a full P2PKH-equivalent spend,
 * which also needs the public key alongside this signature).
 *
 * Hashes with plain SHA-256 (not sha256d) before signing — ECDSA always
 * signs a fixed-size digest rather than the message itself, and a single
 * SHA-256 digest is standard practice for this step (sha256d in Weave is
 * specifically for txid/block-hash identity, a different purpose).
 */
export function signTransaction(tx: Transaction, privateKey: Uint8Array): string {
  const messageHash = sha256(serializeTransactionForSigning(tx));
  const signature = secp256k1.sign(messageHash, privateKey);
  return signature.toDERHex();
}

/**
 * Verifies that `signatureHex` (DER-encoded, hex) is a valid signature
 * over `tx`'s signing-serialization, made by the holder of the private
 * key corresponding to `publicKey`.
 *
 * This is what every node runs independently during transaction
 * validation (see @weave/core's utxo.ts, once implemented) — never
 * trusting a peer's claim that a transaction is validly signed.
 */
export function verifyTransactionSignature(
  tx: Transaction,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  const messageHash = sha256(serializeTransactionForSigning(tx));
  try {
    return secp256k1.verify(hexToBytes(signatureHex), messageHash, publicKey);
  } catch {
    // Malformed signature/public key bytes should be treated as "does not
    // verify", not as a thrown error the caller has to remember to catch —
    // validation code elsewhere in the codebase expects a plain boolean.
    return false;
  }
}

/** Convenience: sign arbitrary bytes directly (not a Transaction). */
export function signBytes(data: Uint8Array, privateKey: Uint8Array): string {
  const messageHash = sha256(data);
  const signature = secp256k1.sign(messageHash, privateKey);
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
    return secp256k1.verify(hexToBytes(signatureHex), messageHash, publicKey);
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes };