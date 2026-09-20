/**
 * Default ChainStore: LevelDB, sharing one db with the UTXO store via
 * disjoint key prefixes ("b:" blocks, "m:" meta, "h:" height index, "t" tip).
 */
import type { Level } from "level";
import { deserializeBlock, serializeBlock, type Block } from "@weave/core";
import type { ChainStore, StoredBlockMeta } from "./types";

const notFound = (e: any) => e?.code === "LEVEL_NOT_FOUND";
const pad = (h: number) => h.toString().padStart(10, "0");

export class LevelChainStore implements ChainStore {
  constructor(private readonly db: Level<string, string>) {}

  private async read(k: string): Promise<string | null> {
    try {
      return await this.db.get(k);
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  async getBlock(hashHex: string): Promise<Block | null> {
    const v = await this.read(`b:${hashHex}`);
    return v ? deserializeBlock(new Uint8Array(Buffer.from(v, "hex"))) : null;
  }

  async getMeta(hashHex: string): Promise<StoredBlockMeta | null> {
    const v = await this.read(`m:${hashHex}`);
    return v ? (JSON.parse(v) as StoredBlockMeta) : null;
  }

  async putBlock(block: Block, meta: StoredBlockMeta): Promise<void> {
    await this.db.batch([
      { type: "put", key: `b:${meta.hashHex}`, value: Buffer.from(serializeBlock(block)).toString("hex") },
      { type: "put", key: `m:${meta.hashHex}`, value: JSON.stringify(meta) },
    ]);
  }

  putMeta(meta: StoredBlockMeta): Promise<void> {
    return this.db.put(`m:${meta.hashHex}`, JSON.stringify(meta));
  }

  getTip(): Promise<string | null> {
    return this.read("t");
  }
  setTip(hashHex: string): Promise<void> {
    return this.db.put("t", hashHex);
  }
  getHashAtHeight(height: number): Promise<string | null> {
    return this.read(`h:${pad(height)}`);
  }
  setHashAtHeight(height: number, hashHex: string): Promise<void> {
    return this.db.put(`h:${pad(height)}`, hashHex);
  }
  deleteHashAtHeight(height: number): Promise<void> {
    return this.db.del(`h:${pad(height)}`);
  }

  /** Prune a block's body (keeps meta so the index/work math survives). */
  async deleteBlockBody(hashHex: string): Promise<void> {
    await this.db.del(`b:${hashHex}`);
  }

  async *allMeta(): AsyncIterable<StoredBlockMeta> {
    for await (const v of this.db.values({ gte: "m:", lt: "m;" })) yield JSON.parse(v) as StoredBlockMeta;
  }
}