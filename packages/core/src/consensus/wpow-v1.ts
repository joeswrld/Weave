/**
 * WPoW-V1 ("Weave Proof-of-Work, version 1").
 *
 * WPoW-V1 does not invent a new hash function. It composes two established,
 * already-audited primitives that are already dependencies of this
 * codebase via @noble/hashes:
 *
 *   1. scrypt (RFC 7914) as the memory-hard step — the header bytes (with
 *      the candidate nonce baked in) are used as both password and salt,
 *      so the derivation is a pure, deterministic function of the header
 *      alone, with no separate secret.
 *   2. sha256d (this repo's existing double-SHA256, see hash.ts) as a final
 *      compression step over scrypt's output, so the value actually
 *      compared against the target is a plain 256-bit digest in exactly
 *      the same big-endian-integer-vs-target form target.ts already
 *      defines for SHA-256d — no new comparison rule, no new digest width.
 *
 * WPOW_V1_PARAMS (N, r, p) are consensus-critical, exactly like
 * consensus-params.ts's values: every miner and every verifier must use
 * the same numbers or they will compute different digests for the same
 * header and never agree on validity.
 *
 * Honest scope of what this buys, and what it does not:
 *  - scrypt's cost genuinely comes from memory bandwidth/latency, not just
 *    arithmetic throughput, which is scrypt's whole design intent (RFC
 *    7914 §1). That is a real, established property of the primitive.
 *  - This module makes NO claim that WPoW-V1 is ASIC-resistant, GPU-
 *    resistant, or that its chosen (N, r, p) are optimal or even
 *    well-tuned — no such claim is asserted anywhere here, and none should
 *    be inferred. benchmark.ts measures relative cost against SHA-256d on
 *    THIS machine, in THIS pure-JS implementation; it is not a security
 *    analysis and doesn't attempt to be one.
 *  - @noble/hashes' scrypt is pure JS/BigInt-free typed-array code, which
 *    is precisely what makes it run identically in Node and in a browser
 *    (WASM or otherwise) — determinism across environments comes from
 *    using one audited pure-JS implementation everywhere, not from any
 *    property specific to this file.
 */

import { scrypt } from "@noble/hashes/scrypt";
import { serializeHeader, type BlockHeader } from "../block";
import { sha256d } from "../hash";
import { compactToTarget, hashMeetsTarget } from "../target";
import { calculateNextTarget } from "../difficulty";
import { calculateWork } from "./work";
import type { ConsensusAlgorithm, ConsensusProof, MineOptions, MineResult, RetargetInput } from "./types";

const MAX_NONCE = 0xffff_ffff;

/**
 * Consensus-critical scrypt cost parameters for WPoW-V1. Memory used per
 * hash attempt is 128 * N * r bytes: at these defaults, 128 * 1024 * 8 =
 * 1 MiB per attempt. A network actually running WPoW-V1 would fix these
 * forever (changing them is a hard fork, same as any other consensus
 * parameter) — they're exposed as a constructor option here only so tests
 * and the benchmark can use cheaper parameters without duplicating the
 * algorithm's logic.
 */
export interface WPoWV1Params {
  scryptN: number;
  scryptR: number;
  scryptP: number;
  scryptDkLen: number;
}

export const WPOW_V1_PARAMS: WPoWV1Params = Object.freeze({
  scryptN: 1024,
  scryptR: 8,
  scryptP: 1,
  scryptDkLen: 32,
});

/** Bytes of working memory one hash attempt touches, for a given parameter set. */
export function memoryHardnessBytes(params: WPoWV1Params = WPOW_V1_PARAMS): number {
  return 128 * params.scryptN * params.scryptR;
}

/**
 * The deterministic WPoW-V1 proof format: given the 80-byte header
 * (nonce included), the proof hash is sha256d(scrypt(headerBytes,
 * headerBytes, {N, r, p})). Pure function of the header bytes — same
 * header always produces the same digest, so a proof is fully
 * reconstructable from the header alone; nothing else needs to be
 * transmitted or stored to verify it.
 */
export function wpowV1ProofHash(header: BlockHeader, params: WPoWV1Params = WPOW_V1_PARAMS): Uint8Array {
  const headerBytes = serializeHeader(header);
  const memoryHard = scrypt(headerBytes, headerBytes, {
    N: params.scryptN,
    r: params.scryptR,
    p: params.scryptP,
    dkLen: params.scryptDkLen,
  });
  return sha256d(memoryHard);
}

export class WPoWV1Algorithm implements ConsensusAlgorithm {
  readonly id = "wpow-v1";
  readonly description =
    "scrypt(headerBytes, headerBytes) memory-hard step, then sha256d compression. No ASIC/GPU-resistance claim; see this file's header comment.";

  private readonly params: WPoWV1Params;

  // Not a TS parameter-property shorthand on purpose: this file is also run
  // directly via Node's native `--experimental-strip-types` (see
  // benchmark.ts), which doesn't support that syntax.
  constructor(params: WPoWV1Params = WPOW_V1_PARAMS) {
    this.params = params;
  }

  computeProofHash(header: BlockHeader): Uint8Array {
    return wpowV1ProofHash(header, this.params);
  }

  verifyProof(header: BlockHeader, difficultyTarget: number): boolean {
    const target = compactToTarget(difficultyTarget);
    if (target === null) return false;
    return hashMeetsTarget(this.computeProofHash(header), target);
  }

  mine(header: BlockHeader, options: MineOptions = {}): MineResult | null {
    const target = compactToTarget(header.difficultyTarget);
    if (target === null) throw new RangeError("invalid difficultyTarget");

    const startNonce = header.nonce >>> 0;
    const maxAttempts = Math.min(options.maxAttempts ?? MAX_NONCE + 1, MAX_NONCE - startNonce + 1);
    const progressInterval = options.progressIntervalHashes ?? 1_000;
    const started = Date.now();

    for (let i = 0; i < maxAttempts; i++) {
      const nonce = startNonce + i;
      const candidate: BlockHeader = { ...header, nonce };
      const hash = this.computeProofHash(candidate);
      if (hashMeetsTarget(hash, target)) {
        const proof: ConsensusProof = { algorithm: this.id, nonce, hash };
        return { header: candidate, proof, hashesTried: i + 1, elapsedMs: Date.now() - started };
      }
      if (options.onProgress && (i + 1) % progressInterval === 0) options.onProgress(i + 1);
    }
    return null;
  }

  /**
   * Same target-based work formula every algorithm here uses (see work.ts's
   * doc comment on why cost-per-hash doesn't enter into it) — WPoW-V1
   * blocks and SHA-256d blocks are commensurable on a single cumulative-
   * work scale purely through their respective difficultyTargets.
   */
  calculateWork(difficultyTarget: number): bigint {
    const work = calculateWork(difficultyTarget);
    if (work === null) throw new RangeError("invalid difficultyTarget");
    return work;
  }

  /** Identical retarget math to sha256-pow.ts's — see difficulty.ts's calculateNextTarget doc comment for why this is algorithm-agnostic. */
  nextDifficultyBits(input: RetargetInput): number {
    return calculateNextTarget(input);
  }
}

export const wpowV1 = new WPoWV1Algorithm();

/** Cheap parameter set for tests/benchmarks only — NOT a consensus parameter set, never use for an actual chain. */
export const WPOW_V1_TEST_PARAMS: WPoWV1Params = Object.freeze({
  scryptN: 16,
  scryptR: 1,
  scryptP: 1,
  scryptDkLen: 32,
});