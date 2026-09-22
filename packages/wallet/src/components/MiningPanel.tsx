import { useState } from "react";
import { TARGET_BLOCK_TIME_SECONDS } from "@weave/core";
import type { MinerStatus } from "../mining/minerPool";
import { estimateNetworkHashrate, estimateSecondsToBlock, formatEtaSeconds, formatHashrate } from "../lib/format";

interface MiningPanelProps {
  status: MinerStatus | null;
  onStart: () => void;
  onStop: () => void;
  onWorkerCountChange: (count: number) => void;
}

/**
 * Phase 8 UI: start/stop browser mining, show live hashrate and the
 * outcome of the last submitted block. Also shows a rough estimated
 * time-to-block, derived from the current PoW target vs. this tab's own
 * hashrate (see lib/format.ts) — the build spec explicitly asks for this
 * so users understand realistic expectations, so long as it's presented
 * as the rough statistical estimate it is (an expected value, not a
 * countdown) rather than a confident promise. Browser hashrate is orders
 * of magnitude below dedicated mining hardware, so this number is often
 * discouraging by design — that's the honest picture, not a bug in the
 * estimate.
 */
export function MiningPanel({ status, onStart, onStop, onWorkerCountChange }: MiningPanelProps) {
  const maxWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  const [workerCount, setWorkerCount] = useState(Math.min(2, maxWorkers));

  const running = status?.running ?? false;

  const networkHashrate =
    status?.currentTargetHex ? estimateNetworkHashrate(status.currentTargetHex, TARGET_BLOCK_TIME_SECONDS) : null;
  const etaSeconds =
    running && status && networkHashrate
      ? estimateSecondsToBlock(status.hashesPerSecond, networkHashrate, TARGET_BLOCK_TIME_SECONDS)
      : null;

  return (
    <div className="card">
      <p className="card-label">Mining</p>

      <div className="hashrate-display">
        {status && running ? formatHashrate(status.hashesPerSecond) : "0 H/s"}
      </div>

      <div className="mining-grid">
        <div>
          <div className="mining-stat-label">Blocks found</div>
          <div className="mining-stat-value">{status?.blocksFound ?? 0}</div>
        </div>
        <div>
          <div className="mining-stat-label">Workers</div>
          <div className="mining-stat-value">{status?.workerCount ?? workerCount}</div>
        </div>
      </div>

      {running && (
        <div className="mining-grid">
          <div>
            <div className="mining-stat-label">Est. network hashrate</div>
            <div className="mining-stat-value">
              {networkHashrate ? formatHashrate(networkHashrate) : "—"}
            </div>
          </div>
          <div>
            <div className="mining-stat-label">Est. time to find a block</div>
            <div className="mining-stat-value">
              {etaSeconds !== null ? formatEtaSeconds(etaSeconds) : "—"}
            </div>
          </div>
        </div>
      )}

      {!running && (
        <div>
          <label className="mining-stat-label" htmlFor="worker-count">
            Worker threads
          </label>
          <div className="worker-slider">
            <input
              id="worker-count"
              type="range"
              min={1}
              max={maxWorkers}
              value={workerCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWorkerCount(n);
                onWorkerCountChange(n);
              }}
            />
            <span className="mining-stat-value">{workerCount}</span>
          </div>
        </div>
      )}

      {status?.lastResult && (
        <div className={`banner ${status.lastResult.accepted ? "banner-success" : "banner-error"}`} style={{ marginTop: 12 }}>
          {status.lastResult.accepted
            ? `Block accepted${status.lastResult.hash ? ` — ${status.lastResult.hash.slice(0, 12)}…` : ""}`
            : `Block rejected: ${status.lastResult.reason ?? "unknown reason"}`}
        </div>
      )}

      {status?.lastError && (
        <div className="banner banner-error" style={{ marginTop: 12 }}>
          {status.lastError}
        </div>
      )}

      <button
        className={`btn btn-full ${running ? "btn-danger" : "btn-primary"}`}
        style={{ marginTop: 16 }}
        onClick={running ? onStop : onStart}
      >
        {running ? "Stop mining" : "Start mining"}
      </button>

      <p className="mining-disclaimer">
        Mining runs entirely in this tab{status?.hashMode === "wasm" ? " using WebAssembly" : ""} using
        Web Workers — closing the tab stops it. Browser hashrate is orders of magnitude below
        dedicated mining hardware, so the time-to-block figure above is a rough statistical
        estimate, not a promise — real outcomes vary widely around it, and finding a block solo can
        take a long time or may not happen at all. Rewards pay out to this wallet's address
        automatically if a block you mine is accepted.
      </p>
    </div>
  );
}