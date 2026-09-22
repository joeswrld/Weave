import { useState } from "react";
import { TARGET_BLOCK_TIME_SECONDS } from "@weave/core";
import type { MinerStatus, MiningMode } from "../mining/minerPool";
import { estimateNetworkHashrate, estimateSecondsToBlock, formatEtaSeconds, formatHashrate, shortenAddress } from "../lib/format";

interface MiningPanelProps {
  status: MinerStatus | null;
  onStart: () => void;
  onStop: () => void;
  onWorkerCountChange: (count: number) => void;
  onModeChange: (mode: MiningMode) => void;
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
export function MiningPanel({ status, onStart, onStop, onWorkerCountChange, onModeChange }: MiningPanelProps) {
  const maxWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  const [workerCount, setWorkerCount] = useState(Math.min(2, maxWorkers));

  const running = status?.running ?? false;
  const mode = status?.mode ?? "pool";

  const networkHashrate =
    status?.currentTargetHex ? estimateNetworkHashrate(status.currentTargetHex, TARGET_BLOCK_TIME_SECONDS) : null;
  const etaSeconds =
    running && status && networkHashrate
      ? estimateSecondsToBlock(status.hashesPerSecond, networkHashrate, TARGET_BLOCK_TIME_SECONDS)
      : null;

  return (
    <div className="card">
      <p className="card-label">Mining</p>

      {!running && (
        <div className="mode-toggle">
          <button
            className={`btn ${mode === "pool" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onModeChange("pool")}
          >
            Pool
          </button>
          <button
            className={`btn ${mode === "solo" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onModeChange("solo")}
          >
            Solo
          </button>
        </div>
      )}

      <div className="hashrate-display">
        {status && running ? formatHashrate(status.hashesPerSecond) : "0 H/s"}
      </div>

      <div className="mining-grid">
        <div>
          <div className="mining-stat-label">{mode === "pool" ? "Shares found" : "Blocks found"}</div>
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

      {mode === "pool" && running && status?.poolStatus && (
        <div style={{ marginTop: 4 }}>
          <div className="mining-stat-label">
            Pool round ({status.poolStatus.round.contributors.length} contributor
            {status.poolStatus.round.contributors.length === 1 ? "" : "s"})
          </div>
          {status.poolStatus.round.contributors.length > 0 ? (
            <ul className="pool-round-list">
              {status.poolStatus.round.contributors.map((c) => (
                <li key={c.addressHex} className="pool-round-row">
                  <span>{shortenAddress(c.addressHex, 6, 4)}</span>
                  <span>{c.sharePct.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mining-disclaimer" style={{ marginTop: 4 }}>
              No shares submitted yet this round.
            </p>
          )}
        </div>
      )}

      {status?.lastResult && (
        <div className={`banner ${resultBannerClass(status.lastResult)}`} style={{ marginTop: 12 }}>
          {resultBannerText(status.lastResult)}
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

/**
 * The three outcomes a mining attempt can report (see MinerStatus.lastResult
 * and minerPool.ts's handleWorkerMessage): a plain accepted/rejected block
 * (solo mode, or pool mode when a share also cleared the real network
 * target), or an ordinary accepted share (pool mode's common case — credited
 * work, no payout yet) — each needs its own wording so "share accepted"
 * doesn't read as "you just got paid".
 */
function resultBannerClass(result: NonNullable<MinerStatus["lastResult"]>): string {
  if (result.wasShare) return "banner-success";
  return result.accepted ? "banner-success" : "banner-error";
}

function resultBannerText(result: NonNullable<MinerStatus["lastResult"]>): string {
  if (result.wasShare) return "Share accepted";
  if (result.accepted) return `Block accepted${result.hash ? ` — ${result.hash.slice(0, 12)}…` : ""}`;
  return `Block rejected: ${result.reason ?? "unknown reason"}`;
}