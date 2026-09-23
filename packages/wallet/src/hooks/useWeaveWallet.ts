/**
 * Single hook that ties together keystore.ts (key storage), restClient.ts
 * (balance/UTXOs/broadcast), wsClient.ts (live updates), and minerPool.ts
 * (Phase 8 browser mining) into the state App.tsx and its child components
 * actually render. Keeping all of this in one hook — rather than spreading
 * fetch calls across components — is what makes "a new block arrived,
 * refresh the balance" a single code path instead of something every
 * component has to remember to do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { generateWallet, hasWallet, importWallet, unlockWallet, type UnlockedWallet } from "../wallet/keystore";
import { buildAndSignTransaction } from "../wallet/txBuilder";
import { RestClient, type BlockchainInfo, type UtxoResponse } from "../api/restClient";
import { WalletFeedClient, type ConnectionState } from "../api/wsClient";
import { MinerPool, type MinerStatus, type MiningMode } from "../mining/minerPool";

export type SetupState = "loading" | "needs-setup" | "ready";

export function useWeaveWallet(nodeUrl: string) {
  const restRef = useRef<RestClient>(new RestClient(nodeUrl));
  const feedRef = useRef<WalletFeedClient>(new WalletFeedClient(nodeUrl));
  const minerRef = useRef<MinerPool | null>(null);

  const [setupState, setSetupState] = useState<SetupState>("loading");
  const [wallet, setWallet] = useState<UnlockedWallet | null>(null);
  const [balance, setBalance] = useState<{ confirmed: bigint; immature: bigint } | null>(null);
  const [utxos, setUtxos] = useState<UtxoResponse[]>([]);
  const [chainInfo, setChainInfo] = useState<BlockchainInfo | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("closed");
  const [minerStatus, setMinerStatus] = useState<MinerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshBalanceAndUtxos = useCallback(
    async (address: string) => {
      try {
        const [bal, unspent] = await Promise.all([
          restRef.current.getBalance(address),
          restRef.current.listUnspent(address),
        ]);
        setBalance({ confirmed: BigInt(bal.balance), immature: BigInt(bal.immature) });
        setUtxos(unspent);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  const refreshChainInfo = useCallback(async () => {
    try {
      const info = await restRef.current.getBlockchainInfo();
      setChainInfo(info);
    } catch {
      // Non-fatal: the header status pill just shows stale/unknown height.
    }
  }, []);

  // --- initial load: is there already a wallet in this browser? ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const exists = await hasWallet();
      if (cancelled) return;
      if (!exists) {
        setSetupState("needs-setup");
        return;
      }
      try {
        const unlocked = await unlockWallet();
        if (cancelled) return;
        setWallet(unlocked);
        setSetupState("ready");
      } catch (err) {
        setError((err as Error).message);
        setSetupState("needs-setup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- once wallet is ready: connect feed, poll chain info, load balance --
  useEffect(() => {
    if (!wallet) return;

    void refreshBalanceAndUtxos(wallet.address);
    void refreshChainInfo();

    const feed = feedRef.current;
    const unsubEvent = feed.onEvent((event) => {
      if (event.type === "block") {
        void refreshChainInfo();
        void refreshBalanceAndUtxos(wallet.address);
        minerRef.current?.notifyNewTip();
      } else if (event.type === "tx" || event.type === "reorg") {
        void refreshBalanceAndUtxos(wallet.address);
      }
    });
    const unsubState = feed.onStateChange(setConnectionState);
    feed.connect([wallet.address]);

    const pollId = setInterval(() => void refreshChainInfo(), 15_000);

    return () => {
      unsubEvent();
      unsubState();
      feed.close();
      clearInterval(pollId);
    };
  }, [wallet, refreshBalanceAndUtxos, refreshChainInfo]);

  const createWallet = useCallback(async () => {
    const created = await generateWallet();
    setWallet(created);
    setSetupState("ready");
  }, []);

  const importExistingWallet = useCallback(async (privateKeyHex: string) => {
    const imported = await importWallet(privateKeyHex);
    setWallet(imported);
    setSetupState("ready");
  }, []);

  const send = useCallback(
    async (toAddress: string, amountSmallestUnits: bigint) => {
      if (!wallet) throw new Error("Wallet is locked.");
      // Re-fetch UTXOs right before building rather than trusting the
      // `utxos` state snapshot: that state is only refreshed on a WS
      // block/tx/reorg event or after a previous send, so it can be
      // stale by the time this runs (e.g. two sends close together, or
      // an outpoint that was already spent since the last refresh). Using
      // a stale list lets the builder pick an already-spent outpoint,
      // which the node then rejects with "outpoint ... does not exist or
      // is already spent" — confusing for something that's really just a
      // timing issue on the wallet's side, not an actual double-spend.
      const freshUtxos = await restRef.current.listUnspent(wallet.address);
      setUtxos(freshUtxos);
      const built = buildAndSignTransaction({
        wallet,
        utxos: freshUtxos,
        toAddress,
        amountSmallestUnits,
      });
      const result = await restRef.current.sendRawTransaction(built.hex);
      await refreshBalanceAndUtxos(wallet.address);
      return { txid: result.txid, fee: built.fee };
    },
    [wallet, refreshBalanceAndUtxos],
  );

  const startMining = useCallback(() => {
    if (!wallet) return;
    if (!minerRef.current) {
      minerRef.current = new MinerPool(restRef.current, wallet.address);
      minerRef.current.onStatus(setMinerStatus);
    }
    void minerRef.current.start();
  }, [wallet]);

  const stopMining = useCallback(() => {
    minerRef.current?.stop();
  }, []);

  const setMinerWorkerCount = useCallback((count: number) => {
    minerRef.current?.setWorkerCount(count);
  }, []);

  const setMiningMode = useCallback((mode: MiningMode) => {
    minerRef.current?.setMode(mode);
  }, []);

  return {
    setupState,
    wallet,
    balance,
    utxos,
    chainInfo,
    connectionState,
    minerStatus,
    error,
    createWallet,
    importExistingWallet,
    send,
    startMining,
    stopMining,
    setMinerWorkerCount,
    setMiningMode,
    refresh: () => wallet && refreshBalanceAndUtxos(wallet.address),
  };
}