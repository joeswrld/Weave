/**
 * Weave P2P peer manager (Phase 5).
 *
 * Owns every `Peer` this node currently has a connection to — both
 * directions at once: an inbound `WebSocketServer` for peers dialing us,
 * and outbound `WebSocket` connections we initiate toward seed nodes /
 * discovered peers. This is also where the build spec's "hardcoded seed
 * nodes to start" peer-discovery story lives, plus the bookkeeping needed
 * to not double-connect to the same peer or to ourselves.
 *
 * PeerManager knows nothing about blocks or transactions — it hands fully
 * decoded, post-handshake messages up to whatever `onPeerMessage` callback
 * the caller (gossip.ts, wired together in main.ts) supplies, and offers
 * `broadcast`/`relay` for gossip.ts to push messages back out. Chain
 * decisions stay entirely in gossip.ts, consistent with peer.ts's own
 * separation of concerns.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocket, WebSocketServer } from "ws";
import type { Message } from "@weave/protocol";
import { Peer, type LocalNodeInfo, type PeerDirection } from "./peer";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often we sweep for dead outbound connections to seeds/discovered peers and try to top back up to MIN_OUTBOUND_PEERS. */
export const RECONNECT_INTERVAL_MS = 15_000;
export const MIN_OUTBOUND_PEERS = 3;
export const MAX_INBOUND_PEERS = 64;
export const MAX_TOTAL_PEERS = 128;

export interface PeerManagerOptions {
  local: LocalNodeInfo;
  /** Hardcoded bootstrap peers, e.g. ["wss://seed1.weave.example:8433"] — the build spec's starting point for discovery. */
  seedAddresses: string[];
  minOutboundPeers?: number;
  maxInboundPeers?: number;
  maxTotalPeers?: number;
  onPeerReady?: (peer: Peer) => void;
  onPeerMessage?: (peer: Peer, message: Message) => void;
  onPeerDisconnect?: (peer: Peer, reason: string) => void;
  onPeerMisbehavior?: (peer: Peer, reason: string) => void;
  /** Injectable for tests; defaults to the real `ws` WebSocket constructor. */
  connect?: (address: string) => WebSocket;
}

/**
 * A single WebSocket address, normalized so "same peer dialed twice" is
 * detectable even if one copy has a trailing slash etc.
 */
function normalizeAddress(address: string): string {
  return address.trim().replace(/\/+$/, "");
}

export class PeerManager {
  private readonly local: LocalNodeInfo;
  private readonly options: Required<Pick<PeerManagerOptions, "minOutboundPeers" | "maxInboundPeers" | "maxTotalPeers">>;
  private readonly seedAddresses: string[];
  private readonly connectFn: (address: string) => WebSocket;

  /** Every currently-connected (any state) peer. */
  private readonly peers = new Set<Peer>();
  /** Outbound addresses we're already connected/connecting to, so we don't dial the same one twice concurrently. */
  private readonly outboundInFlight = new Set<string>();
  /** Addresses learned from peers' `listenAddress`, for discovery beyond the hardcoded seed list. */
  private readonly knownAddresses = new Set<string>();

  private wss: WebSocketServer | undefined;
  private reconnectTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private readonly onPeerReady?: (peer: Peer) => void;
  private readonly onPeerMessage?: (peer: Peer, message: Message) => void;
  private readonly onPeerDisconnect?: (peer: Peer, reason: string) => void;
  private readonly onPeerMisbehavior?: (peer: Peer, reason: string) => void;

  constructor(options: PeerManagerOptions) {
    this.local = options.local;
    this.seedAddresses = options.seedAddresses.map(normalizeAddress);
    for (const addr of this.seedAddresses) this.knownAddresses.add(addr);
    this.options = {
      minOutboundPeers: options.minOutboundPeers ?? MIN_OUTBOUND_PEERS,
      maxInboundPeers: options.maxInboundPeers ?? MAX_INBOUND_PEERS,
      maxTotalPeers: options.maxTotalPeers ?? MAX_TOTAL_PEERS,
    };
    this.onPeerReady = options.onPeerReady;
    this.onPeerMessage = options.onPeerMessage;
    this.onPeerDisconnect = options.onPeerDisconnect;
    this.onPeerMisbehavior = options.onPeerMisbehavior;
    this.connectFn = options.connect ?? ((address: string) => new WebSocket(address));
  }

  // -- Inbound: accept connections on an existing HTTP(S) server -----------

  /**
   * Attaches an inbound WebSocket listener to an already-listening HTTP or
   * HTTPS server (the node's REST API server — see main.ts). Sharing one
   * server/port for REST + P2P keeps a single TLS termination point, which
   * is what "WSS (TLS), not plaintext WS" (Phase 5's last requirement)
   * actually needs in practice: terminate TLS once, at the HTTPS server,
   * and everything riding on it (REST, wallet WS feed, P2P WS) inherits it.
   */
  attachToServer(server: HttpServer | HttpsServer, path = "/p2p"): void {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      if (this.peerCountByDirection("inbound") >= this.options.maxInboundPeers || this.peers.size >= this.options.maxTotalPeers) {
        socket.close(1013, "too many peers");
        return;
      }
      const remoteAddress = req.socket.remoteAddress ?? "unknown";
      this.registerPeer(socket, "inbound", remoteAddress);
    });
  }

  /** Standalone listener, for a node that isn't already running an HTTP server (e.g. a pure P2P-only process, or tests). */
  listenStandalone(port: number, host = "0.0.0.0"): void {
    this.wss = new WebSocketServer({ port, host, path: "/p2p" });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      if (this.peerCountByDirection("inbound") >= this.options.maxInboundPeers || this.peers.size >= this.options.maxTotalPeers) {
        socket.close(1013, "too many peers");
        return;
      }
      const remoteAddress = req.socket.remoteAddress ?? "unknown";
      this.registerPeer(socket, "inbound", remoteAddress);
    });
  }

  // -- Outbound: dial seeds + discovered peers ------------------------------

  /** Dials every seed address immediately, then keeps topping up to `minOutboundPeers` on a timer as connections drop or new addresses are discovered. */
  start(): void {
    for (const addr of this.seedAddresses) this.dial(addr);
    this.reconnectTimer = setInterval(() => this.maintainOutbound(), RECONNECT_INTERVAL_MS);
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    for (const peer of this.peers) peer.close("node shutting down");
    this.peers.clear();
    this.wss?.close();
  }

  private maintainOutbound(): void {
    if (this.closed) return;
    const outboundCount = this.peerCountByDirection("outbound");
    if (outboundCount >= this.options.minOutboundPeers) return;
    if (this.peers.size >= this.options.maxTotalPeers) return;

    const candidates = [...this.knownAddresses].filter(
      (addr) => !this.outboundInFlight.has(addr) && !this.isAlreadyConnectedTo(addr),
    );
    // Simple discovery policy for now (per the build spec: "hardcoded seed
    // nodes to start; DNS seeds or a small discovery API later") — try
    // addresses in the order we learned them.
    for (const addr of candidates) {
      if (this.peerCountByDirection("outbound") >= this.options.minOutboundPeers) break;
      this.dial(addr);
    }
  }

  private dial(address: string): void {
    const normalized = normalizeAddress(address);
    if (this.outboundInFlight.has(normalized) || this.isAlreadyConnectedTo(normalized)) return;
    this.outboundInFlight.add(normalized);

    let socket: WebSocket;
    try {
      socket = this.connectFn(normalized);
    } catch {
      this.outboundInFlight.delete(normalized);
      return;
    }

    const cleanup = () => this.outboundInFlight.delete(normalized);
    socket.once("open", () => {
      cleanup();
      this.registerPeer(socket, "outbound", normalized);
    });
    socket.once("error", cleanup);
    socket.once("close", cleanup);
  }

  private isAlreadyConnectedTo(address: string): boolean {
    for (const peer of this.peers) {
      if (peer.direction === "outbound" && peer.remoteAddress === address) return true;
    }
    return false;
  }

  // -- Shared peer registration ---------------------------------------------

  private registerPeer(socket: WebSocket, direction: PeerDirection, remoteAddress: string): void {
    const peer = new Peer(socket, direction, remoteAddress, this.local, {
      onReady: (p) => {
        // Learn about this peer's advertised listen address for future discovery.
        if (p.advertisedListenAddress) this.knownAddresses.add(normalizeAddress(p.advertisedListenAddress));
        this.onPeerReady?.(p);
      },
      onMessage: (p, msg) => this.onPeerMessage?.(p, msg),
      onDisconnect: (p, reason) => {
        this.peers.delete(p);
        this.onPeerDisconnect?.(p, reason);
      },
      onMisbehavior: (p, reason) => this.onPeerMisbehavior?.(p, reason),
    });
    this.peers.add(peer);
  }

  // -- Queries / broadcast ---------------------------------------------------

  get readyPeers(): Peer[] {
    return [...this.peers].filter((p) => p.isReady);
  }

  get allPeers(): Peer[] {
    return [...this.peers];
  }

  peerCountByDirection(direction: PeerDirection): number {
    let n = 0;
    for (const p of this.peers) if (p.direction === direction && p.state !== "closed") n++;
    return n;
  }

  /** Sends a message to every ready peer. */
  broadcast(message: Message): void {
    for (const peer of this.readyPeers) peer.send(message);
  }

  /** Sends a message to every ready peer except one (typically: the peer we just received the corresponding data from — gossip should propagate outward, not echo straight back). */
  relay(message: Message, exclude: Peer): void {
    for (const peer of this.readyPeers) {
      if (peer !== exclude) peer.send(message);
    }
  }
}

/** Generates a fresh random session nonce for self-connection detection — one per node process, reused across all its peer connections. */
export function generateNodeNonce(): string {
  return randomBytes(8).toString("hex");
}