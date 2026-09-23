// The pluggable proof-of-work layer — see types.ts's module doc comment.
// Deliberately NOT re-exported from ../index.ts yet: nothing in the live
// chain (chain.ts/utxo.ts/miner.ts) has been switched over to it, so
// exporting it from @weave/core's public surface would advertise an
// integration that doesn't exist yet. Within this package, import from
// "./consensus" (or "./consensus/<file>") directly until that changes;
// there is no package.json "exports" map here for a cross-package
// "@weave/core/consensus" subpath, so don't assume one exists.
export * from "./types";
export * from "./work";
export * from "./sha256-pow";
export * from "./wpow-v1";
export * from "./validate";