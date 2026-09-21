/**
 * Thin REST client for a Weave node's HTTP API (packages/node/src/api/rest.ts,
 * getWork.ts). Every method here maps 1:1 onto an actual route the node
 * exposes — see NODE_URL usage in App.tsx for where the base URL comes from.
 *
 * Amounts arrive from the node as decimal strings of smallest units (the
 * node avoids JSON-unsafe bigints), so callers that need bigint math
 * (balances, tx building) should BigInt(...) them at the boundary rather
 * than doing arithmetic on the strings themselves.
 */

export interface BlockchainInfo {
  height: number;
  tipHash: string;
  difficultyBits: number;
  [key: string]: unknown;
}

export interface BalanceResponse {
  address: string;
  balance: string; // smallest units
  immature: string;
  utxoCount: number;
}

export interface UtxoResponse {
  txid: string;
  outputIndex: number;
  value: string; // smallest units
  lockingScript: string; // hex
  blockHeight: number;
  coinbase: boolean;
  confirmations: number;
  spendable: boolean;
}

export interface TxSummary {
  txid: string;
  version: number;
  size: number;
  inputs: { prevTxId: string; outputIndex: number }[];
  outputs: { n: number; value: string; lockingScript: string }[];
}

export interface BlockSummary {
  hash: string;
  height: number;
  confirmations: number;
  size: number;
  header: Record<string, unknown>;
  txids: string[];
  tx: TxSummary[];
}

export interface GetWorkResponse {
  height: number;
  prevHash: string;
  difficultyBits: number;
  target: string; // 64-hex-char big-endian target
  header: {
    version: number;
    prevHash: string;
    merkleRoot: string;
    timestamp: number;
    difficultyTarget: number;
    nonce: number;
  };
  blockHex: string;
  totalFees: string;
}

export interface SubmitBlockResponse {
  ok: boolean;
  reason?: string;
  hash?: string;
}

export class WeaveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Small wrapper so every wallet component talks to the node through one
 * object (this class), rather than each component hardcoding fetch() and
 * the base URL separately — which is what makes it possible to point the
 * whole wallet at a different node later by constructing one instance
 * differently.
 */
export class RestClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new WeaveApiError(
        `Could not reach node at ${this.baseUrl} (${(err as Error).message}).`,
        0,
      );
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new WeaveApiError(body?.error ?? `Request failed (${res.status})`, res.status);
    }
    return body as T;
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.request("/api/blockchaininfo");
  }

  getBalance(address: string): Promise<BalanceResponse> {
    return this.request(`/api/balance/${encodeURIComponent(address)}`);
  }

  listUnspent(address: string): Promise<UtxoResponse[]> {
    return this.request(`/api/utxos/${encodeURIComponent(address)}`);
  }

  getBlock(idOrHeight: string | number): Promise<BlockSummary> {
    return this.request(`/api/block/${encodeURIComponent(String(idOrHeight))}`);
  }

  /**
   * Broadcasts a signed transaction, hex-encoded. `hex` should already be
   * @weave/core's serializeTransaction() output, converted to hex by the
   * caller (txBuilder.ts).
   */
  sendRawTransaction(hex: string): Promise<{ txid: string }> {
    return this.request("/api/tx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hex }),
    });
  }

  getWork(address: string): Promise<GetWorkResponse> {
    return this.request(`/api/getwork/${encodeURIComponent(address)}`);
  }

  submitBlock(blockHex: string): Promise<SubmitBlockResponse> {
    return this.request("/api/submitblock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockHex }),
    });
  }
}
WEAVE_EOF
echo done
Output

done

