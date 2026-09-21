
/**
 * Coordinates a pool of miner.worker.ts instances against a node's
 * get-work/submit-block API (Phase 8). Scales worker count to
 * navigator.hardwareConcurrency by default, splits the 32-bit nonce space
 * evenly across them, and re-fetches work whenever the chain tip moves
 * (a new block from anyone invalidates the current candidate) or a worker
 * exhausts its assigned nonce range without finding one.
 *
 * This class owns *when* to fetch work and what to do with a found nonce;
 * it does not do any hashing itself (that's the workers) and does not
 * decide whether a submitted block was actually accepted (that's the
 * node — this class just reports what the node said).
 */

import type { RestClient } from "../api/restClient";

export interface MinerStatus {
  running: boolean;
  hashesPerSecond: number;
  workerCount: number;
  blocksFound: number;
  lastResult: { accepted: boolean; hash?: string; reason?: string } | null;
  lastError: string | null;
}

type Listener = (status: MinerStatus) => void;

const NONCE_SPACE = 0x1_0000_0000; // 2^32, full u32 nonce range

export class MinerPool {
  private workers: Worker[] = [];
  private perWorkerHashrate: number[] = [];
  private running = false;
  private blocksFound = 0;
  private lastResult: MinerStatus["lastResult"] = null;
  private lastError: string | null = null;
  private currentWorkVersion = 0;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly rest: RestClient,
    private readonly payoutAddress: string,
    private workerCount: number = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8)),
  ) {}

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const total = this.perWorkerHashrate.reduce((a, b) => a + b, 0);
    const status: MinerStatus = {
      running: this.running,
      hashesPerSecond: total,
      workerCount: this.workerCount,
      blocksFound: this.blocksFound,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
    for (const fn of this.listeners) fn(status);
  }

  setWorkerCount(count: number): void {
    this.workerCount = Math.max(1, count);
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastError = null;
    this.perWorkerHashrate = new Array(this.workerCount).fill(0);

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event) => this.handleWorkerMessage(i, event.data);
      worker.onerror = (event) => {
        this.lastError = event.message || "Mining worker error.";
        this.emit();
      };
      this.workers.push(worker);
    }

    this.emit();
    await this.fetchAndDispatchWork();
  }

  stop(): void {
    this.running = false;
    if (this.refetchTimer) {
      clearTimeout(this.refetchTimer);
      this.refetchTimer = null;
    }
    for (const w of this.workers) {
      w.postMessage({ type: "stop" });
      w.terminate();
    }
    this.workers = [];
    this.perWorkerHashrate = [];
    this.emit();
  }

  /** Call when the wallet's live feed reports a new block from anyone —
   * the current candidate's prevHash is now stale. */
  notifyNewTip(): void {
    if (this.running) void this.fetchAndDispatchWork();
  }

  private async fetchAndDispatchWork(): Promise<void> {
    if (!this.running) return;
    this.currentWorkVersion += 1;
    const version = this.currentWorkVersion;

    let work;
    try {
      work = await this.rest.getWork(this.payoutAddress);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.emit();
      // Retry shortly rather than giving up — the node may just be busy or
      // briefly unreachable (e.g. a Render free-tier cold start).
      this.refetchTimer = setTimeout(() => void this.fetchAndDispatchWork(), 5000);
      return;
    }
    if (version !== this.currentWorkVersion || !this.running) return;

    this.lastError = null;
    const sliceSize = Math.floor(NONCE_SPACE / this.workerCount);
    this.workers.forEach((worker, i) => {
      const nonceStart = i * sliceSize;
      const nonceEnd = i === this.workerCount - 1 ? NONCE_SPACE : nonceStart + sliceSize;
      worker.postMessage({
        type: "work",
        header: {
          version: work.header.version,
          prevHashHex: work.header.prevHash,
          merkleRootHex: work.header.merkleRoot,
          timestamp: work.header.timestamp,
          difficultyTarget: work.header.difficultyTarget,
        },
        targetHex: work.target,
        nonceStart,
        nonceEnd,
        workerIndex: i,
      });
    });

    (this as unknown as { currentBlockHex: string }).currentBlockHex = work.blockHex;
    this.emit();
  }

  private async handleWorkerMessage(workerIndex: number, data: any): Promise<void> {
    if (data.type === "hashrate") {
      this.perWorkerHashrate[workerIndex] = data.hashesPerSecond;
      this.emit();
      return;
    }

    if (data.type === "exhausted") {
      // This worker's slice is done with no luck. At real-world browser
      // hashrates the full 2^32 space searched by all workers combined
      // still vastly exceeds what's needed before the next block arrives
      // from the network, so simply re-fetching fresh work (new timestamp,
      // full nonce space again) is the right move rather than treating
      // this as an error.
      if (this.running) void this.fetchAndDispatchWork();
      return;
    }

    if (data.type === "found") {
      // Stop every worker immediately — no point burning battery/CPU on a
      // candidate that's about to be superseded either way.
      for (const w of this.workers) w.postMessage({ type: "stop" });

      const currentBlockHex = (this as unknown as { currentBlockHex?: string }).currentBlockHex;
      if (!currentBlockHex) return;

      const blockWithNonce = patchNonceInBlockHex(currentBlockHex, data.nonce);
      try {
        const result = await this.rest.submitBlock(blockWithNonce);
        this.lastResult = { accepted: result.ok, hash: result.hash, reason: result.reason };
        if (result.ok) this.blocksFound += 1;
      } catch (err) {
        this.lastResult = { accepted: false, reason: (err as Error).message };
      }
      this.emit();

      // Whether accepted or not, the candidate is spent — get fresh work.
      if (this.running) void this.fetchAndDispatchWork();
    }
  }
}

/**
 * The node hands out `blockHex` with nonce=0 in the header (see
 * getWork.ts: it serializes the freshly-assembled candidate before any
 * mining happens). The header's nonce is the last 4 bytes of the 80-byte
 * header, which is itself the first 80 bytes of the block — so patching
 * it in place is a fixed-offset byte write, no need to deserialize and
 * re-serialize the whole block (with its potentially many transactions)
 * just to change one field.
 */
function patchNonceInBlockHex(blockHex: string, nonce: number): string {
  const bytes = new Uint8Array(blockHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(blockHex.substr(i * 2, 2), 16);

  const NONCE_OFFSET = 4 + 32 + 32 + 4 + 4; // version + prevHash + merkleRoot + timestamp + difficultyTarget
  const view = new DataView(bytes.buffer);
  view.setUint32(NONCE_OFFSET, nonce, true); // little-endian, matches block.ts's writeHeader

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
