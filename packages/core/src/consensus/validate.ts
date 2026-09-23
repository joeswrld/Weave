/**
 * Block-header proof-of-work validation, generalized over ConsensusAlgorithm.
 *
 * utxo.ts's checkProofOfWork (used by ChainState/validateBlock, and
 * therefore by every real block the chain accepts) now IS a thin wrapper
 * around this function, fixed to consensus/active.ts's
 * activeConsensusAlgorithm — same "return null if OK, else a reason
 * string" convention used throughout block.ts/utxo.ts, just generalized
 * over which algorithm produced/checks the proof instead of hard-coding
 * SHA-256d.
 */

import { compactToTarget } from "../target";
import type { BlockHeader } from "../block";
import type { ConsensusAlgorithm } from "./types";

/** Returns null if `header`'s proof-of-work is valid under `algorithm`, else a reason string. */
export function checkProofOfWorkWith(header: BlockHeader, algorithm: ConsensusAlgorithm): string | null {
  const target = compactToTarget(header.difficultyTarget);
  if (target === null) return "invalid difficultyTarget encoding";
  if (!algorithm.verifyProof(header, header.difficultyTarget)) {
    return `block hash does not meet target under ${algorithm.id}`;
  }
  return null;
}