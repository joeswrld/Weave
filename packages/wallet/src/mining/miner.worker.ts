/**
 * Nonce-search loop for one mining worker (Phase 8). Runs off the main
 * thread so hashing never blocks the UI. Tries the WASM SHA-256d hasher
 * (wasmHasher.ts) first for a real speed boost over pure JS, falling back
 * to a pure-JS @weave/core loop (which itself wraps @noble/hashes) if WASM
 * isn't available or fails to load — mining still works either way, just
 * slower without WASM.
 *
 * Protocol (postMessage):
 *
 *   main -> worker  { type: "work", header: {..}, target: "<64 hex>",
 *                      nonceStart, nonceEnd, workerIndex }
 *   main -> worker  { type: "stop" }
 *   worker -> main  { type: "found", nonce, hash }
 *   worker -> main  { type: "hashrate", workerIndex, hashesPerSecond, hashMode }
 *   worker -> main  { type: "exhausted", workerIndex }  // ran out of the assigned nonce range
 *
 * `hashMode` on the hashrate message ("wasm" | "js") is what minerPool.ts
 * surfaces in the UI ("Mining ... using WebAssembly") — purely
 * informational, doesn't affect correctness.
 */

import { getBlockHashHex, hashMeetsTarget, hashToBigInt, serializeHeader, type BlockHeader } from "@weave/core";
import { loadWasmHasher } from "./wasmHasher";

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

const HASHRATE_REPORT_INTERVAL_MS = 1000;

// A monotonically increasing token identifying the *current* search. Every
// "work" (and "stop") message bumps this, and every in-flight step() loop
// captures the generation it was started with and stops itself the moment
// it no longer matches — this is what actually cancels a running search,
// rather than a single shared boolean. A plain `stopped` flag isn't enough
// here: the WASM path's loadWasmHasher() await means a new "work" message
// can arrive (and reset a shared flag to "running") before an older
// runSearch() call has even started its loop, which would otherwise leave
// two searches racing each other on the same worker.
let generation = 0;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Loaded once per worker and reused for every "work" message — instantiating
// the WASM module on every candidate would be wasteful and pointless since
// the module itself carries no per-candidate state.
const hasherPromise = loadWasmHasher();

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  generation += 1;
  if (msg.type === "stop") return;
  void runSearch(msg, generation);
};

async function runSearch(work: WorkMessage, myGeneration: number): Promise<void> {
  const prevHash = hexToBytes(work.header.prevHashHex);
  const merkleRoot = hexToBytes(work.header.merkleRootHex);

  const wasm = await hasherPromise;
  if (myGeneration !== generation) return; // superseded while WASM was loading

  let nonce = work.nonceStart;
  let hashesThisWindow = 0;
  let windowStart = performance.now();

  if (wasm) {
    // The 80-byte header is fixed for this whole candidate except its last
    // 4 bytes (the nonce), which the WASM module itself overwrites on every
    // attempt (see wasmHasher.ts's memory-layout doc comment) — built once
    // here rather than per-nonce.
    const headerBytes = serializeHeader({
      version: work.header.version,
      prevHash,
      merkleRoot,
      timestamp: work.header.timestamp,
      difficultyTarget: work.header.difficultyTarget,
      nonce: 0,
    });

    // Much larger than the JS batch size below: WASM does a batch's worth
    // of hashing synchronously inside one call, so the batch size is what
    // controls how long we go between yields back to the event loop (for
    // "stop" responsiveness and hashrate reporting) — orders of magnitude
    // faster per-hash than JS means this needs to be orders of magnitude
    // bigger to land in a similar wall-clock window per batch.
    const WASM_BATCH = 300_000;

    const step = () => {
      if (myGeneration !== generation) return;

      const batchEnd = Math.min(nonce + WASM_BATCH, work.nonceEnd);
      const result = wasm.search(headerBytes, work.targetHex, nonce, batchEnd);
      hashesThisWindow += batchEnd - nonce;
      nonce = batchEnd;

      if (result) {
        (self as unknown as Worker).postMessage({ type: "found", nonce: result.nonce, hash: result.hashHex });
        return;
      }

      const now = performance.now();
      if (now - windowStart >= HASHRATE_REPORT_INTERVAL_MS) {
        const hashesPerSecond = (hashesThisWindow / (now - windowStart)) * 1000;
        (self as unknown as Worker).postMessage({
          type: "hashrate",
          workerIndex: work.workerIndex,
          hashesPerSecond,
          hashMode: "wasm",
        });
        hashesThisWindow = 0;
        windowStart = now;
      }

      if (nonce >= work.nonceEnd) {
        (self as unknown as Worker).postMessage({ type: "exhausted", workerIndex: work.workerIndex });
        return;
      }

      setTimeout(step, 0);
    };

    step();
    return;
  }

  // Pure-JS fallback: no WASM available (WebAssembly missing, or the
  // module failed to instantiate) — same nonce-search, just hashing one
  // header at a time via @weave/core instead of the batched WASM call.
  const target = BigInt("0x" + work.targetHex);

  const step = () => {
    if (myGeneration !== generation) return;

    // Small batches so a "stop" (or superseding "work") message posted
    // from the main thread is actually seen promptly — a tight
    // synchronous loop over the whole nonce range would never yield, and
    // "Start mining" -> "Stop mining" would feel frozen.
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
        hashMode: "js",
      });
      hashesThisWindow = 0;
      windowStart = now;
    }

    if (nonce >= work.nonceEnd) {
      (self as unknown as Worker).postMessage({ type: "exhausted", workerIndex: work.workerIndex });
      return;
    }

    setTimeout(step, 0);
  };

  step();
}

// hashToBigInt is imported for callers of this module that want to display
// the numeric hash value (e.g. a debug panel) without recomputing it —
// re-exported so it isn't flagged as an unused import.
export { hashToBigInt };