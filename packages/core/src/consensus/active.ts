/**
 * The single ConsensusAlgorithm the live chain actually runs.
 *
 * This is the integration point that used to be missing: before this file
 * existed, utxo.ts's checkProofOfWork and node/src/miner.ts's mineBlock
 * both called getBlockHash/hashMeetsTarget directly (plain SHA-256d),
 * completely bypassing the ConsensusAlgorithm abstraction in this
 * directory — WPoW-V1 was fully implemented but never actually used by
 * anything that validates or mines a real block.
 *
 * Fixing that is a one-line policy decision (which algorithm is "the"
 * algorithm) plus routing every call site through it, with NO changes to:
 *   - the 80-byte header wire format (block.ts)
 *   - difficulty retargeting (difficulty.ts)
 *   - cumulative-work fork choice (chain.ts, work.ts)
 *   - UTXO/transaction validation (utxo.ts, aside from this one check)
 *
 * activeConsensusAlgorithm is exported (not hardcoded inline at each call
 * site) so a future network parameter change or test override has exactly
 * one place to change, matching how consensus-params.ts's constants are
 * the one place those values live.
 */

import { wpowV1, type WPoWV1Algorithm } from "./wpow-v1";
import type { ConsensusAlgorithm } from "./types";

/**
 * The consensus algorithm every node and wallet on the live Weave network
 * MUST use to validate and mine blocks. Changing which algorithm this is
 * is consensus-critical — exactly like changing a value in
 * consensus-params.ts, it is a hard fork, because a node running a
 * different algorithm computes a different proof hash for the same header
 * and will reject every block the old algorithm's miners produce (and
 * vice versa).
 *
 * WPoW-V1 (see wpow-v1.ts) is the active algorithm, per the project's
 * "integrate the existing WPoW engine first" build order — plain SHA-256d
 * (sha256-pow.ts) remains available as the benchmark reference/control,
 * not as a live alternative.
 */
export const activeConsensusAlgorithm: ConsensusAlgorithm = wpowV1;

/** Convenience re-export so call sites that only need WPoW-V1 specifically (e.g. to read its params) don't have to reach into wpow-v1.ts directly. */
export type { WPoWV1Algorithm };