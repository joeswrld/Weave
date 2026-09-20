/**
 * Weave P2P peer session (Phase 5).
 *
 * A `Peer` wraps exactly one WebSocket connection — inbound (someone dialed
 * us) or outbound (we dialed them) — and is deliberately dumb about chain
 * state: it knows how to frame/deframe `@weave/protocol` messages, run the
 * version/verack handshake, and keep the connection alive with ping/pong.
 * It has no idea what a UTXO is. Chain-aware decisions (what to do with an
 * `inv`, whether a `block` is valid) belong to gossip.ts, which sits above
 * this and is handed already-decoded, already-handshaken messages via
 * `onMessage`.
 *
 * This split mirrors the build spec's decentralization model at the code
 * level: a peer's bytes are never trusted at this layer either — decode
 * failures and protocol violations get a `reject` (where sensible) and the
 * connection is dropped, but no message is ever treated as true just
 * because it arrived. That re-verification happens one layer up, in
 * gossip.ts, against this node's own chain state.
 */

import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  decodeMessage,
  encodeMessage,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  type Message,
  type RejectReasonCode,
  type VersionMessage,
} from "@weave/protocol";

// ---------------------------------------------------------------------------
// Config / identity
// ---------------------------------------------------------------------------

/** How long we'll wait for the other side to complete the handshake before giving up. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How often we ping an idle peer, and how long we wait for the pong before dropping it. */
export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 15_000;

export interface LocalNodeInfo {
  userAgent: string;
  /** This node's own random session nonce, used across all its peer connections to detect self-dials. */
  nonce: string;
  genesisHashHex: string;
  /** Where this node accepts inbound connections, if it does (a browser wallet dialing out only would omit this). */
  listenAddress?: string;
  getHeight: () => number;
  getTipHashHex: () => string;
}

export type PeerDirection = "inbound" | "outbound";

export type PeerState =
  | "connecting" // socket open, no version sent/received yet
  | "handshaking" // version sent, waiting on the other side's version/verack
  | "ready" // handshake complete, normal traffic
  | "closed";

export interface PeerEvents {
  /** Fires once, right after the handshake completes. */
  onReady?: (peer: Peer) => void;
  /** Fires for every fully-decoded message once the peer is ready (handshake messages are handled internally, not re-emitted here). */
  onMessage?: (peer: Peer, message: Message) => void;
  onDisconnect?: (peer: Peer, reason: string) => void;
  /** A peer sent something malformed or otherwise misbehaved — informational, the peer gets dropped regardless. */
  onMisbehavior?: (peer: Peer, reason: string) => void;
}

/**
 * Wraps a `ws` WebSocket (works for both the `ws` package's server-side
 * sockets and its client sockets — same interface) as one Weave peer
 * session.
 */
export class Peer {
  readonly direction: PeerDirection;
  readonly remoteAddress: string;
  private readonly socket: WebSocket;
  private readonly local: LocalNodeInfo;
  private readonly events: PeerEvents;

  private _state: PeerState = "connecting";
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPingNonce: string | undefined;
  private lastPingSentAt: number | undefined;

  /** Set once we've received (and validated) the peer's version message. */
  version: VersionMessage | undefined;
  /** Round-trip latency from the most recent completed ping/pong, in ms. */
  lastPingMs: number | undefined;

  constructor(
    socket: WebSocket,
    direction: PeerDirection,
    remoteAddress: string,
    local: LocalNodeInfo,
    events: PeerEvents = {},
  ) {
    this.socket = socket;
    this.direction = direction;
    this.remoteAddress = remoteAddress;
    this.local = local;
    this.events = events;

    this.socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => this.handleRaw(data));
    this.socket.on("close", () => this.teardown("socket closed"));
    this.socket.on("error", (err: Error) => this.teardown(`socket error: ${err.message}`));

    // Outbound connections speak first (matches Bitcoin's convention: the
    // dialer sends its version immediately once the socket is open).
    if (direction === "outbound") {
      this.sendVersion();
    }
    this._state = "handshaking";
    this.handshakeTimer = setTimeout(() => {
      this.teardown("handshake timed out");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  get state(): PeerState {
    return this._state;
  }

  get isReady(): boolean {
    return this._state === "ready";
  }

  /** The address the peer told us it listens on, if any — usable for outbound reconnection/discovery. */
  get advertisedListenAddress(): string | undefined {
    return this.version?.listenAddress;
  }

  get remoteHeight(): number | undefined {
    return this.version?.height;
  }

  get remoteTipHashHex(): string | undefined {
    return this.version?.tipHashHex;
  }

  get userAgent(): string | undefined {
    return this.version?.userAgent;
  }

  // -- Sending -------------------------------------------------------------

  send(message: Message): void {
    if (this._state === "closed") return;
    try {
      this.socket.send(encodeMessage(message));
    } catch {
      this.teardown("send failed");
    }
  }

  private sendVersion(): void {
    const msg: VersionMessage = {
      type: "version",
      protocolVersion: PROTOCOL_VERSION,
      userAgent: this.local.userAgent,
      height: this.local.getHeight(),
      tipHashHex: this.local.getTipHashHex(),
      genesisHashHex: this.local.genesisHashHex,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: this.local.nonce,
      listenAddress: this.local.listenAddress,
    };
    this.send(msg);
  }

  reject(rejectedType: string, reasonCode: RejectReasonCode, reason: string, hashHex?: string): void {
    this.send({ type: "reject", rejectedType, reasonCode, reason, hashHex });
  }

  ping(): void {
    if (!this.isReady) return;
    const nonce = randomBytes(8).toString("hex");
    this.lastPingNonce = nonce;
    this.lastPingSentAt = Date.now();
    this.send({ type: "ping", nonce });
    this.pongTimer = setTimeout(() => this.teardown("pong timeout"), PONG_TIMEOUT_MS);
  }

  close(reason = "local close"): void {
    this.teardown(reason);
    try {
      this.socket.close();
    } catch {
      // already closed, ignore
    }
  }

  // -- Receiving -------------------------------------------------------------

  private handleRaw(data: Buffer | ArrayBuffer | Buffer[]): void {
    let text: string;
    try {
      text = normalizeToString(data);
    } catch {
      this.misbehave("binary message was not valid UTF-8");
      return;
    }
    if (text.length > MAX_MESSAGE_BYTES) {
      this.misbehave(`message exceeds max size of ${MAX_MESSAGE_BYTES} bytes`);
      return;
    }

    let message: Message;
    try {
      message = decodeMessage(text);
    } catch (err) {
      if (err instanceof ProtocolDecodeError) {
        this.misbehave(err.message);
        return;
      }
      throw err;
    }

    this.handleMessage(message);
  }

  private handleMessage(message: Message): void {
    if (this._state === "handshaking") {
      this.handleHandshakeMessage(message);
      return;
    }
    if (this._state !== "ready") return;

    switch (message.type) {
      case "version":
      case "verack":
        // Renegotiating after the handshake isn't supported — ignore rather
        // than tear down, since it's harmless.
        return;
      case "ping":
        this.send({ type: "pong", nonce: message.nonce });
        return;
      case "pong":
        this.handlePong(message.nonce);
        return;
      default:
        this.events.onMessage?.(this, message);
    }
  }

  private handleHandshakeMessage(message: Message): void {
    if (message.type === "version") {
      if (this.version) {
        this.misbehave("duplicate version message");
        return;
      }
      if (message.genesisHashHex !== this.local.genesisHashHex) {
        this.reject("version", "wrong-network", "genesis hash mismatch");
        this.teardown("wrong network (genesis mismatch)");
        return;
      }
      if (message.nonce === this.local.nonce) {
        this.teardown("connected to self");
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.reject("version", "protocol-version", `expected protocol version ${PROTOCOL_VERSION}`);
        this.teardown("incompatible protocol version");
        return;
      }
      this.version = message;

      // Inbound sockets haven't sent their own version yet — do it now, in reply.
      if (this.direction === "inbound") {
        this.sendVersion();
      }
      this.send({ type: "verack" });
      this.maybeCompleteHandshake();
      return;
    }

    if (message.type === "verack") {
      this.maybeCompleteHandshake();
      return;
    }

    this.misbehave(`unexpected message type "${message.type}" before handshake completed`);
  }

  private maybeCompleteHandshake(): void {
    // We consider the handshake usable once we've received the peer's
    // version — verack is an acknowledgement, not a hard gate, which
    // tolerates the two verack messages crossing in flight rather than
    // requiring strict ordering.
    if (!this.version) return;
    if (this._state === "ready") return;

    this._state = "ready";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.events.onReady?.(this);
  }

  private handlePong(nonce: string): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
    if (this.lastPingNonce && nonce === this.lastPingNonce && this.lastPingSentAt) {
      this.lastPingMs = Date.now() - this.lastPingSentAt;
    }
    this.lastPingNonce = undefined;
  }

  private misbehave(reason: string): void {
    this.events.onMisbehavior?.(this, reason);
    this.teardown(`protocol violation: ${reason}`);
  }

  private teardown(reason: string): void {
    if (this._state === "closed") return;
    this._state = "closed";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.events.onDisconnect?.(this, reason);
    try {
      this.socket.close();
    } catch {
      // ignore — already gone
    }
  }
}

function normalizeToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}