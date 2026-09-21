
import { useState } from "react";
import { isValidAddress } from "@weave/crypto";
import { MIN_FEE_SMALLEST_UNITS } from "@weave/core";
import { formatWve, parseWve } from "../lib/format";

interface SendFormProps {
  availableSmallestUnits: bigint;
  onSend: (toAddress: string, amountSmallestUnits: bigint) => Promise<{ txid: string; fee: bigint }>;
  onClose: () => void;
}

type Status = "idle" | "sending" | { txid: string; fee: bigint } | { error: string };

/**
 * The send flow: validates the address and amount client-side (so the
 * network minimum fee and "insufficient funds" cases are caught before
 * ever building/signing a transaction, per txBuilder.ts's contract), then
 * calls onSend, which does the actual build/sign/broadcast.
 */
export function SendForm({ availableSmallestUnits, onSend, onClose }: SendFormProps) {
  const [toAddress, setToAddress] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const parsedAmount = parseWve(amountInput);
  const addressValid = toAddress.length === 0 || isValidAddress(toAddress);
  const minFee = BigInt(MIN_FEE_SMALLEST_UNITS);
  const canSubmit =
    isValidAddress(toAddress) &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    parsedAmount + minFee <= availableSmallestUnits &&
    status !== "sending";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || parsedAmount === null) return;
    setStatus("sending");
    try {
      const result = await onSend(toAddress, parsedAmount);
      setStatus(result);
    } catch (err) {
      setStatus({ error: (err as Error).message });
    }
  };

  if (typeof status === "object" && "txid" in status) {
    return (
      <div className="sheet-scrim" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-handle" />
          <h2 className="sheet-title">Sent</h2>
          <div className="banner banner-success">
            Broadcast — network fee {formatWve(status.fee)} WVE.
          </div>
          <p className="field-hint" style={{ marginTop: 12, wordBreak: "break-all" }}>
            txid: {status.txid}
          </p>
          <button className="btn btn-primary btn-full" style={{ marginTop: 16 }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Send WVE</h2>

        {typeof status === "object" && "error" in status && (
          <div className="banner banner-error" style={{ marginBottom: 14 }}>
            {status.error}
          </div>
        )}

        <div className="field">
          <label>Recipient address</label>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Weave address"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value.trim())}
          />
          {!addressValid && <span className="field-error">That doesn't look like a valid Weave address.</span>}
        </div>

        <div className="field">
          <label>Amount</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00000000"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
          />
          <span className="field-hint">
            Available: {formatWve(availableSmallestUnits)} WVE · network fee ~{formatWve(minFee)} WVE
          </span>
        </div>

        <div className="actions-row" style={{ marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={status === "sending"}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {status === "sending" ? <span className="spinner" /> : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}