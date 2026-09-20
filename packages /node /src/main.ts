/** Weave node entrypoint: storage -> node -> HTTP(S) server (REST + JSON-RPC + WS feed + P2P) . */
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { loadConfig } from "./config";
import { openDefaultStores } from "./storage";
import { WeaveNode } from "./node";
import { createApp } from "./api/rest";
import { createWalletFeed } from "./api/ws";

async function main(): Promise<void> {
  const config = loadConfig();
  const stores = await openDefaultStores(config.dataDir);
  const node = new WeaveNode(config, stores.utxoStore, stores.chainStore);
  await node.start();

  const app = createApp(node);
  // One server, one TLS termination point: REST + JSON-RPC (/rpc), wallet feed (/ws) and P2P (/p2p).
  const server = config.tls ? createHttps(config.tls, app) : createHttp(app);
  if (!config.tls) console.warn("[weave] TLS_KEY_FILE/TLS_CERT_FILE not set: serving plain HTTP/WS. Terminate TLS at a reverse proxy or set them for HTTPS/WSS.");

  // `ws` can't share one HTTP server between two path-scoped WebSocketServers (the first aborts
  // non-matching upgrades), so both run in noServer mode and we route upgrades by path here.
  const feed = createWalletFeed(node);
  const p2p = node.peers.createInboundServer();
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const target = path === "/ws" ? feed : path === "/p2p" ? p2p : null;
    if (!target) return void socket.destroy();
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });
  node.peers.start();

  server.listen(config.port, config.host, () => {
    const info = node.blockchainInfo();
    console.log(`[weave] node up on ${config.tls ? "https" : "http"}://${config.host}:${config.port}  height=${info.height} tip=${info.bestBlockHash.slice(0, 16)}… mining=${info.mining} retain=${config.retainBlocks || "all"}`);
  });

  const shutdown = async (sig: string) => {
    console.log(`[weave] ${sig}: shutting down`);
    server.close();
    await node.stop();
    await stores.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => { console.error(e); process.exit(1); });