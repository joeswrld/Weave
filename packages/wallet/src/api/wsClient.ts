
/**
 * Live feed client for the node's wallet WebSocket
 * (packages/node/src/api/ws.ts). Handles reconnection with backoff — a
 * browser tab losing/regaining network or the node process restarting are
 * both routine, not exceptional, so the wallet should recover on its own
 * rather than showing a permanently-dead "live" indicator.
 *
 * Wire protocol (matches ws.ts exactly):
 *   client -> {"op":"subscribe","addresses":["<address>"]}
 *   server -> {"type":"hello", ...blockchainInfo}
 *   server -> {"type":"subscribed", count}
 *   server -> {"type":"block"|"tx"|"reorg", ...}
 */

export type WalletFeedEvent =
  | { type: "hello"; [key: string]: unknown }
  | { type: "subscribed"; count: number }
  | { type: "block"; [key: string]: unknown }
  | { type: "tx"; [key: string]: unknown }
  | { type: "reorg"; [key: string]: unknown };

export type ConnectionState = "connecting" | "open" | "closed";

/** Converts an http(s) node base URL into its ws(s) equivalent, e.g.
 * "https://node.example.com" -> "wss://node.example.com". */
function toWsUrl(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/^http/, "ws");
}

export class WalletFeedClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private addresses: string[] = [];
  private state: ConnectionState = "closed";

  private readonly listeners = new Set<(event: WalletFeedEvent) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  constructor(private readonly baseUrl: string) {}

  onEvent(fn: (event: WalletFeedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStateChange(fn: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(state: ConnectionState) {
    this.state = state;
    for (const fn of this.stateListeners) fn(state);
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** Subscribes to just this wallet's address so the feed doesn't push
   * every transaction on the network to every tab. */
  connect(addresses: string[]): void {
    this.closedByUser = false;
    this.addresses = addresses;
    this.open();
  }

  private open(): void {
    this.setState("connecting");
    const ws = new WebSocket(toWsUrl(this.baseUrl));
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("open");
      if (this.addresses.length > 0) {
        ws.send(JSON.stringify({ op: "subscribe", addresses: this.addresses }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WalletFeedEvent;
        for (const fn of this.listeners) fn(parsed);
      } catch {
        // Ignore malformed frames rather than crashing the feed.
      }
    };

    ws.onclose = () => {
      this.setState("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires right after onerror for a failed connection; the
      // reconnect is scheduled there, not here, to avoid double-scheduling.
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delayMs);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
