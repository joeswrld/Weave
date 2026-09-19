/**
 * Weave transaction: types, canonical serialization, txid, coinbase
 * construction, and context-free structural validation.
 *
 * Wire format (all integers little-endian):
 *
 *   version            u32
 *   inputCount         varint
 *   inputs[]:
 *     prevTxId         32 bytes
 *     outputIndex      u32
 *     unlockingScript  varint length + bytes
 *   outputCount        varint
 *   outputs[]:
 *     value            u64   (smallest units — 1 WVE = 10^8)
 *     lockingScript    varint length + bytes
 *
 * txid = sha256d(serialized transaction), raw bytes (see hash.ts for the
 * byte-order convention).
 *
 * Amounts are `bigint`, not `number`: max supply is ~99.864M WVE, which is
 * ~9.99e15 smallest units — above Number.MAX_SAFE_INTEGER (~9.007e15). Summing
 * output values as floats could silently lose precision, which is exactly the
 * kind of bug that turns into inflation. Keep all money arithmetic in bigint.
 */

import { ByteReader, ByteWriter, DecodeError } from "./bytes";
import { APPROX_MAX_SUPPLY_WVE, SMALLEST_UNITS_PER_WVE } from "./consensus-params";
import { HASH_LENGTH, hashToHex, sha256d, zeroHash, type Hash } from "./hash";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TxInput {
  /** txid of the transaction whose output is being spent (32 bytes). */
  prevTxId: Hash;
  /** Index of that output within the previous transaction. */
  outputIndex: number;
  /** Signature + pubkey data proving the right to spend (script model: Phase 2). */
  unlockingScript: Uint8Array;
}

export interface TxOutput {
  /** Amount in smallest units. */
  value: bigint;
  /** Spending conditions, e.g. a P2PKH-style script (script model: Phase 2). */
  lockingScript: Uint8Array;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

// ---------------------------------------------------------------------------
// Constants (consensus-critical)
// ---------------------------------------------------------------------------

export const TX_VERSION = 1;

/** No single output, and no transaction's output total, may exceed this. */
export const MAX_MONEY: bigint =
  BigInt(APPROX_MAX_SUPPLY_WVE) * BigInt(SMALLEST_UNITS_PER_WVE);

/** Coinbase inputs spend "nothing": all-zero prevTxId and this output index. */
export const COINBASE_OUTPUT_INDEX = 0xffff_ffff;

/**
 * Coinbase unlockingScript = u32 height (LE) + free-form extra data.
 * Embedding the height guarantees every coinbase has a unique txid (otherwise
 * two blocks paying the same address the same reward would collide), and the
 * extra data doubles as the "extranonce" a miner can vary when the 32-bit
 * header nonce space is exhausted — which browser miners will hit.
 */
export const COINBASE_SCRIPT_MIN_BYTES = 4;
export const COINBASE_SCRIPT_MAX_BYTES = 100;

// Smallest possible encodings, used to reject absurd length prefixes early.
const MIN_INPUT_BYTES = HASH_LENGTH + 4 + 1; // prevTxId + index + empty script
const MIN_OUTPUT_BYTES = 8 + 1; // value + empty script
/** version + inCount + one min input + outCount + one min output */
export const MIN_TRANSACTION_BYTES = 4 + 1 + MIN_INPUT_BYTES + 1 + MIN_OUTPUT_BYTES;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function writeBody(
  w: ByteWriter,
  tx: Transaction,
  scriptForInput: (index: number) => Uint8Array,
): void {
  w.writeU32LE(tx.version);
  w.writeVarInt(tx.inputs.length);
  tx.inputs.forEach((input, i) => {
    if (input.prevTxId.length !== HASH_LENGTH) {
      throw new RangeError(`input ${i}: prevTxId must be ${HASH_LENGTH} bytes`);
    }
    w.writeBytes(input.prevTxId);
    w.writeU32LE(input.outputIndex);
    w.writeVarBytes(scriptForInput(i));
  });
  w.writeVarInt(tx.outputs.length);
  for (const output of tx.outputs) {
    w.writeU64LE(output.value);
    w.writeVarBytes(output.lockingScript);
  }
}

export function writeTransaction(w: ByteWriter, tx: Transaction): void {
  writeBody(w, tx, (i) => tx.inputs[i]!.unlockingScript);
}

export function serializeTransaction(tx: Transaction): Uint8Array {
  const w = new ByteWriter();
  writeTransaction(w, tx);
  return w.toBytes();
}

export function readTransaction(r: ByteReader): Transaction {
  const version = r.readU32LE();

  const inputCount = r.readVarInt();
  if (inputCount * MIN_INPUT_BYTES > r.remaining) {
    throw new DecodeError("input count exceeds available data");
  }
  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputs.push({
      prevTxId: r.readBytes(HASH_LENGTH),
      outputIndex: r.readU32LE(),
      unlockingScript: r.readVarBytes(),
    });
  }

  const outputCount = r.readVarInt();
  if (outputCount * MIN_OUTPUT_BYTES > r.remaining) {
    throw new DecodeError("output count exceeds available data");
  }
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push({ value: r.readU64LE(), lockingScript: r.readVarBytes() });
  }

  return { version, inputs, outputs };
}

/** Strict decode: throws DecodeError on truncation, non-canonical varints, or trailing bytes. */
export function deserializeTransaction(bytes: Uint8Array): Transaction {
  const r = new ByteReader(bytes);
  const tx = readTransaction(r);
  r.assertEnd();
  return tx;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function getTxId(tx: Transaction): Hash {
  return sha256d(serializeTransaction(tx));
}

export function getTxIdHex(tx: Transaction): string {
  return hashToHex(getTxId(tx));
}

/** Map key for the UTXO set: "<txid hex>:<output index>". */
export function outpointKey(txid: Hash, outputIndex: number): string {
  return `${hashToHex(txid)}:${outputIndex}`;
}

// ---------------------------------------------------------------------------
// Coinbase
// ---------------------------------------------------------------------------

function isNullOutpoint(input: TxInput): boolean {
  return (
    input.outputIndex === COINBASE_OUTPUT_INDEX &&
    input.prevTxId.length === HASH_LENGTH &&
    input.prevTxId.every((b) => b === 0)
  );
}

/** A coinbase has exactly one input, and that input spends the null outpoint. */
export function isCoinbase(tx: Transaction): boolean {
  return tx.inputs.length === 1 && isNullOutpoint(tx.inputs[0]!);
}

/**
 * Builds a coinbase transaction. `outputs` is an array so a mining pool can
 * pay several participants directly in the coinbase (Phase 8); a solo miner
 * passes one output. Reward-amount correctness (subsidy + fees) is checked at
 * block validation (Phase 3), not here.
 */
export function createCoinbaseTransaction(
  height: number,
  outputs: TxOutput[],
  extraData: Uint8Array = new Uint8Array(0),
): Transaction {
  if (COINBASE_SCRIPT_MIN_BYTES + extraData.length > COINBASE_SCRIPT_MAX_BYTES) {
    throw new RangeError(
      `coinbase extraData too long (max ${COINBASE_SCRIPT_MAX_BYTES - COINBASE_SCRIPT_MIN_BYTES} bytes)`,
    );
  }
  const script = new ByteWriter().writeU32LE(height).writeBytes(extraData).toBytes();
  return {
    version: TX_VERSION,
    inputs: [
      {
        prevTxId: zeroHash(),
        outputIndex: COINBASE_OUTPUT_INDEX,
        unlockingScript: script,
      },
    ],
    outputs: outputs.map((o) => ({ value: o.value, lockingScript: o.lockingScript.slice() })),
  };
}

/** Reads the height embedded in a coinbase's unlocking script, or null if malformed. */
export function getCoinbaseHeight(tx: Transaction): number | null {
  if (!isCoinbase(tx)) return null;
  const script = tx.inputs[0]!.unlockingScript;
  if (script.length < COINBASE_SCRIPT_MIN_BYTES) return null;
  return new DataView(script.buffer, script.byteOffset, script.byteLength).getUint32(0, true);
}

// ---------------------------------------------------------------------------
// Signing hash (consumed by packages/crypto in Phase 2)
// ---------------------------------------------------------------------------

// ASCII domain tag so a signature made for Weave can never be valid on another
// chain that happens to share the curve and a similar tx layout.
const SIGHASH_DOMAIN = Uint8Array.from("WVE_SIGHASH_V1", (c) => c.charCodeAt(0));
const EMPTY = new Uint8Array(0);

/**
 * The 32-byte message that input `inputIndex` must sign. It commits to the
 * whole transaction (all outpoints and all outputs) with every unlocking
 * script blanked, except the signed input's slot, which holds the locking
 * script of the output being spent (this is Bitcoin's SIGHASH_ALL scheme).
 *
 * Because signatures are excluded from what's signed, they can be attached
 * afterwards; because they ARE included in the txid, a third party mutating a
 * signature changes the txid — Phase 2 must therefore enforce canonical
 * (low-S, fixed-length) signatures to close that malleability hole.
 */
export function getSigningHash(
  tx: Transaction,
  inputIndex: number,
  prevLockingScript: Uint8Array,
): Hash {
  if (isCoinbase(tx)) throw new Error("coinbase transactions are not signed");
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new RangeError(`input index out of range: ${inputIndex}`);
  }
  const w = new ByteWriter();
  w.writeBytes(SIGHASH_DOMAIN);
  writeBody(w, tx, (i) => (i === inputIndex ? prevLockingScript : EMPTY));
  return sha256d(w.toBytes());
}

// ---------------------------------------------------------------------------
// Structural validation (context-free: needs no UTXO set and no chain state)
// ---------------------------------------------------------------------------

/**
 * Cheap checks every node runs before anything else. Returns null if the
 * transaction is well-formed, or a human-readable reason if not. Does NOT
 * check signatures, whether inputs exist/are unspent, or fees — those need
 * the UTXO set (Phase 3).
 */
export function checkTransactionStructure(tx: Transaction): string | null {
  if (tx.version !== TX_VERSION) return `unsupported transaction version ${tx.version}`;
  if (tx.inputs.length === 0) return "transaction has no inputs";
  if (tx.outputs.length === 0) return "transaction has no outputs";

  let total = 0n;
  for (const [i, out] of tx.outputs.entries()) {
    if (typeof out.value !== "bigint") return `output ${i}: value must be a bigint`;
    if (out.value <= 0n) return `output ${i}: value must be positive`;
    if (out.value > MAX_MONEY) return `output ${i}: value exceeds max supply`;
    total += out.value;
    if (total > MAX_MONEY) return "total output value exceeds max supply";
  }

  const coinbase = isCoinbase(tx);
  const seen = new Set<string>();
  for (const [i, input] of tx.inputs.entries()) {
    if (input.prevTxId.length !== HASH_LENGTH) return `input ${i}: prevTxId must be ${HASH_LENGTH} bytes`;
    if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0 || input.outputIndex > 0xffff_ffff) {
      return `input ${i}: invalid output index`;
    }
    if (!coinbase && isNullOutpoint(input)) return `input ${i}: null outpoint in non-coinbase transaction`;
    const key = outpointKey(input.prevTxId, input.outputIndex);
    if (seen.has(key)) return `input ${i}: duplicate input ${key}`;
    seen.add(key);
  }

  if (coinbase) {
    const len = tx.inputs[0]!.unlockingScript.length;
    if (len < COINBASE_SCRIPT_MIN_BYTES || len > COINBASE_SCRIPT_MAX_BYTES) {
      return `coinbase script must be ${COINBASE_SCRIPT_MIN_BYTES}-${COINBASE_SCRIPT_MAX_BYTES} bytes`;
    }
  }

  return null;
}