/**
 * Weave block: header + transactions, canonical serialization, block hash,
 * and context-free structural validation.
 *
 * Header wire format — exactly 80 bytes, same layout as Bitcoin's:
 *
 *   version           u32
 *   prevHash          32 bytes
 *   merkleRoot        32 bytes
 *   timestamp         u32   (unix seconds)
 *   difficultyTarget  u32   (compact "bits" form, see target.ts)
 *   nonce             u32
 *
 * Block wire format: header (80 bytes) + varint txCount + transactions.
 *
 * Block hash = sha256d(80-byte header). Proof-of-work is valid when that hash,
 * read as a big-endian integer, is strictly below the target expanded from
 * `difficultyTarget`. (The PoW check itself runs at validation time, Phase 3.)
 */

import { ByteReader, ByteWriter, DecodeError } from "./bytes";
import { HASH_LENGTH, hashesEqual, hashToHex, sha256d, type Hash } from "./hash";
import { computeMerkleRootOfTransactions } from "./merkle";
import {
  MIN_TRANSACTION_BYTES,
  checkTransactionStructure,
  getTxId,
  isCoinbase,
  readTransaction,
  writeTransaction,
  type Transaction,
} from "./transaction";

export interface BlockHeader {
  version: number;
  /** Hash of the previous block's header (all zeros for genesis). */
  prevHash: Hash;
  /** Merkle root over this block's txids (see merkle.ts). */
  merkleRoot: Hash;
  /** Unix time in seconds. */
  timestamp: number;
  /** Target in compact "bits" form (see target.ts). Named per the build spec. */
  difficultyTarget: number;
  nonce: number;
}

export interface Block {
  header: BlockHeader;
  /** transactions[0] must be the coinbase; no other transaction may be one. */
  transactions: Transaction[];
}

export const BLOCK_VERSION = 1;
export const BLOCK_HEADER_BYTES = 80;

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function writeHeader(w: ByteWriter, h: BlockHeader): void {
  if (h.prevHash.length !== HASH_LENGTH) throw new RangeError("prevHash must be 32 bytes");
  if (h.merkleRoot.length !== HASH_LENGTH) throw new RangeError("merkleRoot must be 32 bytes");
  w.writeU32LE(h.version);
  w.writeBytes(h.prevHash);
  w.writeBytes(h.merkleRoot);
  w.writeU32LE(h.timestamp);
  w.writeU32LE(h.difficultyTarget);
  w.writeU32LE(h.nonce);
}

function readHeader(r: ByteReader): BlockHeader {
  return {
    version: r.readU32LE(),
    prevHash: r.readBytes(HASH_LENGTH),
    merkleRoot: r.readBytes(HASH_LENGTH),
    timestamp: r.readU32LE(),
    difficultyTarget: r.readU32LE(),
    nonce: r.readU32LE(),
  };
}

export function serializeHeader(header: BlockHeader): Uint8Array {
  const w = new ByteWriter();
  writeHeader(w, header);
  return w.toBytes();
}

export function deserializeHeader(bytes: Uint8Array): BlockHeader {
  if (bytes.length !== BLOCK_HEADER_BYTES) {
    throw new DecodeError(`block header must be ${BLOCK_HEADER_BYTES} bytes, got ${bytes.length}`);
  }
  return readHeader(new ByteReader(bytes));
}

export function getBlockHash(header: BlockHeader): Hash {
  return sha256d(serializeHeader(header));
}

export function getBlockHashHex(header: BlockHeader): string {
  return hashToHex(getBlockHash(header));
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

const MIN_BLOCK_BYTES = BLOCK_HEADER_BYTES + 1 + MIN_TRANSACTION_BYTES;

export function serializeBlock(block: Block): Uint8Array {
  const w = new ByteWriter();
  writeHeader(w, block.header);
  w.writeVarInt(block.transactions.length);
  for (const tx of block.transactions) writeTransaction(w, tx);
  return w.toBytes();
}

/** Strict decode: throws DecodeError on truncation, non-canonical varints, or trailing bytes. */
export function deserializeBlock(bytes: Uint8Array): Block {
  if (bytes.length < MIN_BLOCK_BYTES) throw new DecodeError("block too short");
  const r = new ByteReader(bytes);
  const header = readHeader(r);
  const txCount = r.readVarInt();
  if (txCount * MIN_TRANSACTION_BYTES > r.remaining) {
    throw new DecodeError("transaction count exceeds available data");
  }
  const transactions: Transaction[] = [];
  for (let i = 0; i < txCount; i++) transactions.push(readTransaction(r));
  r.assertEnd();
  return { header, transactions };
}

export interface BlockTemplate {
  prevHash: Hash;
  timestamp: number;
  difficultyTarget: number;
  /** Full list including the coinbase at index 0. */
  transactions: Transaction[];
  version?: number;
  nonce?: number;
}

/** Assembles a block from parts, computing the merkle root. Mining then just varies `nonce`. */
export function assembleBlock(t: BlockTemplate): Block {
  return {
    header: {
      version: t.version ?? BLOCK_VERSION,
      prevHash: t.prevHash,
      merkleRoot: computeMerkleRootOfTransactions(t.transactions),
      timestamp: t.timestamp,
      difficultyTarget: t.difficultyTarget,
      nonce: t.nonce ?? 0,
    },
    transactions: t.transactions,
  };
}

// ---------------------------------------------------------------------------
// Structural validation (context-free)
// ---------------------------------------------------------------------------

/**
 * Checks that need no chain state: non-empty, coinbase first and only first,
 * every transaction well-formed, no duplicate txids, merkle root matches.
 * Returns null if OK, else a reason. PoW, timestamp rules, coinbase reward and
 * UTXO checks come in Phase 3.
 */
export function checkBlockStructure(block: Block): string | null {
  const { header, transactions } = block;
  if (transactions.length === 0) return "block has no transactions";
  if (!isCoinbase(transactions[0]!)) return "first transaction is not a coinbase";

  const seen = new Set<string>();
  for (const [i, tx] of transactions.entries()) {
    if (i > 0 && isCoinbase(tx)) return `transaction ${i}: extra coinbase`;
    const problem = checkTransactionStructure(tx);
    if (problem) return `transaction ${i}: ${problem}`;
    const id = hashToHex(getTxId(tx));
    if (seen.has(id)) return `transaction ${i}: duplicate txid ${id}`;
    seen.add(id);
  }

  if (!hashesEqual(header.merkleRoot, computeMerkleRootOfTransactions(transactions))) {
    return "merkle root mismatch";
  }
  return null;
}