/**
 * Weave node mempool (Phase 4 dependency, first written before Phase 1's
 * real Transaction type existed — this replaces the placeholder
 * `{ id, sizeBytes }` stand-in with the real @weave/core Transaction).
 *
 * Holds pending, not-yet-mined transactions and prioritizes them for block
 * assembly by fee rate (fee / byte), same approach as Bitcoin's mempool.
 * This is node-local policy, not consensus: different nodes may order
 * their mempools differently, as long as every node still enforces
 * MIN_FEE_SMALLEST_UNITS — that part IS consensus (@weave/core's fees.ts
 * and, more precisely, utxo.ts's validateTransaction, which is the actual
 * authority on whether a transaction may ever be mined at all).
 *
 * The mempool deliberately has no UTXO set access of its own — computing a
 * transaction's fee needs the value of whatever it spends, which only the
 * UTXO set knows. So `add()` takes `feeSmallestUnits` as a parameter: the
 * caller must already have validated the transaction (via @weave/core's
 * validateTransaction, which returns exactly this fee) against this node's
 * own UTXO set first. Never trust a peer's claim that a transaction pays a
 * given fee — see the build spec's "Decentralization model".
 */

import { MIN_FEE_SMALLEST_UNITS, getTxIdHex, serializeTransaction, type Transaction } from "@weave/core";

interface MempoolEntry {
  transaction: Transaction;
  feeSmallestUnits: bigint;
  sizeBytes: number;
  addedAt: number; // ms epoch, used as a tie-breaker
}

const MIN_FEE = BigInt(MIN_FEE_SMALLEST_UNITS);

export class Mempool {
  private readonly entries = new Map<string, MempoolEntry>();

  add(transaction: Transaction, feeSmallestUnits: bigint): { accepted: boolean; reason?: string } {
    if (feeSmallestUnits < MIN_FEE) {
      return {
        accepted: false,
        reason: `fee ${feeSmallestUnits} below network minimum ${MIN_FEE_SMALLEST_UNITS}`,
      };
    }

    const txid = getTxIdHex(transaction);
    if (this.entries.has(txid)) {
      return { accepted: false, reason: "transaction already in mempool" };
    }

    this.entries.set(txid, {
      transaction,
      feeSmallestUnits,
      sizeBytes: serializeTransaction(transaction).length,
      addedAt: Date.now(),
    });

    return { accepted: true };
  }

  remove(txidHex: string): void {
    this.entries.delete(txidHex);
  }

  has(txidHex: string): boolean {
    return this.entries.has(txidHex);
  }

  size(): number {
    return this.entries.size;
  }

  private sorted(): MempoolEntry[] {
    return [...this.entries.values()].sort((a, b) => {
      const rateA = Number(a.feeSmallestUnits) / a.sizeBytes;
      const rateB = Number(b.feeSmallestUnits) / b.sizeBytes;
      if (rateB !== rateA) return rateB - rateA; // higher fee-rate first
      return a.addedAt - b.addedAt; // older first as tie-breaker
    });
  }

  private select(maxBytes: number | undefined): MempoolEntry[] {
    const sorted = this.sorted();
    if (maxBytes === undefined) return sorted;

    const selected: MempoolEntry[] = [];
    let bytesUsed = 0;
    for (const entry of sorted) {
      if (bytesUsed + entry.sizeBytes > maxBytes) continue;
      selected.push(entry);
      bytesUsed += entry.sizeBytes;
    }
    return selected;
  }

  /**
   * Transactions ordered for block assembly: highest fee-rate first, then
   * oldest-first as a tie-breaker. `maxBytes` caps how much of the mempool
   * to pull for a candidate block of limited size.
   */
  getPrioritized(maxBytes?: number): Transaction[] {
    return this.select(maxBytes).map((e) => e.transaction);
  }

  /**
   * Same selection as `getPrioritized`, but with each transaction's fee
   * alongside it — what miner.ts needs to compute the coinbase reward
   * (subsidy + sum of these fees) without re-deriving fees itself.
   */
  getPrioritizedWithFees(maxBytes?: number): { transaction: Transaction; feeSmallestUnits: bigint }[] {
    return this.select(maxBytes).map((e) => ({ transaction: e.transaction, feeSmallestUnits: e.feeSmallestUnits }));
  }

  /** Sum of fees (smallest units) across the whole mempool — useful for node/wallet dashboards, not for block assembly (which only counts the transactions actually selected — see getPrioritizedWithFees). */
  totalFeesAvailable(): bigint {
    let total = 0n;
    for (const entry of this.entries.values()) total += entry.feeSmallestUnits;
    return total;
  }

  /** Drops every transaction that was just included in a mined or received block — call after applyBlock succeeds, so the mempool doesn't keep offering already-spent inputs. */
  removeAll(transactions: Transaction[]): void {
    for (const tx of transactions) this.entries.delete(getTxIdHex(tx));
  }
}