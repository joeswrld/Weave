/**
 * Weave UTXO set, transaction validation, and block validation (Phase 3).
 * ...
 */

import { getBlockHash, type Block, type BlockHeader } from "./block";
import { getBlockRewardSmallestUnits } from "./consensus-params";
import { hashesEqual, hashToHex, type Hash } from "./hash";
import { checkScriptsStructure, parseLockingScript } from "./script";
import { compactToTarget, hashMeetsTarget } from "./target";
import {
  checkTransactionStructure,
  getTxId,
  getTxIdHex,
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

export function checkProofOfWork(header: BlockHeader): string | null {
  const target = compactToTarget(header.difficultyTarget);
  if (target === null) return "invalid difficultyTarget encoding";
  const hash = getBlockHash(header);
  if (!hashMeetsTarget(hash, target)) return `block hash ${hashToHex(hash)} does not meet target`;
  return null;
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