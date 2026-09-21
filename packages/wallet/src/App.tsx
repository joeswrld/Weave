
import { useState } from "react";
import { useWeaveWallet } from "./hooks/useWeaveWallet";
import { Onboarding } from "./pages/Onboarding";
import { BalanceView } from "./components/BalanceView";
import { UtxoList } from "./components/UtxoList";
import { MiningPanel } from "./components/MiningPanel";
import { SendForm } from "./components/SendForm";
import { ReceiveSheet } from "./components/ReceiveSheet";
import { BackupSheet } from "./components/BackupSheet";

/**
 * Which node this wallet talks to. Hardcoded to the deployed testnet node
 * for this build; a real multi-node deployment would let the user point
 * the wallet at any node's URL (the whole point of a node being an
 * ordinary web service — see the build spec's decentralization model), but
 * a single fixed default is the right choice for "open the URL and it
 * just works" onboarding.
 */
const NODE_URL = "https://weave-vii8.onrender.com";

type Sheet = "send" | "receive" | "backup" | null;

export default function App() {
  const wallet = useWeaveWallet(NODE_URL);
  const [sheet, setSheet] = useState<Sheet>(null);

  if (wallet.setupState === "loading") {
    return (
      <div className="app-shell">
        <div className="onboarding">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (wallet.setupState === "needs-setup" || !wallet.wallet) {
    return (
      <div className="app-shell">
        <Onboarding onCreate={wallet.createWallet} onImport={wallet.importExistingWallet} />
      </div>
    );
  }

  const address = wallet.wallet.address;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
              <path d="M6 10 L12 22 L16 12 L20 22 L26 10" stroke="#5EE6C4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Weave
        </div>
        <div className="status-pill">
          <span className={`status-dot ${connectionDotClass(wallet.connectionState)}`} />
          {wallet.chainInfo ? `Block ${wallet.chainInfo.height}` : "Connecting…"}
        </div>
      </header>

      {wallet.error && <div className="banner banner-error">{wallet.error}</div>}

      <BalanceView
        address={address}
        confirmed={wallet.balance?.confirmed ?? null}
        immature={wallet.balance?.immature ?? 0n}
        utxoCount={wallet.utxos.length}
        onReceiveClick={() => setSheet("receive")}
      />

      <div className="actions-row">
        <button className="btn btn-primary" onClick={() => setSheet("send")}>
          Send
        </button>
        <button className="btn btn-ghost" onClick={() => setSheet("receive")}>
          Receive
        </button>
      </div>

      <MiningPanel
        status={wallet.minerStatus}
        onStart={wallet.startMining}
        onStop={wallet.stopMining}
        onWorkerCountChange={wallet.setMinerWorkerCount}
      />

      <UtxoList utxos={wallet.utxos} />

      <button className="link-btn" onClick={() => setSheet("backup")} style={{ alignSelf: "center" }}>
        Back up private key
      </button>

      <p className="footer-note">Connected to {NODE_URL.replace(/^https?:\/\//, "")}</p>

      {sheet === "send" && (
        <SendForm
          availableSmallestUnits={wallet.balance?.confirmed ?? 0n}
          onSend={wallet.send}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "receive" && <ReceiveSheet address={address} onClose={() => setSheet(null)} />}
      {sheet === "backup" && <BackupSheet onClose={() => setSheet(null)} />}
    </div>
  );
}

function connectionDotClass(state: "connecting" | "open" | "closed"): string {
  if (state === "open") return "live";
  if (state === "connecting") return "connecting";
  return "down";
}
