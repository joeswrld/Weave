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