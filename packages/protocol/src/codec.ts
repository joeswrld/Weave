/**
 * Wire encode/decode for Weave P2P messages.
 *
 * Encoding choice: JSON, not a custom binary format. WebSockets already
 * frame messages (no length-prefixing needed, unlike raw TCP), and this is
 * the "more web tech" difference from Bitcoin Core's raw-binary wire
 * protocol the build spec calls out for the P2P layer. Binary payloads
 * (block/tx bytes) are hex-encoded inside the JSON envelope so the whole
 * message stays one JSON value — simple to log, debug, and extend, at the
 * cost of being larger on the wire than packed binary. For Weave's target
 * (browser tabs, modest block sizes, not high-frequency trading) that
 * trade favors debuggability.
 *
 * A peer's bytes are never trusted: decode is strict (throws on anything
 * that isn't a well-formed Message), and higher layers (peer.ts, gossip.ts)
 * treat a decode failure as a protocol violation from that peer, not a
 * crash.
 */

import type {
  BlockMessage,
  GetBlocksMessage,
  GetDataMessage,
  InventoryItem,
  InvMessage,
  Message,
  MessageType,
  PingMessage,
  PongMessage,
  RejectMessage,
  TxMessage,
  VerackMessage,
  VersionMessage,
} from "./messages";

export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

const MESSAGE_TYPES: ReadonlySet<MessageType> = new Set([
  "version",
  "verack",
  "inv",
  "getdata",
  "getblocks",
  "block",
  "tx",
  "ping",
  "pong",
  "reject",
] satisfies MessageType[]);

/** Encodes a Message to a UTF-8 string ready to send over a WebSocket. */
export function encodeMessage(message: Message): string {
  return JSON.stringify(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string") throw new ProtocolDecodeError(`field "${field}" must be a string`);
  return v;
}

function expectNumber(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ProtocolDecodeError(`field "${field}" must be a finite number`);
  }
  return v;
}

function expectOptionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ProtocolDecodeError(`field "${field}" must be a string if present`);
  return v;
}

function isHex(s: string): boolean {
  return s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
}

function expectHex(obj: Record<string, unknown>, field: string): string {
  const v = expectString(obj, field);
  if (!isHex(v)) throw new ProtocolDecodeError(`field "${field}" must be a hex string`);
  return v;
}

function expectInventoryItems(obj: Record<string, unknown>, field: string): InventoryItem[] {
  const v = obj[field];
  if (!Array.isArray(v)) throw new ProtocolDecodeError(`field "${field}" must be an array`);
  if (v.length > MAX_INVENTORY_ITEMS) {
    throw new ProtocolDecodeError(`field "${field}" exceeds max ${MAX_INVENTORY_ITEMS} items`);
  }
  return v.map((item, i) => {
    if (!isRecord(item)) throw new ProtocolDecodeError(`${field}[${i}] must be an object`);
    const type = item.type;
    if (type !== "block" && type !== "tx") {
      throw new ProtocolDecodeError(`${field}[${i}].type must be "block" or "tx"`);
    }
    const hashHex = expectHex(item, "hashHex");
    return { type, hashHex };
  });
}

/** Caps that guard against a malicious/buggy peer sending an absurdly large single message. */
export const MAX_INVENTORY_ITEMS = 5_000;
export const MAX_LOCATOR_HASHES = 200;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024; // 8MB — generous headroom over one block's expected size

/**
 * Decodes and validates a raw string into a Message. Throws
 * ProtocolDecodeError on anything malformed — unknown type, missing or
 * mistyped fields, oversized arrays. Never throws any other error type, so
 * callers can catch ProtocolDecodeError specifically to mean "this peer
 * sent garbage" rather than an internal bug.
 */
export function decodeMessage(raw: string): Message {
  if (raw.length > MAX_MESSAGE_BYTES) {
    throw new ProtocolDecodeError(`message exceeds max size of ${MAX_MESSAGE_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolDecodeError("message is not valid JSON");
  }
  if (!isRecord(parsed)) throw new ProtocolDecodeError("message must be a JSON object");

  const type = parsed.type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type as MessageType)) {
    throw new ProtocolDecodeError(`unknown or missing message type: ${String(type)}`);
  }

  switch (type as MessageType) {
    case "version": {
      const m: VersionMessage = {
        type: "version",
        protocolVersion: expectNumber(parsed, "protocolVersion"),
        userAgent: expectString(parsed, "userAgent"),
        height: expectNumber(parsed, "height"),
        tipHashHex: expectHex(parsed, "tipHashHex"),
        genesisHashHex: expectHex(parsed, "genesisHashHex"),
        timestamp: expectNumber(parsed, "timestamp"),
        nonce: expectString(parsed, "nonce"),
        listenAddress: expectOptionalString(parsed, "listenAddress"),
      };
      return m;
    }
    case "verack":
      return { type: "verack" } satisfies VerackMessage;

    case "inv":
      return { type: "inv", items: expectInventoryItems(parsed, "items") } satisfies InvMessage;

    case "getdata":
      return { type: "getdata", items: expectInventoryItems(parsed, "items") } satisfies GetDataMessage;

    case "getblocks": {
      const locatorRaw = parsed.locatorHashesHex;
      if (!Array.isArray(locatorRaw)) throw new ProtocolDecodeError('"locatorHashesHex" must be an array');
      if (locatorRaw.length === 0) throw new ProtocolDecodeError('"locatorHashesHex" must not be empty');
      if (locatorRaw.length > MAX_LOCATOR_HASHES) {
        throw new ProtocolDecodeError(`"locatorHashesHex" exceeds max ${MAX_LOCATOR_HASHES} entries`);
      }
      const locatorHashesHex = locatorRaw.map((h, i) => {
        if (typeof h !== "string" || !isHex(h)) {
          throw new ProtocolDecodeError(`locatorHashesHex[${i}] must be a hex string`);
        }
        return h;
      });
      const m: GetBlocksMessage = {
        type: "getblocks",
        locatorHashesHex,
        stopHashHex: expectOptionalString(parsed, "stopHashHex"),
      };
      return m;
    }

    case "block":
      return { type: "block", blockHex: expectHex(parsed, "blockHex") } satisfies BlockMessage;

    case "tx":
      return { type: "tx", txHex: expectHex(parsed, "txHex") } satisfies TxMessage;

    case "ping":
      return { type: "ping", nonce: expectString(parsed, "nonce") } satisfies PingMessage;

    case "pong":
      return { type: "pong", nonce: expectString(parsed, "nonce") } satisfies PongMessage;

    case "reject": {
      const reasonCode = expectString(parsed, "reasonCode");
      const validReasons = ["malformed", "invalid-block", "invalid-tx", "wrong-network", "protocol-version", "duplicate"];
      if (!validReasons.includes(reasonCode)) {
        throw new ProtocolDecodeError(`invalid reasonCode: ${reasonCode}`);
      }
      const m: RejectMessage = {
        type: "reject",
        rejectedType: expectString(parsed, "rejectedType"),
        reasonCode: reasonCode as RejectMessage["reasonCode"],
        reason: expectString(parsed, "reason"),
        hashHex: expectOptionalString(parsed, "hashHex"),
      };
      return m;
    }
  }
}
