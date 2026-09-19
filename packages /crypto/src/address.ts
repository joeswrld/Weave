/**
 * Weave (WVE) address derivation.
 *
 * Reuses Bitcoin's own scheme end-to-end, per the locked consensus params
 * ("secp256k1 keys ... base58check-encoded addresses — reusing Bitcoin's
 * proven scheme rather than inventing a new one"):
 *
 *   address = base58check( versionByte || RIPEMD160(SHA256(compressedPubKey)) )
 *
 * base58check itself is: base58( payload || checksum ), where checksum is
 * the first 4 bytes of SHA256(SHA256(versionByte || payload)). This is
 * exactly Bitcoin's P2PKH address format, just with Weave's own version
 * byte so Weave addresses are visually distinguishable from BTC addresses
 * and can't be paid to by accident.
 */

import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58 } from "@scure/base";

/**
 * Weave's address version byte. Chosen arbitrarily distinct from Bitcoin
 * mainnet's 0x00 (P2PKH) and testnet's 0x6f, so a Weave address never
 * collides in appearance with a real BTC address. Consensus-relevant only
 * in the sense that every wallet/node must use the same byte, or they'll
 * disagree about what a valid Weave address looks like.
 */
export const ADDRESS_VERSION_BYTE = 0x2d; // arbitrary, Weave-specific

/**
 * HASH160, Bitcoin's standard two-step public-key hash:
 * RIPEMD160(SHA256(data)). Used here for pubkey → pubkeyHash, but kept as
 * a general helper since script.ts (P2PKH-equivalent locking script) also
 * needs to compute/compare this same hash.
 */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Derives a base58check Weave address from a compressed secp256k1 public
 * key. This is the address a wallet shows the user and that others send
 * WVE to — never derived from a private key directly, only ever from the
 * public key, so sharing an address never risks exposing anything secret.
 */
export function publicKeyToAddress(publicKey: Uint8Array): string {
  const pubKeyHash = hash160(publicKey);
  const versioned = new Uint8Array(1 + pubKeyHash.length);
  versioned[0] = ADDRESS_VERSION_BYTE;
  versioned.set(pubKeyHash, 1);

  const checksum = sha256(sha256(versioned)).slice(0, 4);

  const payload = new Uint8Array(versioned.length + checksum.length);
  payload.set(versioned, 0);
  payload.set(checksum, versioned.length);

  return base58.encode(payload);
}

/**
 * Decodes a base58check Weave address back into its raw pubkey hash,
 * verifying the checksum and version byte along the way. Returns null for
 * anything that doesn't decode as a well-formed Weave address (wrong
 * checksum, wrong version byte, wrong length, invalid base58) rather than
 * throwing — callers doing address validation (e.g. the wallet's send
 * form) want a plain yes/no, not a try/catch.
 */
export function addressToPubKeyHash(address: string): Uint8Array | null {
  let payload: Uint8Array;
  try {
    payload = base58.decode(address);
  } catch {
    return null;
  }

  // 1 version byte + 20-byte RIPEMD160 output + 4-byte checksum.
  if (payload.length !== 1 + 20 + 4) {
    return null;
  }

  const versioned = payload.slice(0, 21);
  const checksum = payload.slice(21);
  const expectedChecksum = sha256(sha256(versioned)).slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) return null;
  }

  if (versioned[0] !== ADDRESS_VERSION_BYTE) {
    return null;
  }

  return versioned.slice(1);
}

/** Returns true if `address` is a well-formed, checksum-valid Weave address. */
export function isValidAddress(address: string): boolean {
  return addressToPubKeyHash(address) !== null;
}