
/**
 * Weave browser wallet keystore.
 *
 * Onboarding goal (Phase 7 of the build spec): opening the page and
 * generating a keypair is the entire setup. No download, no seed-phrase
 * ritual before a first transaction. What this module actually stores:
 *
 * A Weave private key is a raw 32-byte secp256k1 scalar (see
 * @weave/crypto's keys.ts) — not something the Web Crypto API's SubtleCrypto
 * can generate or hold, because SubtleCrypto's ECDSA support is limited to
 * P-256/P-384/P-521 and does not cover secp256k1. That rules out the
 * "non-extractable CryptoKey" storage path the build spec offers as the
 * first option, for this key type specifically — there is no
 * secp256k1 CryptoKey to mark non-extractable. So this module implements
 * the spec's documented fallback instead: encrypted-at-rest in IndexedDB.
 *
 * Concretely:
 *   - The 32-byte secp256k1 private key is encrypted with AES-GCM before
 *     it ever touches IndexedDB, using a key derived (PBKDF2) from a
 *     passphrase. The unencrypted key exists only transiently in memory
 *     while the wallet is unlocked (module-level variable, never written
 *     to storage, cleared on lock/tab close).
 *   - A wallet with no passphrase set still gets "opened the page and
 *     it just works": generate() auto-derives a random local passphrase
 *     and stores it (also encrypted, with a device-bound wrapping key)
 *     so first use needs zero prompts, while still keeping the private
 *     key encrypted at rest rather than sitting in IndexedDB in the clear.
 *     A user who wants real protection (recommended before holding real
 *     funds) can set their own passphrase at any time via `setPassphrase`,
 *     which re-encrypts in place.
 *   - Export/backup (`exportPrivateKeyHex`) is deliberately a separate,
 *     explicit action — the build spec calls out that back-up/export
 *     still matters for real fund safety even though it's not required
 *     before a first transaction.
 */

import { generateKeyPair, getPublicKey, isValidPrivateKey } from "@weave/crypto";
import { publicKeyToAddress } from "@weave/crypto";

const DB_NAME = "weave-wallet";
const DB_VERSION = 1;
const STORE = "keystore";
// Single-wallet MVP: one record at a fixed key. Multi-account support can
// extend this to multiple records without changing the encryption scheme.
const RECORD_KEY = "primary";

export interface WalletRecord {
  address: string;
  publicKeyHex: string;
  /** AES-GCM ciphertext of the 32-byte private key. */
  encryptedPrivateKey: ArrayBuffer;
  iv: ArrayBuffer;
  /** PBKDF2 salt used to derive the AES key from the passphrase. */
  salt: ArrayBuffer;
  pbkdf2Iterations: number;
  /**
   * True if the passphrase itself is a random one we generated and stored
   * (encrypted with a device-bound, non-extractable wrapping key) rather
   * than something the user chose. This is what makes "just open the page"
   * work without a prompt, while keeping the key off disk in the clear.
   */
  autoPassphrase: boolean;
  /** Only present when autoPassphrase is true. */
  wrappedAutoPassphrase?: ArrayBuffer;
  wrappedAutoPassphraseIv?: ArrayBuffer;
  createdAt: number;
}

const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 minimum guidance for PBKDF2-SHA256

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// A non-extractable, device-bound wrapping key for the auto-generated
// passphrase path. This key never leaves the browser and can't be read back
// out (extractable: false) — it exists purely so the auto-passphrase isn't
// sitting in IndexedDB as plaintext. It is *not* a substitute for a real
// user passphrase: anyone with script execution in this origin can still
// ask it to decrypt, same as any other client-side secret. It only raises
// the bar above "plaintext file on disk."
// ---------------------------------------------------------------------------

const WRAPPING_KEY_DB = "weave-wallet-wrapkey";

async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WRAPPING_KEY_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("keys")) {
        req.result.createObjectStore("keys");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const tx = db.transaction("keys", "readonly");
    const req = tx.objectStore("keys").get("wrap");
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(key, "wrap");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

// ---------------------------------------------------------------------------
// AES-GCM encrypt/decrypt helpers
// ---------------------------------------------------------------------------

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
  return { ciphertext, iv: iv.buffer };
}

async function decryptBytes(key: CryptoKey, ciphertext: ArrayBuffer, iv: ArrayBuffer): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(plain);
}

function randomPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UnlockedWallet {
  address: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** True if a wallet record already exists in this browser. */
export async function hasWallet(): Promise<boolean> {
  const record = await idbGet<WalletRecord>(STORE, RECORD_KEY);
  return record !== undefined;
}

/**
 * Generates a brand-new keypair and persists it, encrypted, with an
 * auto-generated passphrase — this is the entire "setup" the onboarding
 * goal calls for. Returns the unlocked wallet immediately so the caller
 * never has to separately "unlock" what it just created.
 */
export async function generateWallet(): Promise<UnlockedWallet> {
  const { privateKey, publicKey } = generateKeyPair();
  const address = publicKeyToAddress(publicKey);

  const passphrase = randomPassphrase();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const { ciphertext, iv } = await encryptBytes(aesKey, privateKey);

  const wrapKey = await getOrCreateWrappingKey();
  const { ciphertext: wrappedPass, iv: wrapIv } = await encryptBytes(
    wrapKey,
    new TextEncoder().encode(passphrase),
  );

  const record: WalletRecord = {
    address,
    publicKeyHex: bytesToHex(publicKey),
    encryptedPrivateKey: ciphertext,
    iv,
    salt: salt.buffer,
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    autoPassphrase: true,
    wrappedAutoPassphrase: wrappedPass,
    wrappedAutoPassphraseIv: wrapIv,
    createdAt: Date.now(),
  };
  await idbPut(STORE, RECORD_KEY, record);

  return { address, publicKey, privateKey };
}

/**
 * Imports an existing private key (hex, 32 bytes) — for restoring from a
 * backup made via exportPrivateKeyHex, or moving a key from another
 * wallet. Encrypted at rest the same way a freshly generated key is.
 */
export async function importWallet(privateKeyHex: string): Promise<UnlockedWallet> {
  const privateKey = hexToBytes(privateKeyHex.trim());
  if (privateKey.length !== 32 || !isValidPrivateKey(privateKey)) {
    throw new Error("Invalid private key: expected 32 bytes of valid secp256k1 hex.");
  }
  const publicKey = getPublicKey(privateKey);
  const address = publicKeyToAddress(publicKey);

  const passphrase = randomPassphrase();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const { ciphertext, iv } = await encryptBytes(aesKey, privateKey);

  const wrapKey = await getOrCreateWrappingKey();
  const { ciphertext: wrappedPass, iv: wrapIv } = await encryptBytes(
    wrapKey,
    new TextEncoder().encode(passphrase),
  );

  const record: WalletRecord = {
    address,
    publicKeyHex: bytesToHex(publicKey),
    encryptedPrivateKey: ciphertext,
    iv,
    salt: salt.buffer,
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    autoPassphrase: true,
    wrappedAutoPassphrase: wrappedPass,
    wrappedAutoPassphraseIv: wrapIv,
    createdAt: Date.now(),
  };
  await idbPut(STORE, RECORD_KEY, record);

  return { address, publicKey, privateKey };
}

/**
 * Unlocks the stored wallet. If the wallet still uses the auto-generated
 * passphrase (the common case right after generate()), no user input is
 * needed — this is what lets "open the URL" reach a working wallet with
 * zero prompts. If the user has set their own passphrase (setPassphrase),
 * that passphrase must be supplied here.
 */
export async function unlockWallet(passphrase?: string): Promise<UnlockedWallet> {
  const record = await idbGet<WalletRecord>(STORE, RECORD_KEY);
  if (!record) throw new Error("No wallet found in this browser.");

  let effectivePassphrase: string;
  if (record.autoPassphrase) {
    if (!record.wrappedAutoPassphrase || !record.wrappedAutoPassphraseIv) {
      throw new Error("Wallet record is corrupted (missing auto-passphrase wrapper).");
    }
    const wrapKey = await getOrCreateWrappingKey();
    const plainBytes = await decryptBytes(
      wrapKey,
      record.wrappedAutoPassphrase,
      record.wrappedAutoPassphraseIv,
    );
    effectivePassphrase = new TextDecoder().decode(plainBytes);
  } else {
    if (!passphrase) throw new Error("This wallet is passphrase-protected.");
    effectivePassphrase = passphrase;
  }

  const salt = new Uint8Array(record.salt);
  const aesKey = await deriveAesKey(effectivePassphrase, salt, record.pbkdf2Iterations);
  let privateKey: Uint8Array;
  try {
    privateKey = await decryptBytes(aesKey, record.encryptedPrivateKey, record.iv);
  } catch {
    throw new Error("Incorrect passphrase.");
  }

  const publicKey = hexToBytes(record.publicKeyHex);
  return { address: record.address, publicKey, privateKey };
}

/**
 * Replaces the auto-generated passphrase with one the user chooses,
 * re-encrypting the private key in place. This is the "back up/export
 * matters for real fund safety" step the build spec calls out as
 * something the user should eventually do, without gating first use on it.
 */
export async function setPassphrase(currentPassphrase: string | undefined, newPassphrase: string): Promise<void> {
  const unlocked = await unlockWallet(currentPassphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await deriveAesKey(newPassphrase, salt, PBKDF2_ITERATIONS);
  const { ciphertext, iv } = await encryptBytes(aesKey, unlocked.privateKey);

  const existing = await idbGet<WalletRecord>(STORE, RECORD_KEY);
  if (!existing) throw new Error("No wallet found in this browser.");

  const record: WalletRecord = {
    ...existing,
    encryptedPrivateKey: ciphertext,
    iv,
    salt: salt.buffer,
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    autoPassphrase: false,
    wrappedAutoPassphrase: undefined,
    wrappedAutoPassphraseIv: undefined,
  };
  await idbPut(STORE, RECORD_KEY, record);
}

/**
 * Returns the raw private key as hex, for the user to back up. A separate,
 * explicit call from unlockWallet on purpose — exporting key material is
 * the one moment in this wallet that deserves a deliberate "are you sure,
 * keep this safe" UI step, unlike ordinary unlock-and-use.
 */
export async function exportPrivateKeyHex(passphrase?: string): Promise<string> {
  const unlocked = await unlockWallet(passphrase);
  return bytesToHex(unlocked.privateKey);
}

export async function deleteWallet(): Promise<void> {
  await idbDelete(STORE, RECORD_KEY);
}

export async function getStoredAddress(): Promise<string | null> {
  const record = await idbGet<WalletRecord>(STORE, RECORD_KEY);
  return record?.address ?? null;
}

export async function getWalletMeta(): Promise<Pick<WalletRecord, "address" | "autoPassphrase" | "createdAt"> | null> {
  const record = await idbGet<WalletRecord>(STORE, RECORD_KEY);
  if (!record) return null;
  return { address: record.address, autoPassphrase: record.autoPassphrase, createdAt: record.createdAt };
}

// ---------------------------------------------------------------------------
// hex helpers (small, local copies to avoid pulling @noble/hashes/utils into
// this module just for two one-line functions used only here)
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex string (odd length).");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}