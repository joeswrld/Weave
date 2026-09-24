import { useState } from "react";
import { WeaveCoinIcon } from "../components/WeaveCoinIcon";

interface OnboardingProps {
  onCreate: () => Promise<void>;
  onImport: (privateKeyHex: string) => Promise<void>;
}

/**
 * The entire "setup" the build spec's onboarding goal describes: one
 * button, no seed phrase, no download. Import is offered as a secondary,
 * explicitly-labeled path for someone restoring a backup — not the default,
 * since it's the opposite of the friction-free path this wallet exists to
 * demonstrate.
 */
export function Onboarding({ onCreate, onImport }: OnboardingProps) {
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importKey, setImportKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onImport(importKey);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (showImport) {
    return (
      <div className="onboarding">
        <div className="onboarding-mark">
          <WeaveCoinIcon size={56} />
        </div>
        <h1>Restore a wallet</h1>
        <p>Paste the private key you backed up earlier.</p>
        {error && <div className="banner banner-error">{error}</div>}
        <form onSubmit={handleImport} style={{ width: "100%", maxWidth: 320 }}>
          <div className="field">
            <textarea
              rows={3}
              placeholder="Private key (hex)"
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              autoFocus
            />
          </div>
          <div className="onboarding-actions">
            <button type="submit" className="btn btn-primary btn-full" disabled={busy || !importKey.trim()}>
              {busy ? <span className="spinner" /> : "Restore wallet"}
            </button>
            <button type="button" className="link-btn" onClick={() => setShowImport(false)} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-mark">
        <WeaveCoinIcon size={56} />
      </div>
      <h1>Welcome to Weave</h1>
      <p>
        No install, no seed phrase to write down first. Generate a wallet right here in this
        tab and you're ready to receive WVE.
      </p>
      {error && <div className="banner banner-error">{error}</div>}
      <div className="onboarding-actions">
        <button className="btn btn-primary btn-full" onClick={handleCreate} disabled={busy}>
          {busy ? <span className="spinner" /> : "Create a wallet"}
        </button>
        <button className="link-btn" onClick={() => setShowImport(true)} disabled={busy}>
          Restore from a backed-up key instead
        </button>
      </div>
      <p className="footer-note">
        Your key is generated and encrypted in this browser. Back it up once you're set up —
        losing it means losing access to any funds it holds.
      </p>
    </div>
  );
}