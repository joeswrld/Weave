import { useState } from "react";
import { shortenAddress } from "../lib/format";

interface ReceiveSheetProps {
  address: string;
  onClose: () => void;
}

/**
 * Bottom sheet showing the full receive address for copying/sharing.
 * Deliberately no QR code library here — pulling one in for a single
 * screen isn't worth the extra dependency weight in a wallet whose whole
 * pitch is "open a URL, nothing to install"; the address text itself is
 * both copyable and short enough to read aloud or retype if needed.
 */
export function ReceiveSheet({ address, onClose }: ReceiveSheetProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Address remains visible/selectable even if clipboard access fails.
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Receive WVE</h2>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -8, marginBottom: 16 }}>
          Share this address to receive WVE. It doesn't change between transactions.
        </p>
        <div className="field">
          <label>Your address</label>
          <textarea readOnly rows={2} value={address} onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className="actions-row">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
        <p className="footer-note">{shortenAddress(address, 14, 10)}</p>
      </div>
    </div>
  );
}
