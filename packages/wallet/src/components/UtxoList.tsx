import type { UtxoResponse } from "../api/restClient";
import { formatWve, shortenTxid } from "../lib/format";

interface UtxoListProps {
  utxos: UtxoResponse[];
}

/**
 * Shows the wallet's unspent outputs directly, rather than a synthesized
 * "transaction history" — the node's REST API (rest.ts's listunspent) is
 * what's actually available without adding a new endpoint, and a UTXO list
 * is honest about what a UTXO-model wallet actually holds: not a running
 * balance ledger, but a specific set of spendable outputs. Each row shows
 * enough to reason about spendability (confirmations, coinbase maturity).
 */
export function UtxoList({ utxos }: UtxoListProps) {
  if (utxos.length === 0) {
    return (
      <div className="card">
        <p className="card-label">Unspent outputs</p>
        <div className="empty-state">Nothing here yet — receive some WVE to see it appear.</div>
      </div>
    );
  }

  const sorted = [...utxos].sort((a, b) => b.blockHeight - a.blockHeight);

  return (
    <div className="card">
      <p className="card-label">Unspent outputs</p>
      <div className="utxo-list">
        {sorted.map((u) => (
          <div className="utxo-row" key={`${u.txid}:${u.outputIndex}`}>
            <div style={{ minWidth: 0 }}>
              <div className="utxo-id">{shortenTxid(u.txid)}</div>
              <div className="utxo-meta">
                Block {u.blockHeight} · {u.confirmations} confirmation{u.confirmations === 1 ? "" : "s"}
                {u.coinbase && !u.spendable ? " · maturing" : u.coinbase ? " · mined" : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {!u.spendable && <span className="badge warn">Immature</span>}
              <span className="utxo-value">{formatWve(BigInt(u.value))}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
