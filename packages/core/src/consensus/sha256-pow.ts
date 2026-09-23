/**
 * SHA-256d, as a ConsensusAlgorithm.
 *
 * This is a thin adapter, not a reimplementation: computeProofHash calls
 * the same getBlockHash from block.ts that the rest of the codebase (miner.ts,
 * utxo.ts's checkProofOfWork, chain.ts) already uses, and verifyProof calls
 * the same hashMeetsTarget from target.ts. It exists so SHA-256d can serve
 * as the reference/control implementation WPoW-V1 is benchmarked against
 * (see benchmark.ts) through the identical ConsensusAlgorithm interface,
 * with zero risk of behavioral drift from the already-shipped PoW path.
 */

import { getBlockHash, type BlockHeader } from "../block";
import { compactToTarget, hashMeetsTarget } from "../target";
import { calculateNextTarget } from "../difficulty";
import { calculateWork } from "./work";
import type { ConsensusAlgorithm, ConsensusProof, MineOptions, MineResult, RetargetInput } from "./types";

const MAX_NONCE = 0xffff_ffff;

export class Sha256PowAlgorithm implements ConsensusAlgorithm {
  readonly id = "sha256-pow";
  readonly description =
    "Reference/control: double-SHA256 of the 80-byte header, exactly as block.ts/target.ts/utxo.ts already implement it. No changes to that path.";

  computeProofHash(header: BlockHeader): Uint8Array {
    return getBlockHash(header);
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
    const progressInterval = options.progressIntervalHashes ?? 100_000;
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

  calculateWork(difficultyTarget: number): bigint {
    const work = calculateWork(difficultyTarget);
    if (work === null) throw new RangeError("invalid difficultyTarget");
    return work;
  }

  nextDifficultyBits(input: RetargetInput): number {
    // calculateNextTarget already takes exactly this shape (previousBits +
    // the completed interval's first/last timestamps) and is oblivious to
    // which hash function produced those blocks — see types.ts's
    // ConsensusAlgorithm.nextDifficultyBits doc comment for why that's safe
    // to reuse unchanged for a second algorithm.
    return calculateNextTarget(input);
  }
}

export const sha256Pow = new Sha256PowAlgorithm();