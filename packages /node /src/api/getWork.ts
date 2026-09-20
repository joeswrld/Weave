
/**
 * Get-work / submit-block endpoints for the browser miner (Phase 8), in the
 * spirit of getblocktemplate. The node hands out a full candidate block
 * (header w/ nonce=0 + txs) paying `address`; the browser varies only the
 * nonce, then submits. The node re-validates everything on submit — it
 * never trusts the miner.
 */
import type { Express } from "express";
import { compactToTarget, getBlockHashHex, hashToHex, serializeBlock, deserializeBlock, createLockingScript } from "@weave/core";
import { addressToPubKeyHash } from "@weave/crypto";
import type { WeaveNode } from "../node";
import { assembleCandidateBlock } from "../miner";

export function registerWorkRoutes(app: Express, node: WeaveNode): void {
  app.get("/api/getwork/:address", (req, res) => {
    const pkh = addressToPubKeyHash(req.params.address);
    if (!pkh) return void res.status(400).json({ error: "invalid address" });
    const tip = node.chain.tip;
    const extra = Buffer.alloc(4);
    extra.writeUInt32BE(Math.floor(Math.random() * 0xffff_ffff));
    const { block, totalFees } = assembleCandidateBlock({
      height: tip.height + 1,
      prevHash: tip.hash,
      difficultyTarget: node.chain.nextDifficultyBits(),
      payoutLockingScript: createLockingScript(pkh),
      mempool: node.mempool,
      coinbaseExtraData: new Uint8Array(extra),
      timestamp: Math.max(Math.floor(Date.now() / 1000), tip.block.header.timestamp + 1),
    });
    res.json({
      height: tip.height + 1,
      prevHash: tip.hashHex,
      difficultyBits: block.header.difficultyTarget,
      target: compactToTarget(block.header.difficultyTarget)!.toString(16).padStart(64, "0"),
      header: { ...block.header, prevHash: hashToHex(block.header.prevHash), merkleRoot: hashToHex(block.header.merkleRoot) },
      blockHex: Buffer.from(serializeBlock(block)).toString("hex"),
      totalFees: totalFees.toString(),
    });
  });

  app.post("/api/submitblock", (req, res) => {
    const h = req.body?.blockHex;
    if (typeof h !== "string" || !/^[0-9a-fA-F]+$/.test(h) || h.length > 4_000_000) {
      return void res.status(400).json({ error: "blockHex required" });
    }
    let block;
    try { block = deserializeBlock(new Uint8Array(Buffer.from(h, "hex"))); }
    catch { return void res.status(400).json({ error: "could not deserialize block" }); }
    const r = node.acceptLocalBlock(block);
    res.status(r.ok ? 200 : 422).json({ ...r, hash: r.hash || getBlockHashHex(block.header) });
  });
}