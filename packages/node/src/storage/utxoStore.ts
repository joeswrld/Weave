/**
 * Default UtxoStore: LevelDB. Compact string values keep the on-disk
 * footprint small (anti-centralization goal: cheap to hold a full node).
 *
 * Key: "u:<txid>:<index>"  Value: "<height>:<coinbase 0|1>:<value>:<scriptHex>"
 */
import type { Level } from "level";
import { hashToHex, hexToHash, type UTXO } from "@weave/core";
import type { UtxoOp, UtxoStore } from "./types";

const P = "u:";
const key = (txidHex: string, i: number) => `${P}${txidHex}:${i}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function encode(u: UTXO): string {
  return `${u.blockHeight}:${u.isCoinbase ? 1 : 0}:${u.value}:${hex(u.lockingScript)}`;
}

function decode(k: string, v: string): UTXO {
  const [txid, idx] = k.slice(P.length).split(":") as [string, string];
  const [h, cb, val, script] = v.split(":") as [string, string, string, string];
  return {
    txid: hexToHash(txid),
    outputIndex: Number(idx),
    value: BigInt(val),
    lockingScript: new Uint8Array(Buffer.from(script, "hex")),
    blockHeight: Number(h),
    isCoinbase: cb === "1",
  };
}

export class LevelUtxoStore implements UtxoStore {
  constructor(private readonly db: Level<string, string>) {}

  async get(txidHex: string, outputIndex: number): Promise<UTXO | null> {
    const k = key(txidHex, outputIndex);
    try {
      return decode(k, await this.db.get(k));
    } catch (e: any) {
      if (e?.code === "LEVEL_NOT_FOUND") return null;
      throw e;
    }
  }

  put(u: UTXO): Promise<void> {
    return this.db.put(key(hashToHex(u.txid), u.outputIndex), encode(u));
  }

  delete(txidHex: string, outputIndex: number): Promise<void> {
    return this.db.del(key(txidHex, outputIndex));
  }

  async batch(ops: UtxoOp[]): Promise<void> {
    await this.db.batch(
      ops.map((op) =>
        op.type === "put"
          ? { type: "put" as const, key: key(hashToHex(op.utxo.txid), op.utxo.outputIndex), value: encode(op.utxo) }
          : { type: "del" as const, key: key(op.txidHex, op.outputIndex) },
      ),
    );
  }

  async *all(): AsyncIterable<UTXO> {
    for await (const [k, v] of this.db.iterator({ gte: P, lt: "u;" })) yield decode(k, v);
  }

  async count(): Promise<number> {
    let n = 0;
    for await (const _ of this.db.keys({ gte: P, lt: "u;" })) n++;
    return n;
  }
}