/**
 * Block-header proof-of-work validation, generalized over ConsensusAlgorithm.
 *
 * This mirrors utxo.ts's existing checkProofOfWork (same "return null if OK,
 * else a reason string" convention used throughout block.ts/utxo.ts) but
 * takes the algorithm as a parameter instead of hard-coding SHA-256d. It
 * does NOT replace checkProofOfWork or get wired into ChainState/
 * validateBlock — the live chain keeps using exactly the validation path it
 * already used before this task. This function is the integration point a
 * future change could call from there, once a network is actually ready to
 * run something other than plain SHA-256d; wiring that in is deliberately
 * out of scope here (see the module doc comment in types.ts).
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