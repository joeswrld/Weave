/**
 * Weave P2P wire messages (Phase 5).
 *
 * Every message is a discriminated union tagged by `type`, JSON-serializable
 * except for binary payloads (blocks/transactions), which travel as hex
 * strings so the whole envelope can stay JSON — see codec.ts for why.
 *
 * Message set mirrors Bitcoin's own protocol at a conceptual level (the
 * build spec calls this out explicitly), scaled down to what Weave
 * actually needs:
 *
 *   version / verack   - handshake: who you are, what you have, agree to talk
 *   inv                - "I have these things" (gossip announcement)
 *   getdata            - "send me these things" (fetch what an inv offered)
 *   block              - a full block
 *   tx                 - a full transaction
 *   ping / pong        - liveness check + latency measurement
 *   reject             - "I didn't like what you just sent" (validation failure)
 *
 * None of these carry chain-critical trust: every block/tx received here
 * still goes through full independent validation (@weave/core's
 * validateBlock/validateTransaction) before it's acted on — a peer's
 * message is an invitation to check something, never proof of anything.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** What kind of thing an inv/getdata entry refers to. */
export type InventoryType = "block" | "tx";

export interface InventoryItem {
  type: InventoryType;
  /** Hex hash: block hash for "block", txid for "tx". */
  hashHex: string;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

export interface VersionMessage {
  type: "version";
  protocolVersion: number;
  /** Arbitrary string identifying node software + version, e.g. "weave-node/0.1.0". */
  userAgent: string;
  /** Sender's best-chain height at the time of sending. */
  height: number;
  /** Hex hash of sender's current best-chain tip. */
  tipHashHex: string;
  /** Genesis hash hex — mismatched genesis means "different network", refuse to peer. */
  genesisHashHex: string;
  /** Unix seconds, sender's clock — used for coarse clock-skew detection, not consensus. */
  timestamp: number;
  /** Random nonce so a node can detect and drop a connection to itself. */
  nonce: string;
  /** Address the sender is listening on, if it accepts inbound connections (e.g. "wss://1.2.3.4:8433"). Omitted for a browser wallet that only dials out. */
  listenAddress?: string;
}

export interface VerackMessage {
  type: "verack";
}

// ---------------------------------------------------------------------------
// Gossip: inv / getdata
// ---------------------------------------------------------------------------

/** Announces things the sender has, without sending their full content. */
export interface InvMessage {
  type: "inv";
  items: InventoryItem[];
}

/** Requests the full content of previously-announced (or otherwise known) items. */
export interface GetDataMessage {
  type: "getdata";
  items: InventoryItem[];
}

/**
 * Requests blocks the sender is missing, by describing what it already
 * has: a sparse list of "locator" hashes walking back from its tip
 * (Bitcoin's getblocks/getheaders idea), so the receiver can find the
 * fork point and reply with an inv covering everything after it. Denser
 * near the tip, sparser further back — keeps the locator small even for
 * a long chain.
 */
export interface GetBlocksMessage {
  type: "getblocks";
  /** Hex hashes, sender's chain, most-recent first. */
  locatorHashesHex: string[];
  /** Stop once this hash is reached, or send up to a server-side cap if omitted/unknown. */
  stopHashHex?: string;
}

// ---------------------------------------------------------------------------
// Data payloads
// ---------------------------------------------------------------------------

export interface BlockMessage {
  type: "block";
  /** Full block, canonically serialized (@weave/core's serializeBlock), hex-encoded. */
  blockHex: string;
}

export interface TxMessage {
  type: "tx";
  /** Full transaction, canonically serialized (@weave/core's serializeTransaction), hex-encoded. */
  txHex: string;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export interface PingMessage {
  type: "ping";
  nonce: string;
}

export interface PongMessage {
  type: "pong";
  nonce: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RejectReasonCode =
  | "malformed"
  | "invalid-block"
  | "invalid-tx"
  | "wrong-network"
  | "protocol-version"
  | "duplicate";

export interface RejectMessage {
  type: "reject";
  /** Which message type this is rejecting, e.g. "block", "tx", "version". */
  rejectedType: string;
  reasonCode: RejectReasonCode;
  reason: string;
  /** Hex hash of the offending block/tx, when applicable. */
  hashHex?: string;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type Message =
  | VersionMessage
  | VerackMessage
  | InvMessage
  | GetDataMessage
  | GetBlocksMessage
  | BlockMessage
  | TxMessage
  | PingMessage
  | PongMessage
  | RejectMessage;

export type MessageType = Message["type"];

