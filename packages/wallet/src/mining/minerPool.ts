/**
 * Coordinates a pool of miner.worker.ts instances against a node's Phase 8
 * mining API. Scales worker count to navigator.hardwareConcurrency by
 * default, splits the 32-bit nonce space evenly across them, and re-fetches
 * work whenever the chain tip moves (a new block from anyone invalidates
 * the current candidate) or a worker exhausts its assigned nonce range
 * without finding one.
 *
 * Two modes, chosen by the caller (see MiningPanel's mode toggle):
 *   - "solo": talks to /api/getwork + /api/submitblock. Workers search
 *     against the real network target; a find pays this address alone.
 *     Realistic for solo miners only at very low network difficulty.
 *   - "pool": talks to /api/pool/getwork + /api/pool/submitshare, which
 *     hand out and check a much easier "share target" (see the node's
 *     mining-pool.ts). Most finds are just shares (credited work, no
 *     payout yet); occasionally one also clears the real network target
 *     and the pool submits it as a block, paying every contributor of the
 *     current round proportionally. This is the practical way for a
 *     single browser tab to see *any* return before real-world difficulty
 *     makes solo mining a lottery with a vanishingly small ticket.
 *
 * This class owns *when* to fetch work and what to do with a found nonce;
 * it does not do any hashing itself (that's the workers) and does not
 * decide whether a submitted block/share was actually accepted (that's
 * the node — this class just reports what the node said).
 */

import type { GetWorkResponse, PoolGetWorkResponse, PoolStatusResponse, RestClient } from "../api/restClient";

export type MiningMode = "solo" | "pool";

export interface MinerStatus {
  running: boolean;
  mode: MiningMode;
  hashesPerSecond: number;
  workerCount: number;
  /** Solo mode: full blocks this session found and had accepted. Pool
   *  mode: shares this session found (see poolStatus for pool-wide block
   *  finds, which aren't attributable to one session in the UI). */
  blocksFound: number;
  lastResult: { accepted: boolean; hash?: string; reason?: string; wasShare?: boolean } | null;
  lastError: string | null;
  /** Big-endian hex target the workers are actually searching against
   *  right now — the real network target in solo mode, the (easier) share
   *  target in pool mode — so the UI can derive a network-hashrate / ETA
   *  estimate (see lib/format.ts's estimateNetworkHashrate) without a
   *  separate API call. */
  currentTargetHex: string | null;
  /** Whether at least one worker reported using the WASM hasher vs. the
   *  pure-JS fallback — purely informational (see miner.worker.ts). */
  hashMode: "wasm" | "js" | null;
  /** Pool mode only: the current round's contributors and this session's
   *  share of it, polled from /api/pool/status. Null in solo mode or
   *  before the first poll completes. */
  poolStatus: PoolStatusResponse | null;
}

type Listener = (status: MinerStatus) => void;

const NONCE_SPACE = 0x1_0000_0000; // 2^32, full u32 nonce range
const POOL_STATUS_POLL_MS = 5000;

export class MinerPool {
  private workers: Worker[] = [];
  private perWorkerHashrate: number[] = [];
  private running = false;
  private blocksFound = 0;
  private lastResult: MinerStatus["lastResult"] = null;
  private lastError: string | null = null;
  private currentWorkVersion = 0;
  private currentTargetHex: string | null = null;
  private currentShareTarget: string | null = null; // pool mode: what workers actually search against
  private hashMode: MinerStatus["hashMode"] = null;
  private currentBlockHex: string | null = null;
  private poolStatus: PoolStatusResponse | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private poolPollTimer: ReturnType<typeof setInterval> | null = null;
  private poolWorkRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly rest: RestClient,
    private readonly payoutAddress: string,
    private workerCount: number = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8)),
    private mode: MiningMode = "pool",
  ) {}

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const total = this.perWorkerHashrate.reduce((a, b) => a + b, 0);
    const status: MinerStatus = {
      running: this.running,
      mode: this.mode,
      hashesPerSecond: total,
      workerCount: this.workerCount,
      blocksFound: this.blocksFound,
      lastResult: this.lastResult,
      lastError: this.lastError,
      currentTargetHex: this.mode === "pool" ? this.currentShareTarget : this.currentTargetHex,
      hashMode: this.hashMode,
      poolStatus: this.poolStatus,
    };
    for (const fn of this.listeners) fn(status);
  }

  setWorkerCount(count: number): void {
    this.workerCount = Math.max(1, count);
    if (this.running) {
      this.stop();
      void this.start();
    }
  }

  /** Switches between solo and pool mining. Restarts if currently running,
   *  same as changing the worker count — a mode change means a whole new
   *  candidate/target shape, not something to patch in place. */
  setMode(mode: MiningMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.running) {
      this.stop();
      void this.start();
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

    if (this.mode === "pool") {
      void this.pollPoolStatus();
      this.poolPollTimer = setInterval(() => void this.pollPoolStatus(), POOL_STATUS_POLL_MS);
      // The candidate this session searches has its payout coinbase frozen
      // at the getWork call that issued it (see mining-pool.ts's getWork
      // doc comment — the split can't change once nonce search starts).
      // Without this, a session can keep mining one candidate — built from
      // whatever the round looked like at that one moment, sometimes an
      // empty/single-payee round right after a reset — for as long as
      // nonce exhaustion takes, silently excluding every share (this
      // session's own, and every other session's) credited after that
      // candidate was issued. Re-fetching on the same cadence as the
      // status poll keeps that staleness window to a few seconds instead.
      this.poolWorkRefreshTimer = setInterval(() => void this.fetchAndDispatchWork(), POOL_STATUS_POLL_MS);
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
    if (this.poolPollTimer) {
      clearInterval(this.poolPollTimer);
      this.poolPollTimer = null;
    }
    if (this.poolWorkRefreshTimer) {
      clearInterval(this.poolWorkRefreshTimer);
      this.poolWorkRefreshTimer = null;
    }
    for (const w of this.workers) {
      w.postMessage({ type: "stop" });
      w.terminate();
    }
    this.workers = [];
    this.perWorkerHashrate = [];
    this.currentTargetHex = null;
    this.currentShareTarget = null;
    this.hashMode = null;
    this.poolStatus = null;
    this.emit();
  }

  /** Call when the wallet's live feed reports a new block from anyone —
   * the current candidate's prevHash is now stale. */
  notifyNewTip(): void {
    if (this.running) void this.fetchAndDispatchWork();
  }

  private async pollPoolStatus(): Promise<void> {
    if (!this.running || this.mode !== "pool") return;
    try {
      this.poolStatus = await this.rest.getPoolStatus();
      this.emit();
    } catch {
      // Non-fatal: the round-contributors panel just goes stale until the
      // next successful poll; mining itself doesn't depend on this.
    }
  }

  private async fetchAndDispatchWork(): Promise<void> {
    if (!this.running) return;
    this.currentWorkVersion += 1;
    const version = this.currentWorkVersion;

    let work: GetWorkResponse | PoolGetWorkResponse;
    try {
      work = this.mode === "pool" ? await this.rest.getPoolWork(this.payoutAddress) : await this.rest.getWork(this.payoutAddress);
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
    this.currentTargetHex = work.target;
    // "pool" mode responses include the (easier) shareTarget workers should
    // actually search against; solo mode's GetWorkResponse has no such
    // field, so fall back to the real network target.
    const poolShareTarget = (work as Partial<PoolGetWorkResponse>).shareTarget;
    this.currentShareTarget = typeof poolShareTarget === "string" ? poolShareTarget : work.target;
    const searchTarget = this.currentShareTarget!;

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
        targetHex: searchTarget,
        nonceStart,
        nonceEnd,
        workerIndex: i,
      });
    });

    this.currentBlockHex = work.blockHex;
    this.emit();
  }

  private async handleWorkerMessage(workerIndex: number, data: any): Promise<void> {
    if (data.type === "hashrate") {
      this.perWorkerHashrate[workerIndex] = data.hashesPerSecond;
      if (data.hashMode === "wasm" || data.hashMode === "js") this.hashMode = data.hashMode;
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

      const currentBlockHex = this.currentBlockHex;
      if (!currentBlockHex) return;

      if (this.mode === "pool") {
        try {
          const result = await this.rest.submitShare(this.payoutAddress, currentBlockHex, data.nonce);
          if (!result.ok) {
            this.lastResult = { accepted: false, reason: result.reason };
            // The server-side session backing this candidate expired
            // (idle-pruned) between getWork and this submission — the share
            // itself is unrecoverable (it was built against that session's
            // now-gone share target/round state), but silently moving on
            // would let this repeat indefinitely on a long-idle tab,
            // quietly dropping share after share. Force a fresh getWork now
            // rather than waiting for the normal post-submit refetch below,
            // so a new session — and fresh accumulated work — starts
            // immediately instead of after another full nonce-range attempt.
            if (result.reason?.includes("no active session")) {
              this.lastError = "Mining session expired and was refreshed — the last share couldn't be credited.";
            }
          } else if (result.wasBlock) {
            this.lastResult = { accepted: !!result.blockAccepted, hash: result.blockHash, reason: result.blockRejectReason, wasShare: false };
          } else {
            // An ordinary accepted share: credited work, not (yet) a block.
            this.blocksFound += 1; // "shares found" in pool mode — see MinerStatus doc comment
            this.lastResult = { accepted: true, wasShare: true };
          }
          void this.pollPoolStatus();
          // A share just changed this round's accumulated work, but every
          // OTHER worker in this session (and every other session) is still
          // searching a candidate whose coinbase was frozen at its own last
          // getWork call — see mining-pool.ts's getWork doc comment: the
          // payout split can't be edited after a nonce search starts, only
          // baked in before one begins. So the payout a block actually pays
          // is only ever as fresh as the last getWork before it was found.
          // Re-fetching work after every accepted share (not just after
          // this worker's own find, which fetchAndDispatchWork already
          // does below) keeps that staleness window small instead of
          // letting a session mine one candidate — with a stale, possibly
          // single-payee round snapshot — across many shares.
        } catch (err) {
          this.lastResult = { accepted: false, reason: (err as Error).message };
        }
      } else {
        const blockWithNonce = patchNonceInBlockHex(currentBlockHex, data.nonce);
        try {
          const result = await this.rest.submitBlock(blockWithNonce);
          this.lastResult = { accepted: result.ok, hash: result.hash, reason: result.reason };
          if (result.ok) this.blocksFound += 1;
        } catch (err) {
          this.lastResult = { accepted: false, reason: (err as Error).message };
        }
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
 * just to change one field. (Pool mode doesn't need this: submitShare
 * takes the blockHex and nonce separately and patches server-side.)
 */
function patchNonceInBlockHex(blockHex: string, nonce: number): string {
  const bytes = new Uint8Array(blockHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(blockHex.substr(i * 2, 2), 16);

  const NONCE_OFFSET = 4 + 32 + 32 + 4 + 4; // version + prevHash + merkleRoot + timestamp + difficultyTarget
  const view = new DataView(bytes.buffer);
  view.setUint32(NONCE_OFFSET, nonce, true); // little-endian, matches block.ts's writeHeader

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}