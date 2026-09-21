import { useState } from "react";
import { exportPrivateKeyHex } from "../wallet/keystore";

interface BackupSheetProps {
  onClose: () => void;
}

/**
 * The explicit, deliberate export step the build spec calls out as
 * mattering for real fund safety even though it's not required before a
 * first transaction (see keystore.ts's module doc). Reveals the raw
 * private key only after the user asks for it here — never surfaced
 * anywhere else in the app.
 */
export function BackupSheet({ onClose }: BackupSheetProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    try {
      const key = await exportPrivateKeyHex();
      setRevealed(key);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Key stays visible on screen for manual copy even if this fails.
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Back up your key</h2>

        {error && <div className="banner banner-error">{error}</div>}

        {!revealed ? (
          <>
            <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.5 }}>
              This reveals the private key controlling this wallet's funds. Anyone with it can
              spend everything in this wallet. Store it somewhere offline and private — don't
              screenshot it into cloud photo storage or paste it into a chat.
            </p>
            <button className="btn btn-primary btn-full" style={{ marginTop: 16 }} onClick={reveal}>
              Reveal private key
            </button>
            <button className="btn btn-ghost btn-full" style={{ marginTop: 10 }} onClick={onClose}>
              Not now
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>Private key — keep this secret</label>
              <textarea readOnly rows={3} value={revealed} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <div className="actions-row">
              <button className="btn btn-ghost" onClick={onClose}>
                Done
              </button>
              <button className="btn btn-primary" onClick={copy}>
                {copied ? "Copied" : "Copy key"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}