/**
 * REST + JSON-RPC 2.0 API. Both surfaces call the same handlers:
 *   getbalance, sendtransaction, getblock, getblockchaininfo, listunspent
 * (+ getmempoolinfo, getpeerinfo). Amounts are decimal strings of smallest
 * units (bigint isn't JSON-safe).
 */
import express, { type Express, type Request, type Response } from "express";
import { getTxIdHex, hashToHex, serializeBlock, serializeTransaction, type Block, type Transaction } from "@weave/core";
import type { WeaveNode } from "../node";
import { cors, rateLimiter, securityHeaders } from "./security";
import { registerWorkRoutes } from "./getWork";

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}
const INVALID_PARAMS = -32602;
const NOT_FOUND = -5;
const REJECTED = -26;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function txToJson(tx: Transaction) {
  return {
    txid: getTxIdHex(tx),
    version: tx.version,
    size: serializeTransaction(tx).length,
    inputs: tx.inputs.map((i) => ({ prevTxId: hashToHex(i.prevTxId), outputIndex: i.outputIndex })),
    outputs: tx.outputs.map((o, n) => ({ n, value: o.value.toString(), lockingScript: hex(o.lockingScript) })),
  };
}

export function blockToJson(b: Block, hash: string, height: number, confirmations: number) {
  return {
    hash, height, confirmations,
    size: serializeBlock(b).length,
    header: { ...b.header, prevHash: hashToHex(b.header.prevHash), merkleRoot: hashToHex(b.header.merkleRoot) },
    txids: b.transactions.map(getTxIdHex),
    tx: b.transactions.map(txToJson),
  };
}

export function buildMethods(node: WeaveNode): Record<string, (p: any) => Promise<unknown> | unknown> {
  const requireStr = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v) throw new RpcError(INVALID_PARAMS, `${name} (string) required`);
    return v;
  };
  return {
    getblockchaininfo: () => node.blockchainInfo(),

    getbalance: ({ address }) => {
      const utxos = node.utxosForAddress(requireStr(address, "address"));
      if (!utxos) throw new RpcError(INVALID_PARAMS, "invalid address");
      const height = node.chain.height;
      let confirmed = 0n, immature = 0n;
      for (const u of utxos) {
        if (u.isCoinbase && height - u.blockHeight < 100) immature += u.value;
        else confirmed += u.value;
      }
      return { address, balance: confirmed.toString(), immature: immature.toString(), utxoCount: utxos.length };
    },

    listunspent: ({ address }) => {
      const utxos = node.utxosForAddress(requireStr(address, "address"));
      if (!utxos) throw new RpcError(INVALID_PARAMS, "invalid address");
      const height = node.chain.height;
      return utxos.map((u) => ({
        txid: hashToHex(u.txid), outputIndex: u.outputIndex, value: u.value.toString(),
        lockingScript: hex(u.lockingScript), blockHeight: u.blockHeight, coinbase: u.isCoinbase,
        confirmations: height - u.blockHeight + 1,
        spendable: !u.isCoinbase || height + 1 - u.blockHeight >= 100,
      }));
    },

    sendtransaction: ({ hex: txHex }) => {
      const h = requireStr(txHex, "hex");
      if (!/^[0-9a-fA-F]+$/.test(h) || h.length > 200_000) throw new RpcError(INVALID_PARAMS, "invalid tx hex");
      let tx: Transaction;
      try { tx = node.parseTx(h); } catch { throw new RpcError(INVALID_PARAMS, "could not deserialize transaction"); }
      const r = node.acceptTransaction(tx);
      if (!r.ok) throw new RpcError(REJECTED, r.reason ?? "rejected");
      return { txid: r.txid };
    },

    getblock: async ({ id }) => {
      const found = await node.getBlockByHashOrHeight(requireStr(String(id ?? ""), "id"));
      if (!found) throw new RpcError(NOT_FOUND, "block not found (unknown or pruned)");
      return blockToJson(found.block, found.hash, found.height, found.confirmations);
    },

    getmempoolinfo: () => ({
      size: node.mempool.size(),
      totalFees: node.mempool.totalFeesAvailable().toString(),
      txids: node.mempool.getPrioritized(100_000).map(getTxIdHex),
    }),

    getpeerinfo: () =>
      (node.peers?.readyPeers ?? []).map((p) => ({ address: p.advertisedListenAddress, height: p.remoteHeight, userAgent: p.userAgent })),
  };
}

export function createApp(node: WeaveNode): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind a TLS-terminating reverse proxy, req.ip is the real client
  app.use(securityHeaders, cors(node.config), rateLimiter(node.config.rateLimit.windowMs, node.config.rateLimit.max));
  app.use(express.json({ limit: "256kb" }));

  const methods = buildMethods(node);
  const admin = (req: Request): boolean => !node.config.adminToken || req.headers.authorization === `Bearer ${node.config.adminToken}`;

  const restCall = (name: string, pick: (req: Request) => any) => async (req: Request, res: Response) => {
    try {
      res.json(await methods[name]!(pick(req)));
    } catch (e) {
      const status = e instanceof RpcError ? (e.code === NOT_FOUND ? 404 : e.code === REJECTED ? 422 : 400) : 500;
      res.status(status).json({ error: e instanceof RpcError ? e.message : "internal error" });
    }
  };

  app.get("/health", (_q, r) => r.json({ ok: true, height: node.chain.height }));
  app.get("/api/blockchaininfo", restCall("getblockchaininfo", () => ({})));
  app.get("/api/balance/:address", restCall("getbalance", (q) => ({ address: q.params.address })));
  app.get("/api/utxos/:address", restCall("listunspent", (q) => ({ address: q.params.address })));
  app.get("/api/block/:id", restCall("getblock", (q) => ({ id: q.params.id })));
  app.get("/api/mempool", restCall("getmempoolinfo", () => ({})));
  app.get("/api/peers", restCall("getpeerinfo", () => ({})));
  app.post("/api/tx", restCall("sendtransaction", (q) => ({ hex: q.body?.hex })));

  app.post("/api/mining", (req, res) => {
    if (!admin(req)) return void res.status(401).json({ error: "unauthorized" });
    try {
      if (req.body?.enabled) node.startMining(req.body?.address);
      else node.stopMining();
      res.json({ mining: node.isMining });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // JSON-RPC 2.0 (single + batch, capped at 20)
  app.post("/rpc", async (req, res) => {
    const handle = async (call: any) => {
      const id = call?.id ?? null;
      try {
        const fn = typeof call?.method === "string" ? methods[call.method] : undefined;
        if (!fn) return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
        return { jsonrpc: "2.0", id, result: await fn(call.params ?? {}) };
      } catch (e) {
        const err = e instanceof RpcError ? { code: e.code, message: e.message } : { code: -32603, message: "internal error" };
        return { jsonrpc: "2.0", id, error: err };
      }
    };
    const body = req.body;
    if (Array.isArray(body)) return void res.json(await Promise.all(body.slice(0, 20).map(handle)));
    res.json(await handle(body));
  });

  registerWorkRoutes(app, node);

  // Phase 8 pool routes: alternate to solo getwork/submitblock above, for
  // browser tabs that want to mine together and split rewards by
  // contributed work — see mining-pool.ts's header comment for the full
  // design. Kept as thin wrappers here (rather than inside getWork.ts)
  // since they talk to node.pool, not node.chain/mempool directly.
  app.get("/api/pool/getwork/:address", (req, res) => {
    const work = node.pool.getWork(req.params.address);
    if ("error" in work) return void res.status(400).json(work);
    res.json(work);
  });

  app.post("/api/pool/submitshare", (req, res) => {
    const { address, blockHex, nonce } = req.body ?? {};
    if (typeof address !== "string" || typeof blockHex !== "string" || typeof nonce !== "number") {
      return void res.status(400).json({ ok: false, reason: "address, blockHex, nonce required" });
    }
    res.json(node.pool.submitShare(address, blockHex, nonce));
  });

  app.get("/api/pool/status", (_req, res) => res.json(node.pool.status()));

  return app;
}