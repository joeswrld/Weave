
/**
 * Nonce-search loop for one mining worker (Phase 8). Runs off the main
 * thread so hashing never blocks the UI. Pure-JS SHA-256d for now (via
 * @weave/core, which itself wraps @noble/hashes) — the build spec calls
 * WASM compilation of the hash function "optional" for a real speed boost;
 * this worker is written so a WASM hasher could be dropped in later
 * without changing the message protocol below.
 *
 * Protocol (postMessage), all plain objects so this also works if a WASM
 * hasher is swapped in behind the same interface:
 *
 *   main -> worker  { type: "work", header: {..}, target: "<64 hex>",
 *                      nonceStart, nonceEnd, workerIndex }
 *   main -> worker  { type: "stop" }
 *   worker -> main  { type: "found", nonce, hash }
 *   worker -> main  { type: "hashrate", workerIndex, hashesPerSecond }
 *   worker -> main  { type: "exhausted", workerIndex }  // ran out of the assigned nonce range
 */

import { getBlockHashHex, hashMeetsTarget, hashToBigInt, type BlockHeader } from "@weave/core";

interface WorkMessage {
  type: "work";
  header: Omit<BlockHeader, "nonce" | "prevHash" | "merkleRoot"> & {
    prevHashHex: string;
    merkleRootHex: string;
  };
  targetHex: string;
  nonceStart: number;
  nonceEnd: number;
  workerIndex: number;
}

type InMessage = WorkMessage | { type: "stop" };

let stopped = false;
const HASHRATE_REPORT_INTERVAL_MS = 1000;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === "stop") {
    stopped = true;
    return;
  }
  stopped = false;
  runSearch(msg);
};

function runSearch(work: WorkMessage): void {
  const target = BigInt("0x" + work.targetHex);
  const prevHash = hexToBytes(work.header.prevHashHex);
  const merkleRoot = hexToBytes(work.header.merkleRootHex);

  let nonce = work.nonceStart;
  let hashesThisWindow = 0;
  let windowStart = performance.now();

  const step = () => {
    if (stopped) return;

    // Process in small batches between yielding back to the event loop so
    // a "stop" message posted from the main thread is actually seen
    // promptly (a tight synchronous loop over the whole nonce range would
    // never yield, and "Start mining" -> "Stop mining" would feel frozen).
    const batchEnd = Math.min(nonce + 2000, work.nonceEnd);
    for (; nonce < batchEnd; nonce++) {
      const header: BlockHeader = {
        version: work.header.version,
        prevHash,
        merkleRoot,
        timestamp: work.header.timestamp,
        difficultyTarget: work.header.difficultyTarget,
        nonce,
      };
      const hashHex = getBlockHashHex(header);
      hashesThisWindow++;

      if (hashMeetsTarget(hexToBytes(hashHex), target)) {
        (self as unknown as Worker).postMessage({ type: "found", nonce, hash: hashHex });
        return;
      }
    }

    const now = performance.now();
    if (now - windowStart >= HASHRATE_REPORT_INTERVAL_MS) {
      const hashesPerSecond = (hashesThisWindow / (now - windowStart)) * 1000;
      (self as unknown as Worker).postMessage({
        type: "hashrate",
        workerIndex: work.workerIndex,
        hashesPerSecond,
      });
      hashesThisWindow = 0;
      windowStart = now;
    }

    if (nonce >= work.nonceEnd) {
      (self as unknown as Worker).postMessage({ type: "exhausted", workerIndex: work.workerIndex });
      return;
    }

    if (!stopped) setTimeout(step, 0);
  };

  step();
}

// hashToBigInt is imported for callers of this module that want to display
// the numeric hash value (e.g. a debug panel) without recomputing it —
// re-exported so it isn't flagged as an unused import.
export { hashToBigInt };
