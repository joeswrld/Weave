// Already implemented
export * from "./consensus-params";
export * from "./fees";

// Phase 1 — core data structures
export * from "./bytes";
export * from "./hash";
export * from "./target";
export * from "./transaction";
export * from "./merkle";
export * from "./block";
export * from "./script";

// Phase 3 — UTXO set & validation
export * from "./utxo";
export * from "./chain";

// Phase 4 — Mining
export * from "./difficulty";
export * from "./consensus";

// Phase 5 — P2P wire protocol (message types + codec) lives in the
// separate @weave/protocol package, not here: core has no business
// knowing about wire framing, and node/wallet both already depend on
// @weave/protocol directly for that.