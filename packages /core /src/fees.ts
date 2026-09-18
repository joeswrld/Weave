/**
 * Weave (WVE) fee parameters and helpers.
 *
 * Design: a hybrid model — a tiny flat minimum fee that the wallet applies
 * silently by default (so sending WVE "just costs basically nothing" and
 * needs no user decision), plus an optional fee-per-byte bump a user or
 * wallet can add to jump the mempool queue if the network is ever
 * congested. This mirrors Bitcoin's fee-per-byte market for when it's
 * actually needed, without requiring every user to understand it for an
 * ordinary send — consistent with Weave's zero-friction onboarding goal.
 *
 * Fees are paid to whichever miner includes the transaction in a block
 * (like Bitcoin), not burned — this keeps the incentive story simple and
 * matches the browser-mining-pool payout design in packages/node.
 */

import { SMALLEST_UNITS_PER_WVE } from "./consensus-params";

/**
 * Minimum fee (in smallest units) a transaction must pay to be relayed or
 * mined. Deliberately tiny — well below any block reward — so it does its
 * job (basic spam/DoS deterrence) without being a meaningful cost to a
 * normal user. 0.0001 WVE at 8 decimals = 10,000 smallest units.
 */
export const MIN_FEE_SMALLEST_UNITS = Math.floor(
  0.0001 * SMALLEST_UNITS_PER_WVE,
);

/**
 * Optional additional fee rate, in smallest units per byte of serialized
 * transaction size, that a wallet can add on top of MIN_FEE_SMALLEST_UNITS
 * to prioritize a transaction when the mempool is congested. Exposed as an
 * "advanced" control in the wallet UI — not part of the default send flow.
 *
 * Default suggested rate is intentionally low; this is a starting point
 * for the wallet's fee estimator, not a protocol-enforced value (unlike
 * MIN_FEE_SMALLEST_UNITS, which nodes must actually enforce).
 */
export const DEFAULT_PRIORITY_FEE_RATE_PER_BYTE = 1; // smallest units/byte

/**
 * Computes the total fee (in smallest units) a transaction is paying,
 * given its inputs and outputs. Fee = sum(inputs) - sum(outputs); this
 * assumes inputs have already been resolved to their spent-output values
 * via the UTXO set (see utxo.ts), since a raw Transaction alone doesn't
 * carry input amounts.
 */
export function calculateFee(
  totalInputValue: number,
  totalOutputValue: number,
): number {
  const fee = totalInputValue - totalOutputValue;
  if (fee < 0) {
    throw new Error(
      "Invalid transaction: outputs exceed inputs (would create WVE from nothing)",
    );
  }
  return fee;
}

/**
 * Validates that a transaction's fee meets the network minimum. Every node
 * MUST apply this identically as part of transaction/block validation, or
 * the network will disagree about which transactions/blocks are valid.
 */
export function meetsMinimumFee(feeSmallestUnits: number): boolean {
  return feeSmallestUnits >= MIN_FEE_SMALLEST_UNITS;
}

/**
 * Suggests a fee (in smallest units) for a transaction of a given
 * serialized byte size, under normal (non-congested) conditions: just the
 * flat minimum. A wallet's fee estimator can layer
 * DEFAULT_PRIORITY_FEE_RATE_PER_BYTE on top of this when it detects
 * mempool congestion (see packages/node/src/mempool.ts for the
 * prioritization logic nodes use on the receiving end).
 */
export function suggestFee(transactionSizeBytes: number, priority: "normal" | "fast" = "normal"): number {
  if (priority === "normal") {
    return MIN_FEE_SMALLEST_UNITS;
  }
  return MIN_FEE_SMALLEST_UNITS + transactionSizeBytes * DEFAULT_PRIORITY_FEE_RATE_PER_BYTE;
}
