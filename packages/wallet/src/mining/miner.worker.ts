/**
 * Nonce-search loop for one mining worker (Phase 8). Runs off the main
 * thread so hashing never blocks the UI.
 *
 * CONCRETE BUG FIXED HERE: this worker used to try wasmHasher.ts's
 * compiled-WASM hasher first, falling back to pure JS only if WASM was
 * unavailable. That WASM module implements plain sha256d — it predates,
 * and does not implement, WPoW-V1 (scrypt(headerBytes,headerBytes) then
 * sha256d — see @weave/core's consensus/wpow-v1.ts), which is now the
 * network's activeConsensusAlgorithm (consensus/active.ts) that
 * checkProofOfWork/ChainState actually enforce (see utxo.ts). A browser
 * miner using the old WASM path was therefore silently searching for
 * sha256d-valid nonces that the real chain would reject as invalid
 * WPoW-V1 proofs — every "found!" from that path was a guaranteed
 * rejected submission.
 *
 * The WASM path is disabled below (loadWasmHasher is never called) until
 * a WPoW-V1 WASM port exists (build order: "WPoW → WASM" is its own
 * phase, not a mechanical fix to fold into this bug fix — scrypt's
 * variable-size memory-hard scratch buffer is a materially different
 * WASM module than a fixed-size sha256d compression loop, and hand-
 * writing/verifying that correctly deserves its own dedicated pass and
 * tests rather than a rushed edit to a hand-written .wat blob here).
 * Every worker now always takes the pure-JS loop below, which already
 * calls @weave/core's real activeConsensusAlgorithm and therefore
 * produces proofs the chain actually accepts. hashMode is now always
 * "js" until that WASM port lands.
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

import { activeConsensusAlgorithm, hashMeetsTarget, hashToBigInt, type BlockHeader } from "@weave/core";

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

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  generation += 1;
  if (msg.type === "stop") return;
  void runSearch(msg, generation);
};

async function runSearch(work: WorkMessage, myGeneration: number): Promise<void> {
  const prevHash = hexToBytes(work.header.prevHashHex);
  const merkleRoot = hexToBytes(work.header.merkleRootHex);

  let nonce = work.nonceStart;
  let hashesThisWindow = 0;
  let windowStart = performance.now();

  // activeConsensusAlgorithm.computeProofHash (WPoW-V1: scrypt then
  // sha256d — see @weave/core's consensus/wpow-v1.ts) is what the chain
  // actually verifies against, so that's what this loop must search
  // with. Small batches so a "stop" (or superseding "work") message
  // posted from the main thread is actually seen promptly — a tight
  // synchronous loop over the whole nonce range would never yield, and
  // "Start mining" -> "Stop mining" would feel frozen. Batch size is
  // deliberately small: WPoW-V1's scrypt step is far more expensive per
  // attempt than plain sha256d was, so even a modest batch already takes
  // noticeably longer wall-clock time between yields.
  const target = BigInt("0x" + work.targetHex);
  const BATCH = 200;

  const step = () => {
    if (myGeneration !== generation) return;

    const batchEnd = Math.min(nonce + BATCH, work.nonceEnd);
    for (; nonce < batchEnd; nonce++) {
      const header: BlockHeader = {
        version: work.header.version,
        prevHash,
        merkleRoot,
        timestamp: work.header.timestamp,
        difficultyTarget: work.header.difficultyTarget,
        nonce,
      };
      const hash = activeConsensusAlgorithm.computeProofHash(header);
      hashesThisWindow++;

      if (hashMeetsTarget(hash, target)) {
        const hashHex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
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