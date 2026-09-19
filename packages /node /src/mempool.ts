/**
 * Weave node mempool.
 *
 * Holds pending, not-yet-mined transactions and prioritizes them for block
 * assembly by fee rate (fee / size), same approach as Bitcoin's mempool.
 * This is node-local policy, not consensus: different nodes are allowed to
 * order their mempools differently, as long as every node still enforces
 * MIN_FEE_SMALLEST_UNITS (that part IS consensus — see fees.ts).
 */

import { MIN_FEE_SMALLEST_UNITS, meetsMinimumFee } from "@weave/core/fees";

// Placeholder type — replace with the real Transaction type from
// packages/core/src/transaction.ts once it's implemented.
interface Transaction {
  id: string;
  sizeBytes: number;
}

interface MempoolEntry {
  transaction: Transaction;
  feeSmallestUnits: number;
  addedAt: number; // ms epoch, used as a tie-breaker
}

export class Mempool {
  private entries = new Map<string, MempoolEntry>();

  /**
   * Attempts to add a transaction to the mempool. Rejects anything below
   * the network minimum fee — this mirrors the same check a node applies
   * when validating a block, so a transaction that can't get mined won't
   * even be relayed.
   */
  add(transaction: Transaction, feeSmallestUnits: number): { accepted: boolean; reason?: string } {
    if (!meetsMinimumFee(feeSmallestUnits)) {
      return {
        accepted: false,
        reason: `Fee ${feeSmallestUnits} below network minimum ${MIN_FEE_SMALLEST_UNITS}`,
      };
    }

    if (this.entries.has(transaction.id)) {
      return { accepted: false, reason: "Transaction already in mempool" };
    }

    this.entries.set(transaction.id, {
      transaction,
      feeSmallestUnits,
      addedAt: Date.now(),
    });

    return { accepted: true };
  }

  remove(transactionId: string): void {
    this.entries.delete(transactionId);
  }

  has(transactionId: string): boolean {
    return this.entries.has(transactionId);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Returns transactions ordered for block assembly: highest fee-rate
   * (fee per byte) first, so a miner naturally maximizes fee revenue per
   * byte of limited block space, then oldest-first as a tie-breaker.
   *
   * `maxBytes` lets the caller (miner.ts) cap how many transactions to
   * pull for a candidate block, given a target block size.
   */
  getPrioritized(maxBytes?: number): Transaction[] {
    const sorted = [...this.entries.values()].sort((a, b) => {
      const rateA = a.feeSmallestUnits / a.transaction.sizeBytes;
      const rateB = b.feeSmallestUnits / b.transaction.sizeBytes;
      if (rateB !== rateA) return rateB - rateA; // higher fee-rate first
      return a.addedAt - b.addedAt; // older first as tie-breaker
    });

    if (maxBytes === undefined) {
      return sorted.map((e) => e.transaction);
    }

    const selected: Transaction[] = [];
    let bytesUsed = 0;
    for (const entry of sorted) {
      if (bytesUsed + entry.transaction.sizeBytes > maxBytes) continue;
      selected.push(entry.transaction);
      bytesUsed += entry.transaction.sizeBytes;
    }
    return selected;
  }

  /** Total fees (in smallest units) available across the whole mempool — useful for node/wallet dashboards. */
  totalFeesAvailable(): number {
    return [...this.entries.values()].reduce((sum, e) => sum + e.feeSmallestUnits, 0);
  }
}
