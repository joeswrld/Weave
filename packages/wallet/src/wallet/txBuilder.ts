
/**
 * Client-side transaction construction and signing (Phase 7/2). Signing
 * happens ONLY here, in the browser, with the in-memory private key from
 * keystore.ts's UnlockedWallet — the node never receives anything but the
 * final serialized, signed transaction (see restClient.ts's
 * sendRawTransaction). This mirrors the build spec's explicit requirement:
 * "Keep signing strictly client-side in the browser wallet — the node/
 * server should never see a private key, only signed transactions."
 */

import {
  MIN_FEE_SMALLEST_UNITS,
  createLockingScript,
  getTxIdHex,
  serializeTransaction,
  suggestFee,
  type Transaction,
  type TxOutput,
} from "@weave/core";
import { addressToPubKeyHash, publicKeyToAddress, signP2PKHInput } from "@weave/crypto";
import type { UnlockedWallet } from "./keystore";
import type { UtxoResponse } from "../api/restClient";

export interface BuiltTransaction {
  tx: Transaction;
  hex: string;
  txid: string;
  fee: bigint;
  totalInput: bigint;
  changeAmount: bigint;
}

/**
 * Picks unspent outputs to cover `amount + fee`, largest-first. Largest-
 * first keeps the input count (and so the tx size, and so the fee) low for
 * a typical send — a smallest-first or random strategy would tend to
 * accumulate more inputs than necessary. Immature coinbase outputs
 * (flagged `spendable: false` by the node — see rest.ts's listunspent) are
 * skipped entirely, since the network would reject spending them anyway.
 */
function selectUtxos(
  utxos: UtxoResponse[],
  targetSmallestUnits: bigint,
): { chosen: UtxoResponse[]; total: bigint } {
  const spendable = utxos.filter((u) => u.spendable).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
  const chosen: UtxoResponse[] = [];
  let total = 0n;
  for (const utxo of spendable) {
    if (total >= targetSmallestUnits) break;
    chosen.push(utxo);
    total += BigInt(utxo.value);
  }
  return { chosen, total };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds, signs, and serializes a transaction sending `amountSmallestUnits`
 * to `toAddress`. Fee defaults to the network minimum (the wallet's
 * "sending WVE costs basically nothing, no decision required" default from
 * the build spec's fee design); pass a larger `feeSmallestUnits` for the
 * advanced fee-bump path.
 *
 * Throws if the wallet's UTXOs can't cover amount + fee.
 */
export function buildAndSignTransaction(params: {
  wallet: UnlockedWallet;
  utxos: UtxoResponse[];
  toAddress: string;
  amountSmallestUnits: bigint;
  feeSmallestUnits?: bigint;
}): BuiltTransaction {
  const { wallet, utxos, toAddress, amountSmallestUnits } = params;

  const toPkh = addressToPubKeyHash(toAddress);
  if (!toPkh) throw new Error("Invalid recipient address.");

  const fromAddress = publicKeyToAddress(wallet.publicKey);
  const fromPkh = addressToPubKeyHash(fromAddress);
  if (!fromPkh) throw new Error("Wallet address is invalid (unexpected).");

  if (amountSmallestUnits <= 0n) throw new Error("Amount must be positive.");

  // Fee estimation needs the tx size, which depends on input count, which
  // depends on the fee (circular) — resolved the standard way: estimate
  // with a first UTXO selection, then reselect once size is known if it
  // changed the input count. One extra pass is enough in practice since
  // P2PKH inputs/outputs are fixed-size.
  let feeSmallestUnits = params.feeSmallestUnits ?? BigInt(MIN_FEE_SMALLEST_UNITS);
  let selection = selectUtxos(utxos, amountSmallestUnits + feeSmallestUnits);

  if (selection.total < amountSmallestUnits + feeSmallestUnits) {
    throw new Error("Insufficient funds to cover amount plus fee.");
  }

  const buildUnsigned = (chosen: UtxoResponse[], fee: bigint): Transaction => {
    const changeAmount = chosen.reduce((sum, u) => sum + BigInt(u.value), 0n) - amountSmallestUnits - fee;
    const outputs: TxOutput[] = [{ value: amountSmallestUnits, lockingScript: createLockingScript(toPkh) }];
    if (changeAmount > 0n) {
      outputs.push({ value: changeAmount, lockingScript: createLockingScript(fromPkh) });
    }
    return {
      version: 1,
      inputs: chosen.map((u) => ({
        prevTxId: hexToBytes(u.txid),
        outputIndex: u.outputIndex,
        unlockingScript: new Uint8Array(0), // filled in by signing, below
      })),
      outputs,
    };
  };

  // Estimate size with a placeholder-signed tx to refine the fee if the
  // caller didn't pin one explicitly (advanced fee-per-byte path).
  if (params.feeSmallestUnits === undefined) {
    const draft = buildUnsigned(selection.chosen, feeSmallestUnits);
    const estimatedSize = serializeTransaction(draft).length + draft.inputs.length * 140; // rough room for sig+pubkey per input
    const suggested = BigInt(suggestFee(estimatedSize, "normal"));
    if (suggested > feeSmallestUnits) {
      feeSmallestUnits = suggested;
      selection = selectUtxos(utxos, amountSmallestUnits + feeSmallestUnits);
      if (selection.total < amountSmallestUnits + feeSmallestUnits) {
        throw new Error("Insufficient funds to cover amount plus fee.");
      }
    }
  }

  const unsigned = buildUnsigned(selection.chosen, feeSmallestUnits);

  const signedInputs = unsigned.inputs.map((input, i) => {
    const prevLockingScript = hexToBytes(selection.chosen[i]!.lockingScript);
    const unlockingScript = signP2PKHInput(
      unsigned,
      i,
      prevLockingScript,
      wallet.privateKey,
      wallet.publicKey,
    );
    return { ...input, unlockingScript };
  });

  const signed: Transaction = { ...unsigned, inputs: signedInputs };
  const hex = bytesToHex(serializeTransaction(signed));
  const txid = getTxIdHex(signed);

  return {
    tx: signed,
    hex,
    txid,
    fee: feeSmallestUnits,
    totalInput: selection.total,
    changeAmount: selection.total - amountSmallestUnits - feeSmallestUnits,
  };
}
