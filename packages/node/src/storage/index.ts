export * from "./types";
export * from "./utxoStore";
export * from "./chainStore";

import { Level } from "level";
import { LevelChainStore } from "./chainStore";
import { LevelUtxoStore } from "./utxoStore";

/**
 * Opens (creating if needed) the zero-config default on-disk store: one
 * LevelDB directory at `dataDir`, shared by both the UTXO set and the
 * chain/block index (they use disjoint key prefixes — see utxoStore.ts /
 * chainStore.ts — so this is safe). This is what a node calls by default;
 * an operator who wants Postgres instead implements `UtxoStore`/
 * `ChainStore` (./types) against their own instance and passes those in
 * place of what this returns.
 */
export async function openDefaultStores(
  dataDir: string,
): Promise<{ utxoStore: LevelUtxoStore; chainStore: LevelChainStore; close: () => Promise<void> }> {
  const db = new Level<string, string>(dataDir, { valueEncoding: "utf8" });
  await db.open();
  return {
    utxoStore: new LevelUtxoStore(db),
    chainStore: new LevelChainStore(db),
    close: () => db.close(),
  };
}