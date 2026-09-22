/**
 * WASM SHA-256d nonce-search hasher (Phase 8's "compile the hashing routine
 * to WebAssembly for a real speed boost over pure JS").
 *
 * Weave's PoW is sha256d(80-byte header) — see @weave/core's block.ts and
 * hash.ts — read as a big-endian 256-bit integer and compared against a
 * target. This module implements exactly that in a small hand-written WASM
 * module (source: tools/sha256d.wat in the monorepo's build notes; compiled
 * with wabt and embedded below as base64 so no build-time WASM toolchain is
 * needed to build the wallet itself) and exposes a batched `search()` that
 * miner.worker.ts calls in place of its pure-JS loop.
 *
 * Correctness: the compiled module's double-SHA256 output was verified
 * byte-for-byte against @noble/hashes/sha256 (the same library
 * @weave/core's hash.ts itself wraps) across hundreds of random 80-byte
 * headers, plus an end-to-end nonce-search comparison against a brute-force
 * JS reference, before being embedded here.
 *
 * Memory layout (all offsets into the module's exported "mem", a plain
 * ArrayBuffer the caller writes into directly — no (de)serialization on the
 * hot path):
 *   0..80    the 80-byte header; bytes [76..80) are the nonce field
 *            (little-endian u32, matching writeHeader's writeU32LE(nonce))
 *            and are overwritten every attempt by the module itself
 *   80..112  32-byte PoW target, BIG-ENDIAN (matches getWork's `target` /
 *            `shareTarget` hex, which are already big-endian — no
 *            byte-swapping needed on the way in)
 *   112..144 the winning 32-byte digest, written only when found() returns
 *            a nonce (also readable any time via hashOnce(), e.g. for
 *            debugging)
 */

// Compiled from a hand-written WAT module implementing SHA-256 (FIPS 180-4)
// specialized for this hot loop's two fixed-length inputs (an 80-byte
// header, then its 32-byte digest) — see this file's header comment for how
// it was validated. Kept as one opaque base64 blob rather than checked in
// as a separate .wasm asset so the wallet has zero extra build-pipeline
// steps to produce or ship it.
const WASM_BASE64 =
  "AGFzbQEAAAABGAVgAn9/AX9gAX8Bf2ACf38AYAF/AGAAAAMLCgABAgMEAgIAAAQFAwEABAZyD38AQYAEC38AQYAIC38AQYAgC38AQefMp9AGC38AQYXdntt7C38AQfLmu+MDC38AQbrqv6p6C38AQf+kuYgFC38AQYzRldh5C38AQauzj/wBC38AQZmag98FC38AQQALfwBB0AALfwBBwBELfwBB8AALBxsDA21lbQIABnNlYXJjaAAICGhhc2hPbmNlAAkKzQoKEAAgACABdiAAQSAgAWt0cgsrACAALQAAQRh0IABBAWotAABBEHRyIABBAmotAABBCHQgAEEDai0AAHJyCzAAIAAgAUEYdjoAACAAQQFqIAFBEHY6AAAgAEECaiABQQh2OgAAIABBA2ogAToAAAvbBAEPf0EAIQECQANAIAFBEE8NASMAIAFBBGxqIAAgAUEEbGoQATYCACABQQFqIQEMAAsLQRAhAQJAA0AgAUHAAE8NASMAIAFBBGxqIQ4gDkE8aygCAEEHEAAgDkE8aygCAEESEABzIA5BPGsoAgBBA3ZzIQIgDkEIaygCAEEREAAgDkEIaygCAEETEABzIA5BCGsoAgBBCnZzIQMgDiAOQcAAaygCACACaiAOQRxrKAIAIANqajYCACABQQFqIQEMAAsLIwEoAgAhBiMBQQRqKAIAIQcjAUEIaigCACEIIwFBDGooAgAhCSMBQRBqKAIAIQojAUEUaigCACELIwFBGGooAgAhDCMBQRxqKAIAIQ1BACEBAkADQCABQcAATw0BIwIgAUEEbGooAgAhDyMAIAFBBGxqKAIAIQ4gCkEGEAAgCkELEABzIApBGRAAcyEDIA0gA2ogCiALcSAKQX9zIAxxcyAPIA5qamohBCAGQQIQACAGQQ0QAHMgBkEWEABzIQIgAiAGIAdxIAYgCHEgByAIcXNzaiEFIAwhDSALIQwgCiELIAkgBGohCiAIIQkgByEIIAYhByAEIAVqIQYgAUEBaiEBDAALCyMBIwEoAgAgBmo2AgAjAUEEaiMBQQRqKAIAIAdqNgIAIwFBCGojAUEIaigCACAIajYCACMBQQxqIwFBDGooAgAgCWo2AgAjAUEQaiMBQRBqKAIAIApqNgIAIwFBFGojAUEUaigCACALajYCACMBQRhqIwFBGGooAgAgDGo2AgAjAUEcaiMBQRxqKAIAIA1qNgIAC08AIwEjAzYCACMBQQRqIwQ2AgAjAUEIaiMFNgIAIwFBDGojBjYCACMBQRBqIwc2AgAjAUEUaiMINgIAIwFBGGojCTYCACMBQRxqIwo2AgALvQEBAX9BgBAhAhAEIAAQAyACQQBBwAD8CwAgAiAAQcAAakEQ/AoAACACQRBqQYABOgAAIAJBPmpBAjoAACACQT9qQYABOgAAIAIQAyABIwEoAgAQAiABQQRqIwFBBGooAgAQAiABQQhqIwFBCGooAgAQAiABQQxqIwFBDGooAgAQAiABQRBqIwFBEGooAgAQAiABQRRqIwFBFGooAgAQAiABQRhqIwFBGGooAgAQAiABQRxqIwFBHGooAgAQAgu0AQEBf0GAESECIAJBAEHAAPwLACACIABBIPwKAAAgAkEgakGAAToAACACQT5qQQE6AAAgAkE/akEAOgAAEAQgAhADIAEjASgCABACIAFBBGojAUEEaigCABACIAFBCGojAUEIaigCABACIAFBDGojAUEMaigCABACIAFBEGojAUEQaigCABACIAFBFGojAUEUaigCABACIAFBGGojAUEYaigCABACIAFBHGojAUEcaigCABACC0oBA39BACECAkADQCACQSBPDQEgACACai0AACEDIAEgAmotAAAhBCADIARJBEBBAQ8LIAMgBEsEQEEADwsgAkEBaiECDAALC0EBC2EBAX8gACECAkADQCACIAFPDQFBzAAgAjoAAEHNACACQQh2OgAAQc4AIAJBEHY6AABBzwAgAkEYdjoAACMLIw0QBSMNIw4QBiMOIwwQBwRAIAIPCyACQQFqIQIMAAsLQX8LDgAjCyMNEAUjDSMOEAYLC4gCAQBBgCALgAKYL4pCkUQ3cc/7wLWl27XpW8JWOfER8Vmkgj+S1V4cq5iqB9gBW4MSvoUxJMN9DFV0Xb5y/rHegKcG3Jt08ZvBwWmb5IZHvu/GncEPzKEMJG8s6S2qhHRK3KmwXNqI+XZSUT6YbcYxqMgnA7DHf1m/8wvgxkeRp9VRY8oGZykpFIUKtyc4IRsu/G0sTRMNOFNUcwpluwpqdi7JwoGFLHKSoei/oktmGqhwi0vCo1FsxxnoktEkBpnWhTUO9HCgahAWwaQZCGw3Hkx3SCe1vLA0swwcOUqq2E5Pypxb828uaO6Cj3RvY6V4FHjIhAgCx4z6/76Q62xQpPej+b7yeHHG";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface Sha256dExports {
  mem: WebAssembly.Memory;
  search: (nonceStart: number, nonceEnd: number) => number;
  hashOnce: () => void;
}

export interface WasmHasher {
  /**
   * Writes `header` (80 bytes, nonce field ignored) and `targetHex` (64
   * hex chars, big-endian) into WASM memory, then searches nonces in
   * [nonceStart, nonceEnd) for one whose sha256d meets the target.
   * Returns the winning { nonce, hashHex }, or null if the whole range
   * was exhausted without success. Synchronous and allocation-free per
   * call (reuses the module's linear memory) — the caller (miner.worker.ts)
   * is responsible for calling this in small-enough batches to still yield
   * to the event loop between calls, same as the pure-JS fallback does.
   */
  search(header: Uint8Array, targetHex: string, nonceStart: number, nonceEnd: number): { nonce: number; hashHex: string } | null;
}

let cached: Promise<WasmHasher | null> | null = null;

/**
 * Compiles and instantiates the embedded WASM module once per worker
 * (cached), returning null (rather than throwing) if WebAssembly isn't
 * available or instantiation fails for any reason — callers treat that as
 * "fall back to the pure-JS loop", never as a fatal error, since mining
 * works fine (just slower) without WASM.
 */
export function loadWasmHasher(): Promise<WasmHasher | null> {
  if (!cached) cached = doLoad();
  return cached;
}

async function doLoad(): Promise<WasmHasher | null> {
  try {
    if (typeof WebAssembly === "undefined") return null;
    const bytes = base64ToBytes(WASM_BASE64);
    // Explicit result typing: with both "DOM" and "WebWorker" libs loaded
    // (this file runs inside miner.worker.ts), TS's overload resolution
    // for WebAssembly.instantiate(bufferSource, importObject) picks the
    // wrong overload and infers `Instance` instead of
    // `WebAssemblyInstantiatedSource`, dropping `.instance`. Asserting the
    // (correct, spec-accurate) result type sidesteps that ambiguity rather
    // than changing shared lib config for the whole wallet package.
    const result = (await WebAssembly.instantiate(bytes, {})) as WebAssembly.WebAssemblyInstantiatedSource;
    const exports = result.instance.exports as unknown as Sha256dExports;
    const mem = new Uint8Array(exports.mem.buffer);

    return {
      search(header, targetHex, nonceStart, nonceEnd) {
        mem.set(header.subarray(0, 80), 0);
        for (let i = 0; i < 32; i++) {
          mem[80 + i] = parseInt(targetHex.substr(i * 2, 2), 16);
        }
        // The WASM search() param is an i32, so a nonceEnd of exactly 2^32
        // (the top worker slice's exclusive upper bound over the full u32
        // nonce space — see minerPool.ts's NONCE_SPACE) would wrap to 0 and
        // break the loop. Clamping to 0xFFFFFFFF costs at most one
        // never-tried nonce (0xFFFFFFFF itself) out of four billion per
        // work unit — negligible, and it also means -1 (0xffffffff as u32)
        // is unambiguously the "not found" sentinel below, since a real
        // found nonce can now never equal it.
        const clampedEnd = Math.min(nonceEnd, 0xffff_ffff);
        const nonce = exports.search(nonceStart, clampedEnd) >>> 0;
        if (nonce === 0xffff_ffff) return null; // exhausted, nothing found
        const hashBytes = mem.slice(112, 144);
        const hashHex = Array.from(hashBytes, (b) => b.toString(16).padStart(2, "0")).join("");
        return { nonce, hashHex };
      },
    };
  } catch {
    return null;
  }
}