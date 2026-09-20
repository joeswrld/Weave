/**
 * Pluggable storage contract (Phase 3 persistence).
 *
 * DECENTRALIZATION RULE — applies to every implementation, present or
 * future: a node's store is written only with blocks/transactions that
 * node itself independently validated (via @weave/core's ChainState /
 * validateBlock), and read only by that same node. A store is a local
 * persistence detail, never a shared source of truth. No implementation
 * may be pointed at by more than one node operator — doing so would
 * silently centralize the network regardless of database technology.
 *
 * Validation logic never talks to a concrete backend; it only sees these
 * interfaces. That lets an operator swap LevelDB for Postgres via config
 * without touching consensus code.
 */

import type { Block, UTXO } from "@weave/core";

/** One mutation in an atomic UTXO batch. */
export type UtxoOp =
  | { type: "put"; utxo: UTXO }
  | { type: "delete"; txidHex: string; outputIndex: number };

export interface UtxoStore {
  /** Returns the UTXO at (txid, index), or null if absent/spent. */
  get(txidHex: string, outputIndex: number): Promise<UTXO | null>;
  put(utxo: UTXO): Promise<void>;
  delete(txidHex: string, outputIndex: number): Promise<void>;
  /**
   * Applies all operations atomically — either every op lands or none
   * does. Block connect/disconnect MUST go through this so a crash
   * mid-block can't leave the UTXO set half-updated.
   */
  batch(ops: UtxoOp[]): Promise<void>;
  /** Streams every stored UTXO (used to rebuild the in-memory UtxoSet on startup). */
  all(): AsyncIterable<UTXO>;
  /** Total number of stored UTXOs. */
  count(): Promise<number>;
}

/** Persisted block metadata: enough to rebuild the in-memory block index without re-deriving work. */
export interface StoredBlockMeta {
  hashHex: string;
  height: number;
  /** Cumulative work, decimal string (bigint isn't JSON-safe). */
  cumulativeWork: string;
  onBestChain: boolean;
}

export interface ChainStore {
  getBlock(hashHex: string): Promise<Block | null>;
  getMeta(hashHex: string): Promise<StoredBlockMeta | null>;
  /** Persists the block plus its index metadata together. Idempotent. */
  putBlock(block: Block, meta: StoredBlockMeta): Promise<void>;
  /** Updates only the metadata (e.g. flipping onBestChain during a reorg). */
  putMeta(meta: StoredBlockMeta): Promise<void>;
  /** Hex hash of the current best-chain tip, or null for a brand-new store. */
  getTip(): Promise<string | null>;
  setTip(hashHex: string): Promise<void>;
  /** Hash of the best-chain block at `height`, or null. */
  getHashAtHeight(height: number): Promise<string | null>;
  setHashAtHeight(height: number, hashHex: string): Promise<void>;
  deleteHashAtHeight(height: number): Promise<void>;
  /** Streams all stored block metadata (rebuilds the index on startup). */
  allMeta(): AsyncIterable<StoredBlockMeta>;
}

################ FILE: packages/node/src/storage/utxoStore.ts  (117 lines) ################
/**
 * Default UtxoStore: LevelDB-backed, local files only, zero config.
 *
 * Key layout (disjoint from chainStore.ts so both can share one Level DB):
 *   "u:" + txidHex + ":" + outputIndex  ->  hex-encoded canonical UTXO bytes
 *
 * UTXO value encoding (canonical, via core's ByteWriter):
 *   txid(32) | outputIndex(u32) | value(u64) | lockingScript(varbytes)
 *   | blockHeight(u32) | isCoinbase(u8)
 */

import {
  ByteReader,
  ByteWriter,
  HASH_LENGTH,
  hashToHex,
  hexToHash,
  type UTXO,
} from "@weave/core";
import type { Level } from "level";
import type { UtxoOp, UtxoStore } from "./types";

const PREFIX = "u:";

function keyOf(txidHex: string, outputIndex: number): string {
  return `${PREFIX}${txidHex}:${outputIndex}`;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function encodeUtxo(u: UTXO): string {
  const w = new ByteWriter();
  w.writeBytes(u.txid);
  w.writeU32LE(u.outputIndex);
  w.writeU64LE(u.value);
  w.writeVarBytes(u.lockingScript);
  w.writeU32LE(u.blockHeight);
  w.writeU8(u.isCoinbase ? 1 : 0);
  return bytesToHex(w.toBytes());
}

export function decodeUtxo(hex: string): UTXO {
  const r = new ByteReader(hexToBytes(hex));
  const txid = r.readBytes(HASH_LENGTH);
  const outputIndex = r.readU32LE();
  const value = r.readU64LE();
  const lockingScript = r.readVarBytes();
  const blockHeight = r.readU32LE();
  const flag = r.readU8();
  r.assertEnd();
  if (flag !== 0 && flag !== 1) throw new Error("corrupt UTXO record: bad coinbase flag");
  return { txid, outputIndex, value, lockingScript, blockHeight, isCoinbase: flag === 1 };
}

export class LevelUtxoStore implements UtxoStore {
  constructor(private readonly db: Level<string, string>) {}

  async get(txidHex: string, outputIndex: number): Promise<UTXO | null> {
    try {
      return decodeUtxo(await this.db.get(keyOf(txidHex, outputIndex)));
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(utxo: UTXO): Promise<void> {
    await this.db.put(keyOf(hashToHex(utxo.txid), utxo.outputIndex), encodeUtxo(utxo));
  }

  async delete(txidHex: string, outputIndex: number): Promise<void> {
    await this.db.del(keyOf(txidHex, outputIndex));
  }

  async batch(ops: UtxoOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.db.batch(
      ops.map((op) =>
        op.type === "put"
          ? { type: "put" as const, key: keyOf(hashToHex(op.utxo.txid), op.utxo.outputIndex), value: encodeUtxo(op.utxo) }
          : { type: "del" as const, key: keyOf(op.txidHex, op.outputIndex) },
      ),
    );
  }

  async *all(): AsyncIterable<UTXO> {
    // "u:" .. "u;" covers every key beginning with the "u:" prefix (';' is ':' + 1).
    for await (const [, value] of this.db.iterator({ gte: PREFIX, lt: "u;" })) {
      yield decodeUtxo(value);
    }
  }

  async count(): Promise<number> {
    let n = 0;
    for await (const _ of this.db.keys({ gte: PREFIX, lt: "u;" })) n++;
    return n;
  }
}

/** level v8 throws an error with code "LEVEL_NOT_FOUND" for missing keys. */
export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "LEVEL_NOT_FOUND";
}

// Re-export for tests / other modules that need hash<->hex without importing core directly.
export { hexToHash };

################ FILE: packages/node/src/storage/chainStore.ts  (101 lines) ################
/**
 * Default ChainStore: LevelDB-backed, local files only, zero config.
 *
 * Key layout (disjoint from utxoStore.ts's "u:" prefix):
 *   "b:" + hashHex      -> hex of canonical serialized block bytes
 *   "m:" + hashHex      -> JSON StoredBlockMeta
 *   "h:" + zero-padded height (10 digits) -> hashHex of best-chain block at that height
 *   "t:tip"             -> hashHex of the current best-chain tip
 *
 * Height keys are zero-padded so LevelDB's lexicographic ordering matches
 * numeric ordering (needed if anything ever range-scans heights).
 */

import { deserializeBlock, serializeBlock, type Block } from "@weave/core";
import type { Level } from "level";
import type { ChainStore, StoredBlockMeta } from "./types";
import { isNotFound } from "./utxoStore";

const BLOCK = "b:";
const META = "m:";
const HEIGHT = "h:";
const TIP_KEY = "t:tip";

function heightKey(height: number): string {
  if (!Number.isInteger(height) || height < 0) throw new RangeError(`bad height: ${height}`);
  return HEIGHT + height.toString().padStart(10, "0");
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class LevelChainStore implements ChainStore {
  constructor(private readonly db: Level<string, string>) {}

  private async getOrNull(key: string): Promise<string | null> {
    try {
      return await this.db.get(key);
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getBlock(hashHex: string): Promise<Block | null> {
    const raw = await this.getOrNull(BLOCK + hashHex);
    return raw === null ? null : deserializeBlock(hexToBytes(raw));
  }

  async getMeta(hashHex: string): Promise<StoredBlockMeta | null> {
    const raw = await this.getOrNull(META + hashHex);
    return raw === null ? null : (JSON.parse(raw) as StoredBlockMeta);
  }

  async putBlock(block: Block, meta: StoredBlockMeta): Promise<void> {
    // One atomic batch: a block is never stored without its metadata (or vice versa).
    await this.db.batch([
      { type: "put", key: BLOCK + meta.hashHex, value: bytesToHex(serializeBlock(block)) },
      { type: "put", key: META + meta.hashHex, value: JSON.stringify(meta) },
    ]);
  }

  async putMeta(meta: StoredBlockMeta): Promise<void> {
    await this.db.put(META + meta.hashHex, JSON.stringify(meta));
  }

  getTip(): Promise<string | null> {
    return this.getOrNull(TIP_KEY);
  }

  async setTip(hashHex: string): Promise<void> {
    await this.db.put(TIP_KEY, hashHex);
  }

  getHashAtHeight(height: number): Promise<string | null> {
    return this.getOrNull(heightKey(height));
  }

  async setHashAtHeight(height: number, hashHex: string): Promise<void> {
    await this.db.put(heightKey(height), hashHex);
  }

  async deleteHashAtHeight(height: number): Promise<void> {
    await this.db.del(heightKey(height));
  }

  async *allMeta(): AsyncIterable<StoredBlockMeta> {
    for await (const [, value] of this.db.iterator({ gte: META, lt: "m;" })) {
      yield JSON.parse(value) as StoredBlockMeta;
    }
  }
}
