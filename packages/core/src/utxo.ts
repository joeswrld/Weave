/**
 * Weave UTXO set, transaction validation, and block validation (Phase 3).
 * ...
 */

import { checkBlockStructure, type Block, type BlockHeader } from "./block";
import { activeConsensusAlgorithm } from "./consensus/active";
import { checkProofOfWorkWith } from "./consensus/validate";
import { getBlockRewardSmallestUnits } from "./consensus-params";
import { hashesEqual, hashToHex, type Hash } from "./hash";
import { checkScriptsStructure } from "./script";
import {
  checkTransactionStructure,
  getCoinbaseHeight,
  getTxId,
  isCoinbase,
  outpointKey,
  type Transaction,
  type TxOutput,
} from "./transaction";

export interface UTXO {
  txid: Hash;
  outputIndex: number;
  value: bigint;
  lockingScript: Uint8Array;
  blockHeight: number;
  isCoinbase: boolean;
}

export class UtxoSet {
  private readonly map: Map<string, UTXO>;
  constructor(initial?: Iterable<[string, UTXO]>) { this.map = new Map(initial ?? []); }
  get(txid: Hash, outputIndex: number) { return this.map.get(outpointKey(txid, outputIndex)); }
  has(txid: Hash, outputIndex: number) { return this.map.has(outpointKey(txid, outputIndex)); }
  add(utxo: UTXO) { this.map.set(outpointKey(utxo.txid, utxo.outputIndex), utxo); }
  remove(txid: Hash, outputIndex: number) {
    const key = outpointKey(txid, outputIndex);
    const existing = this.map.get(key);
    this.map.delete(key);
    return existing;
  }
  get size() { return this.map.size; }
  snapshot() { return new Map(this.map); }
  static restore(snapshot: Map<string, UTXO>) { return new UtxoSet(snapshot); }
  clone() { return new UtxoSet(this.map); }
}

export const COINBASE_MATURITY_BLOCKS = 100;

/**
 * Blocks whose timestamp is more than this far ahead of node-local time are
 * rejected outright — same 2-hour tolerance Bitcoin uses, wide enough to
 * absorb ordinary clock skew across a decentralized set of peers without
 * letting a block claim to be from far in the future.
 */
export const MAX_FUTURE_BLOCK_TIME_SECONDS = 2 * 60 * 60;

/** How many of the immediately preceding blocks' timestamps feed median-time-past. */
export const MEDIAN_TIME_PAST_WINDOW = 11;

// ---------------------------------------------------------------------------
// Transaction validation result
// ---------------------------------------------------------------------------

export type TransactionValidationResult =
  | { valid: true; totalInput: bigint; totalOutput: bigint; fee: bigint }
  | { valid: false; reason: string };

function invalid(reason: string): TransactionValidationResult {
  return { valid: false, reason };
}

// ---------------------------------------------------------------------------
// Block validation result and context
// ---------------------------------------------------------------------------

export type BlockValidationResult =
  | { valid: true; totalFees: bigint }
  | { valid: false; reason: string };

function invalidBlock(reason: string): BlockValidationResult {
  return { valid: false, reason };
}

/**
 * Everything about the chain-so-far that block validation needs but that a
 * bare Block/UtxoSet pair can't supply on its own. Assembled by the caller
 * (chain.ts) from its own block index — utxo.ts stays chain-state-free.
 */
export interface BlockContext {
  /** Height this block would occupy if accepted (genesis = 0). */
  height: number;
  /** Hash of the block this one must build on (zero hash only at genesis). */
  expectedPrevHash: Hash;
  /**
   * Timestamps of up to the last MEDIAN_TIME_PAST_WINDOW blocks, ordered
   * oldest-first, ending with the current tip. Empty only at genesis.
   */
  prevTimestamps: number[];
  /** Overrides Date.now()-derived "now" for deterministic tests. */
  now?: number;
}

/** Median of the last MEDIAN_TIME_PAST_WINDOW timestamps (Bitcoin's median-time-past rule). */
export function medianTimePast(prevTimestamps: number[]): number {
  const window = prevTimestamps.slice(-MEDIAN_TIME_PAST_WINDOW);
  const sorted = [...window].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Sum of a coinbase transaction's output values. */
export function coinbaseOutputTotal(coinbaseTx: Transaction): bigint {
  let total = 0n;
  for (const output of coinbaseTx.outputs) total += output.value;
  return total;
}

/**
 * Structural checks that DO need chain context (unlike
 * checkBlockStructure in block.ts, which is context-free): the block must
 * actually build on the expected tip, and must have a coinbase whose
 * embedded height (script.ts's height-in-coinbase convention) matches the
 * height it's being validated at.
 */
function checkBlockStructureAgainstContext(block: Block, context: BlockContext): string | null {
  const genericProblem = checkBlockStructure(block);
  if (genericProblem) return genericProblem;

  if (!hashesEqual(block.header.prevHash, context.expectedPrevHash)) {
    return `block does not build on the expected tip (got prevHash ${hashToHex(block.header.prevHash)})`;
  }

  const coinbaseHeight = getCoinbaseHeight(block.transactions[0]!);
  if (coinbaseHeight === null || coinbaseHeight !== context.height) {
    return `coinbase height ${String(coinbaseHeight)} does not match block height ${context.height}`;
  }

  return null;
}

export function validateTransaction(
  tx: Transaction,
  utxoSet: UtxoSet,
  currentHeight: number,
  spentInThisBlock?: Set<string>,
): TransactionValidationResult {
  const structuralProblem = checkTransactionStructure(tx);
  if (structuralProblem) return invalid(structuralProblem);
  if (isCoinbase(tx)) return invalid("validateTransaction does not accept coinbase transactions directly");

  let totalInput = 0n;
  const claimedThisTx = new Set<string>();

  for (const [i, input] of tx.inputs.entries()) {
    const key = outpointKey(input.prevTxId, input.outputIndex);
    if (claimedThisTx.has(key)) return invalid(`input ${i}: duplicate input ${key}`);
    claimedThisTx.add(key);

    if (spentInThisBlock?.has(key)) {
      return invalid(`input ${i}: outpoint ${key} already spent earlier in this block`);
    }

    const utxo = utxoSet.get(input.prevTxId, input.outputIndex);
    if (!utxo) return invalid(`input ${i}: outpoint ${key} does not exist or is already spent`);

    if (utxo.isCoinbase) {
      const maturity = currentHeight - utxo.blockHeight;
      if (maturity < COINBASE_MATURITY_BLOCKS) {
        return invalid(`input ${i}: coinbase output ${key} is not yet mature (${maturity}/${COINBASE_MATURITY_BLOCKS} confirmations)`);
      }
    }

    const scriptProblem = checkScriptsStructure(utxo.lockingScript, input.unlockingScript);
    if (scriptProblem) return invalid(`input ${i}: ${scriptProblem}`);

    if (!verifyInputSignature(tx, i, utxo.lockingScript, input.unlockingScript)) {
      return invalid(`input ${i}: signature verification failed`);
    }
    totalInput += utxo.value;
  }

  let totalOutput = 0n;
  for (const output of tx.outputs) totalOutput += output.value;

  if (totalInput < totalOutput) {
    return invalid(`sum(inputs) ${totalInput} < sum(outputs) ${totalOutput} — transaction would create WVE from nothing`);
  }

  return { valid: true, totalInput, totalOutput, fee: totalInput - totalOutput };
}

// Signature verification is injected — core has no secp256k1 dependency.
export type SignatureVerifier = (tx: Transaction, inputIndex: number, prevLockingScript: Uint8Array, unlockingScript: Uint8Array) => boolean;
let verifyInputSignature: SignatureVerifier = () => false; // fail closed
export function setSignatureVerifier(verifier: SignatureVerifier): void { verifyInputSignature = verifier; }

/**
 * Delegates to consensus/validate.ts's checkProofOfWorkWith, fixed to the
 * network's activeConsensusAlgorithm (see consensus/active.ts), rather than
 * hardcoding SHA-256d. Recomputes the proof hash from `header` itself every
 * time via verifyProof — never trusts a caller-supplied hash — exactly like
 * the plain-SHA-256d check this replaced.
 */
export function checkProofOfWork(header: BlockHeader): string | null {
  return checkProofOfWorkWith(header, activeConsensusAlgorithm);
}

export function validateBlock(block: Block, utxoSet: UtxoSet, context: BlockContext): BlockValidationResult {
  const structuralProblem = checkBlockStructureAgainstContext(block, context);
  if (structuralProblem) return invalidBlock(structuralProblem);

  const powProblem = checkProofOfWork(block.header);
  if (powProblem) return invalidBlock(powProblem);

  const now = context.now ?? Math.floor(Date.now() / 1000);
  if (block.header.timestamp > now + MAX_FUTURE_BLOCK_TIME_SECONDS) {
    return invalidBlock("block timestamp too far in the future");
  }
  const mtp = medianTimePast(context.prevTimestamps);
  if (context.prevTimestamps.length > 0 && block.header.timestamp <= mtp) {
    return invalidBlock(`block timestamp ${block.header.timestamp} not greater than median-time-past ${mtp}`);
  }

  const [coinbaseTx, ...restTxs] = block.transactions;
  const spentInThisBlock = new Set<string>();
  let totalFees = 0n;
  for (const [i, tx] of restTxs.entries()) {
    const result = validateTransaction(tx, utxoSet, context.height, spentInThisBlock);
    if (!result.valid) return invalidBlock(`transaction ${i + 1}: ${result.reason}`);
    for (const input of tx.inputs) spentInThisBlock.add(outpointKey(input.prevTxId, input.outputIndex));
    totalFees += result.fee!;
  }

  const coinbaseReward = coinbaseOutputTotal(coinbaseTx!);
  const expectedReward = BigInt(getBlockRewardSmallestUnits(context.height)) + totalFees;
  if (coinbaseReward > expectedReward) {
    return invalidBlock(`coinbase pays ${coinbaseReward}, which exceeds the allowed subsidy+fees ${expectedReward}`);
  }
  return { valid: true, totalFees };
}

export function applyBlock(block: Block, utxoSet: UtxoSet, height: number): UTXO[] {
  const removed: UTXO[] = [];
  for (const tx of block.transactions) {
    const txid = getTxId(tx);
    const coinbase = isCoinbase(tx);
    if (!coinbase) {
      for (const input of tx.inputs) {
        const spent = utxoSet.remove(input.prevTxId, input.outputIndex);
        if (spent) removed.push(spent);
      }
    }
    tx.outputs.forEach((output: TxOutput, index: number) => {
      utxoSet.add({ txid, outputIndex: index, value: output.value, lockingScript: output.lockingScript, blockHeight: height, isCoinbase: coinbase });
    });
  }
  return removed;
}

export function revertBlock(block: Block, utxoSet: UtxoSet, removedByApply: UTXO[]): void {
  for (const tx of block.transactions) {
    const txid = getTxId(tx);
    tx.outputs.forEach((_output: TxOutput, index: number) => { utxoSet.remove(txid, index); });
  }
  for (const utxo of removedByApply) utxoSet.add(utxo);
}