/**
 * Weave (WVE) fee parameters and helpers.
 *
 * Fee model (consensus-critical — see the module doc comments on
 * MIN_FEE_SMALLEST_UNITS's successors below for exactly which parts every
 * node MUST enforce identically):
 *
 *   totalFee        = baseFee + priorityFee
 *   baseFee         = BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS × signatureCount
 *   totalSenderCost = amountSent + baseFee + priorityFee
 *
 * A transaction's signatureCount is the number of signatures its inputs
 * carry — one per P2PKH input in this script model (see
 * transaction.ts's countSignatures). A base fee that scales with signature
 * count, rather than a flat per-transaction amount, means the fee tracks
 * the actual signature-verification cost the network pays to accept the
 * transaction: a 1-input send and a 10-input consolidation don't cost a
 * node the same amount of work, so they shouldn't cost the sender the same
 * fee either.
 *
 * priorityFee is the sender's own free choice — paid on top of baseFee to
 * jump the mempool queue when the network is congested — and is NOT
 * itself consensus-enforced to any particular value; only "priorityFee >=
 * 0" and "totalFee >= baseFee" are (see meetsRequiredFee below). This
 * mirrors Bitcoin's fee-per-byte market for when it's actually needed,
 * without requiring every user to understand it for an ordinary send.
 *
 * Fees are paid entirely to whichever miner includes the transaction in a
 * block (like Bitcoin), not burned — see utxo.ts's validateBlock, which
 * independently recomputes totalFee for every transaction in a block and
 * rejects any block whose coinbase claims more than
 * blockSubsidy + sum(totalFee).
 */

import { SMALLEST_UNITS_PER_WVE } from "./consensus-params";

/**
 * Base fee, in smallest units, charged per signature a transaction's
 * inputs carry. Every node MUST enforce this identically when validating
 * a transaction's fee — this is the consensus-critical half of the fee
 * formula (unlike priorityFee, which a sender may set to any non-negative
 * value). Deliberately tiny — well below any block reward — so it does
 * its job (spam/DoS deterrence proportional to verification cost) without
 * being a meaningful cost to a normal user.
 * 0.0001 WVE at 8 decimals = 10,000 smallest units, per signature.
 */
export const BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS = Math.floor(
  0.0001 * SMALLEST_UNITS_PER_WVE,
);

/**
 * @deprecated Renamed to BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS now that the
 * base fee scales with signature count rather than being a flat
 * per-transaction amount. Kept as an alias (same value) only so any code
 * that hasn't migrated yet still compiles; new code should use the
 * per-signature constant directly.
 */
export const MIN_FEE_SMALLEST_UNITS = BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS;

/**
 * Optional additional fee rate, in smallest units per byte of serialized
 * transaction size, that a wallet can add on top of the required base fee
 * to prioritize a transaction when the mempool is congested. Exposed as an
 * "advanced" control in the wallet UI — not part of the default send flow.
 *
 * This is a wallet-side estimation default, not itself a protocol-enforced
 * value (unlike BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS, which nodes must
 * actually enforce) — a sender may choose ANY non-negative priorityFee.
 */
export const DEFAULT_PRIORITY_FEE_RATE_PER_BYTE = 1; // smallest units/byte

/**
 * The required base fee (in smallest units) for a transaction with
 * `signatureCount` signatures. Every node MUST compute this identically —
 * it is the floor a transaction's totalFee must meet or exceed.
 */
export function calculateBaseFee(signatureCount: number): bigint {
  if (!Number.isInteger(signatureCount) || signatureCount < 0) {
    throw new RangeError(`signatureCount must be a non-negative integer, got ${signatureCount}`);
  }
  return BigInt(BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS) * BigInt(signatureCount);
}

/**
 * The required total fee (in smallest units) for a transaction with
 * `signatureCount` signatures and a chosen `priorityFeeSmallestUnits`
 * (defaulting to 0, i.e. base fee only). This is exactly:
 *
 *   totalFee = (baseFeePerSignature × signatureCount) + priorityFee
 *
 * Every node MUST use this same formula when independently verifying a
 * transaction's claimed fee (see utxo.ts's validateTransaction) — it is
 * consensus-critical in the "baseFee floor" component, while
 * priorityFeeSmallestUnits is whatever non-negative amount the sender
 * actually attached.
 */
export function calculateRequiredFee(
  signatureCount: number,
  priorityFeeSmallestUnits: bigint = 0n,
): bigint {
  if (priorityFeeSmallestUnits < 0n) {
    throw new RangeError("priorityFeeSmallestUnits must be non-negative");
  }
  return calculateBaseFee(signatureCount) + priorityFeeSmallestUnits;
}

/**
 * The exact amount a sender's inputs must cover for a transaction sending
 * `amountSmallestUnits` to a recipient, with `signatureCount` signatures
 * and an optional `priorityFeeSmallestUnits`:
 *
 *   totalSenderCost = amountSent + baseFee + priorityFee
 *
 * The recipient's own output is unaffected by any of this — it always
 * receives exactly `amountSmallestUnits`; the fee is entirely an
 * additional cost borne by the sender (covered by their inputs, with any
 * surplus returned to them as change).
 */
export function calculateTotalSenderCost(
  amountSmallestUnits: bigint,
  signatureCount: number,
  priorityFeeSmallestUnits: bigint = 0n,
): bigint {
  if (amountSmallestUnits <= 0n) {
    throw new RangeError("amountSmallestUnits must be positive");
  }
  return amountSmallestUnits + calculateRequiredFee(signatureCount, priorityFeeSmallestUnits);
}

/**
 * Validates that a transaction's actual paid fee (sum(inputs) -
 * sum(outputs), already computed by the caller against the UTXO set — see
 * utxo.ts's validateTransaction) meets or exceeds the required base fee
 * for its signature count. A fee above the base fee is always valid (the
 * excess is priority fee, the sender's free choice); a fee below the base
 * fee is never valid, regardless of how the sender might have intended to
 * split it between "base" and "priority".
 */
export function meetsRequiredFee(feeSmallestUnitsPaid: bigint, signatureCount: number): boolean {
  return feeSmallestUnitsPaid >= calculateBaseFee(signatureCount);
}

/** @deprecated Use meetsRequiredFee(fee, signatureCount) — a flat minimum no longer reflects the per-signature base fee. */
export function meetsMinimumFee(feeSmallestUnits: number): boolean {
  return feeSmallestUnits >= BASE_FEE_PER_SIGNATURE_SMALLEST_UNITS;
}

/**
 * Computes the total fee (in smallest units) a transaction is paying,
 * given its resolved input and output totals. Fee = sum(inputs) -
 * sum(outputs). This is arithmetic only — it does not check the result
 * against the required base fee; use meetsRequiredFee for that.
 */
export function calculateFee(
  totalInputValue: bigint,
  totalOutputValue: bigint,
): bigint {
  const fee = totalInputValue - totalOutputValue;
  if (fee < 0n) {
    throw new Error(
      "Invalid transaction: outputs exceed inputs (would create WVE from nothing)",
    );
  }
  return fee;
}

/**
 * Suggests a fee (in smallest units) for a transaction with
 * `signatureCount` signatures and a serialized byte size of
 * `transactionSizeBytes`, under normal (non-congested) conditions the base
 * fee alone; under "fast" conditions, the base fee plus a per-byte
 * priority component. This is a wallet-side estimate, not itself a
 * protocol rule — see calculateRequiredFee for the consensus floor a
 * wallet's chosen fee must actually meet.
 */
export function suggestFee(
  signatureCount: number,
  transactionSizeBytes: number,
  priority: "normal" | "fast" = "normal",
): bigint {
  const baseFee = calculateBaseFee(signatureCount);
  if (priority === "normal") {
    return baseFee;
  }
  return baseFee + BigInt(transactionSizeBytes) * BigInt(DEFAULT_PRIORITY_FEE_RATE_PER_BYTE);
}