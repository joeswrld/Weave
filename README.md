# Weave (WVE)

A web-native, TypeScript-only cryptocurrency. Nodes run as ordinary web
services, peers connect over WebSockets/WebRTC, wallets are browser apps
signing with the Web Crypto API, and mining runs directly in the browser via
Web Workers / WebAssembly — no native binaries, no install step.

See `docs/architecture.md` for the full design spec, thesis, and build order.

## Structure

- `packages/core` — chain logic (blocks, transactions, UTXO set, consensus rules). No I/O, shared by node and wallet.
- `packages/crypto` — keypairs, signing, address derivation. Shared by node and wallet.
- `packages/protocol` — P2P and client/server wire message types. Shared.
- `packages/node` — the full node: P2P, mempool, mining, storage, REST/WebSocket API.
- `packages/wallet` — the browser wallet app (React + Vite), including in-browser mining.

## Getting started

This is a pnpm workspace monorepo.

```bash
pnpm install
pnpm --filter @weave/node dev     # run a local node
pnpm --filter @weave/wallet dev   # run the browser wallet
```

See `scripts/local-testnet.sh` for spinning up a multi-node local testnet via
Docker Compose.
