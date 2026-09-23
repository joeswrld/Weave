// The pluggable proof-of-work layer — see types.ts's module doc comment.
// activeAlgorithm (below) is now wired into the live chain: utxo.ts's
// checkProofOfWork and node/src/miner.ts's mineBlock both delegate to it,
// so this is the actual consensus rule the chain enforces, not a parallel
// unused path.
export * from "./types";
export * from "./work";
export * from "./sha256-pow";
export * from "./wpow-v1";
export * from "./validate";
export * from "./active";