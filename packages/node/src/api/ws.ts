/**
 * WebSocket feed for browser wallets: pushes new-block / new-tx / reorg
 * events (no polling). Clients may subscribe to specific addresses to get
 * only events touching them; default is everything.
 *
 *   client -> {"op":"subscribe","addresses":["<address>"]}   (optional filter)
 *   server -> {"type":"hello", ...chain info}
 *   server -> {"type":"block"|"tx"|"reorg", ...}
 */
import { WebSocketServer, type WebSocket } from "ws";
import { addressToPubKeyHash } from "@weave/crypto";
import type { WeaveNode, NodeEvent } from "../node";
import { ConnectionLimiter } from "./security";

const MAX_CONN_PER_IP = 8;
const HEARTBEAT_MS = 30_000;

export function createWalletFeed(node: WeaveNode): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 16 * 1024,
    verifyClient: ({ origin }: { origin?: string }) =>
      node.config.corsOrigins.includes("*") || !origin || node.config.corsOrigins.includes(origin),
  });
  const limiter = new ConnectionLimiter(MAX_CONN_PER_IP);
  const alive = new WeakMap<WebSocket, boolean>();
  const filters = new WeakMap<WebSocket, Set<string>>();

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!limiter.acquire(ip)) return void ws.close(1013, "too many connections");
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("close", () => limiter.release(ip));
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.op === "subscribe" && Array.isArray(m.addresses)) {
          const pkhs = new Set<string>();
          for (const a of m.addresses.slice(0, 50)) {
            const pkh = typeof a === "string" ? addressToPubKeyHash(a) : null;
            if (pkh) pkhs.add(Buffer.from(pkh).toString("hex"));
          }
          filters.set(ws, pkhs);
          ws.send(JSON.stringify({ type: "subscribed", count: pkhs.size }));
        }
      } catch { /* ignore malformed client frames */ }
    });
    ws.send(JSON.stringify({ type: "hello", ...node.blockchainInfo() }));
  });

  const onEvent = (e: NodeEvent) => {
    const { touched, ...pub } = e as NodeEvent & { touched?: string[] };
    const msg = JSON.stringify(pub);
    for (const c of wss.clients) {
      if (c.readyState !== c.OPEN) continue;
      const f = filters.get(c);
      // Reorgs and new blocks always go out to every subscribed client:
      // a wallet needs to know the chain tip advanced (to refresh its own
      // UTXOs/mempool view, retarget its mining candidate, etc.) even for
      // a block that didn't pay its own address — most blocks won't.
      // Only "tx" events are actually filtered down to addresses a client
      // subscribed to, since those are relevant purely by who they touch.
      if (f && f.size && e.type === "tx" && !touched?.some((p) => f.has(p))) continue;
      c.send(msg);
    }
  };
  node.on("event", onEvent);

  const hb = setInterval(() => {
    for (const c of wss.clients) {
      if (alive.get(c) === false) { c.terminate(); continue; }
      alive.set(c, false);
      c.ping();
    }
  }, HEARTBEAT_MS);
  hb.unref();
  wss.on("close", () => { clearInterval(hb); node.off("event", onEvent); });
  return wss;
}