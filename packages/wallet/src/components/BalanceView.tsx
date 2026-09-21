import { useState } from "react";
import { formatWve, shortenAddress } from "../lib/format";

interface BalanceViewProps {
  address: string;
  confirmed: bigint | null;
  immature: bigint;
  utxoCount: number;
  onReceiveClick: () => void;
}

/**
 * The wallet's home card: balance + address. Receiving WVE needs nothing
 * from this component beyond showing the address (see the build spec:
 * there's no "generate a new address per receive" flow here — Weave's
 * P2PKH model reuses one address, same simplicity trade-off Bitcoin
 * wallets made before HD wallets became standard).
 */
export function BalanceView({ address, confirmed, immature, utxoCount, onReceiveClick }: BalanceViewProps) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — the address is still
      // visible and selectable by hand, so this fails quietly.
    }
  };

  return (
    <div className="card">
      <p className="card-label">Balance</p>
      <div className="balance-amount">
        {confirmed === null ? "—" : formatWve(confirmed)}
        <span className="ticker">WVE</span>
      </div>
      <div className="balance-sub">
        {immature > 0n && <span>{formatWve(immature)} WVE maturing · </span>}
        {utxoCount} unspent output{utxoCount === 1 ? "" : "s"}
      </div>

      <div className="address-row">
        <span className="address-text" title={address}>
          {shortenAddress(address, 10, 8)}
        </span>
        <button className="icon-btn" onClick={copyAddress} aria-label="Copy address" title="Copy address">
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button className="icon-btn" onClick={onReceiveClick} aria-label="Show receive QR" title="Show receive address">
          <QrIcon />
        </button>
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function QrIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM19 19h2v2h-2z" />
    </svg>
  );
}
WEAVE_EOF
echo done
Output

done
Now a 
