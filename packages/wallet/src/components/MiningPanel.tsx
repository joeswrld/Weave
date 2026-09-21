
import { useState } from "react";
import type { MinerStatus } from "../mining/minerPool";
import { formatHashrate } from "../lib/format";

interface MiningPanelProps {
  status: MinerStatus | null;
  onStart: () => void;
  onStop: () => void;
  onWorkerCountChange: (count: number) => void;
}

/**
 * Phase 8 UI: start/stop browser mining, show live hashrate and the
 * outcome of the last submitted block. Deliberately upfront that solo
 * browser mining at real network difficulty is a long-shot per the build
 * spec's own guidance ("be upfront about this rather than overselling
 * it") — no fake ETA-to-block estimate is shown, since at low browser
 * hashrate that number would be wildly misleading (could be hours,
 * days, or never, depending on how much other hashrate is on the network
 * at the same time).
 */
export function MiningPanel({ status, onStart, onStop, onWorkerCountChange }: MiningPanelProps) {
  const maxWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  const [workerCount, setWorkerCount] = useState(Math.min(2, maxWorkers));

  const running = status?.running ?? false;

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
        Mining runs entirely in this tab using Web Workers — closing the tab stops it. Browser
        hashrate is orders of magnitude below dedicated mining hardware, so finding a block
        solo can take a long time and isn't guaranteed. Rewards pay out to this wallet's
        address automatically if a block you mine is accepted.
      </p>
    </div>
  );
}
