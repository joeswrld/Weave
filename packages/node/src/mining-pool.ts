/**
 * Weave mining pool (Phase 8): lets many browser tabs mine together and
 * split a block's reward by how much work each contributed, since any one
 * tab is very unlikely to find a block alone at real network difficulty
 * (see the build spec's Phase 8 notes).
 *
 * How it works, in the same spirit as a real pool (Stratum-style, just
 * over REST here instead of a custom binary protocol):
 *
 *  - The pool hands out work at an easier "share target" than the real
 *    network target — easy enough that a browser tab finds a share every
 *    few seconds to minutes instead of almost never. A share is proof the
 *    miner actually did work: its hash must be below the share target,
 *    the same PoW check as a real block, just against a looser bar.
 *  - The pool credits each submitting address with "difficulty-weighted"
 *    work for every valid share — 1 share at target difficulty D counts
 *    as D units of work, so a round mixing different share targets (see
 *    `maybeRetargetSession` below) still splits fairly.
 *  - Every candidate handed out by getWork already carries a coinbase that
 *    pays every contributor in the current round proportionally to their
 *    accumulated work (using @weave/core's multi-output coinbase support
 *    — see transaction.ts's createCoinbaseTransaction doc comment: "a
 *    mining pool can pay several participants directly in the coinbase").
 *    This has to be decided before a miner starts searching nonces, not
 *    after: the coinbase is committed to by the header's merkle root, so
 *    changing it after the fact would change the block hash and silently
 *    invalidate whatever nonce was found. Every so often, a share that
 *    happens to ALSO beat the *real* network target is a genuine block —
 *    the pool submits the (already-final) candidate to the node like any
 *    other block and starts a fresh round.
 *  - This class never trusts a miner's own claim about how much work it
 *    did — every share is independently re-hashed and PoW-checked here
 *    before being credited, same "never trust the peer, verify" spirit as
 *    the rest of Weave's consensus code (see the build spec's
 *    decentralization model). The only thing NOT independently
 *    re-verified per the network's own consensus rules is the *payout
 *    split itself* — that's pool policy, not consensus; the resulting
 *    block is still fully re-validated by every node (including this one,
 *    via WeaveNode.acceptLocalBlock) exactly like any other block.
 *
 * Deliberately simple accounting: this is "proportional, current round"
 * (work resets to zero after each pool block is found), not a
 * PPLNS/variance-smoothing scheme — a reasonable first version per the
 * build spec's "consider a simple pool that splits by contributed work"
 * framing, without the extra complexity real pools add to reduce miners'
 * payout variance across rounds.
 */

import {
  activeConsensusAlgorithm,
  compactToTarget,
  computeMerkleRootOfTransactions,
  createCoinbaseTransaction,
  createLockingScript,
  deserializeBlock,
  getBlockHashHex,
  getBlockRewardSmallestUnits,
  hashMeetsTarget,
  hashToHex,
  serializeBlock,
  type Block,
  type BlockHeader,
  type Hash,
} from "@weave/core";
import { addressToPubKeyHash } from "@weave/crypto";
import type { WeaveNode } from "./node";
import { assembleCandidateBlock } from "./miner";

const MAX_TARGET = (1n << 256n) - 1n;

/** Minimum coinbase payout, in smallest units, below which a contributor
 *  is folded into the next round instead of getting a dust-sized output —
 *  mirrors real pools' payout-threshold behavior and keeps the coinbase
 *  transaction from bloating with near-zero outputs when many tabs
 *  contribute trivial amounts of work. */
const MIN_PAYOUT_SMALLEST_UNITS = 1_000n; // 0.00001 WVE

/** How much easier the starting share target is than the network target.
 *  2^12 = 4096x easier — tuned so a single browser tab (order of 10^5-10^6
 *  H/s, per the build spec's own hashrate expectations) finds a share
 *  roughly every few seconds to tens of seconds, frequent enough to feel
 *  responsive and to make payout splitting meaningfully fair, without
 *  flooding the pool with share-submission HTTP requests. */
const INITIAL_SHARE_TARGET_MULTIPLIER = 1n << 12n;

/** Per-session share-target retargeting bounds, same idea as Bitcoin/
 *  Weave's own block-difficulty retargeting (difficulty.ts) but applied
 *  per-miner-session instead of network-wide: if a session is finding
 *  shares much faster or slower than the target rate, adjust its personal
 *  share target so submission frequency stays in a sane band regardless
 *  of how many workers / what hashrate that particular tab has. */
const TARGET_SHARE_INTERVAL_MS = 8_000;
const RETARGET_MIN_SHARES = 8; // don't retarget on too little data
const MAX_SHARE_RETARGET_FACTOR = 4;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

interface Session {
  addressHex: string; // hex(pubKeyHash), used as the map key
  shareTarget: bigint;
  recentShareTimestamps: number[]; // ms epoch, capped, for retargeting
  lastSeenAt: number;
}

export interface RoundContributor {
  addressHex: string;
  /** Sum of (share target's implied difficulty) across every valid share
   *  this address submitted in the current round — the "weight" used to
   *  split the eventual block reward. */
  workUnits: number; // number, not bigint: see WORK_UNIT_SCALE below
  shareCount: number;
}

export interface PoolStatus {
  active: boolean;
  round: {
    contributors: { addressHex: string; workUnits: number; shareCount: number; sharePct: number }[];
    totalWorkUnits: number;
    startedAt: number;
  };
  poolBlocksFound: number;
  sessionCount: number;
}

export interface SubmitShareResult {
  ok: boolean;
  reason?: string;
  /** True if this share also cleared the real network target — i.e. it
   *  was itself a full block, which the pool then submitted on the
   *  session's behalf. */
  wasBlock?: boolean;
  blockHash?: string;
  blockAccepted?: boolean;
  blockRejectReason?: string;
  /** The session's new share target (hex), if this share triggered a
   *  per-session retarget — lets the client adjust without a fresh
   *  getwork round-trip. */
  newShareTargetHex?: string;
}

/**
 * `workUnits` is difficulty expressed as (maxTarget / shareTarget), scaled
 * down so it fits comfortably in a JS `number` without precision loss for
 * any realistic session count — see creditShare's comment for the exact
 * conversion. bigint math is used for anything consensus/hash-comparison
 * related; plain numbers are fine for "how big a slice of the payout pie"
 * since that only needs a handful of significant digits, not exactness.
 */
const WORK_UNIT_SCALE = 1e12;

export class MiningPool {
  private readonly sessions = new Map<string, Session>(); // key: addressHex
  private round = new Map<string, RoundContributor>(); // key: addressHex
  private roundStartedAt = Date.now();
  private poolBlocksFound = 0;
  private active = false;

  constructor(private readonly node: WeaveNode) {}

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.sessions.clear();
  }

  // --------------------------------------------------------------- getwork

  /**
   * Hands out a candidate block for `address` to mine against, same shape
   * as the solo getwork response plus a `shareTarget` the client should
   * actually search against (easier than `target`, which remains the real
   * network target for reference/UI purposes only). Creates or reuses this
   * address's session so its personal share target can adapt over time
   * (see maybeRetargetSession).
   *
   * The coinbase handed out here already pays the *whole current round*
   * proportionally (see buildRoundCoinbase) — not just `address` — because
   * the coinbase is part of what the miner's nonce search commits to via
   * the merkle root. Swapping it for a different coinbase after a nonce is
   * found would change the merkle root and therefore the block hash,
   * silently invalidating whatever nonce was found (the hash the miner
   * searched for would no longer be the hash the new header actually
   * produces). So the payout must be finalized before work goes out, not
   * after a share comes back.
   */
  getWork(address: string) {
    const pkh = addressToPubKeyHash(address);
    if (!pkh) return { error: "invalid address" as const };
    const addressHex = Buffer.from(pkh).toString("hex");

    let session = this.sessions.get(addressHex);
    if (!session) {
      const networkTarget = compactToTarget(this.node.chain.nextDifficultyBits()) ?? MAX_TARGET;
      const initialShareTarget = clampTarget(networkTarget * INITIAL_SHARE_TARGET_MULTIPLIER);
      session = {
        addressHex,
        shareTarget: initialShareTarget,
        recentShareTimestamps: [],
        lastSeenAt: Date.now(),
      };
      this.sessions.set(addressHex, session);
    }
    session.lastSeenAt = Date.now();

    const tip = this.node.chain.tip;
    const networkDifficultyBits = this.node.chain.nextDifficultyBits();
    const networkTarget = compactToTarget(networkDifficultyBits) ?? MAX_TARGET;
    // Never hand out a share target easier than the network target itself
    // — that would make "share" and "block" the same thing and defeat the
    // point of a lower-difficulty accounting target.
    const shareTarget = session.shareTarget > networkTarget ? session.shareTarget : networkTarget;

    const extra = Buffer.alloc(4);
    extra.writeUInt32BE(Math.floor(Math.random() * 0xffff_ffff));

    // Build with a single-payee placeholder first just to learn this
    // candidate's fee total (assembleCandidateBlock computes that against
    // the actual mempool selection for this height/timestamp), then
    // replace the coinbase with the full round's proportional payout
    // before it's ever handed to a miner — see this method's doc comment
    // for why that has to happen now and not in submitShare.
    const { block: draft, totalFees } = assembleCandidateBlock({
      height: tip.height + 1,
      prevHash: tip.hash,
      difficultyTarget: networkDifficultyBits,
      payoutLockingScript: createLockingScript(pkh),
      mempool: this.node.mempool,
      coinbaseExtraData: new Uint8Array(extra),
      timestamp: Math.max(Math.floor(Date.now() / 1000), tip.block.header.timestamp + 1),
    });
    const block = this.buildRoundCoinbase(draft, tip.height + 1, totalFees, pkh);

    return {
      height: tip.height + 1,
      prevHash: tip.hashHex,
      difficultyBits: networkDifficultyBits,
      target: networkTarget.toString(16).padStart(64, "0"),
      shareTarget: shareTarget.toString(16).padStart(64, "0"),
      header: {
        ...block.header,
        prevHash: hashToHex(block.header.prevHash),
        merkleRoot: hashToHex(block.header.merkleRoot),
      },
      blockHex: Buffer.from(serializeBlock(block)).toString("hex"),
      totalFees: totalFees.toString(),
    };
  }

  // ----------------------------------------------------------- submitShare

  /**
   * Validates a submitted share: re-derives the block from the submitted
   * `blockHex` + `nonce`, independently re-hashes the header (never trusts
   * the miner's own claimed hash), and checks it against that session's
   * share target. Credits work on success. If the share also beats the
   * real network target, treats it as a found block: builds the
   * round-payout coinbase, submits it via the node's normal
   * acceptLocalBlock path (which re-validates it exactly like any other
   * block — see this file's header comment), and starts a new round.
   */
  submitShare(address: string, blockHex: string, nonce: number): SubmitShareResult {
    if (!this.active) return { ok: false, reason: "pool is not active" };
    const pkh = addressToPubKeyHash(address);
    if (!pkh) return { ok: false, reason: "invalid address" };
    const addressHex = Buffer.from(pkh).toString("hex");
    const session = this.sessions.get(addressHex);
    if (!session) return { ok: false, reason: "no active session for this address — call getwork first" };
    // A share is just as much a sign of life as a getWork call — sessions
    // that mine steadily on one long-lived candidate (no exhaustion, no new
    // tip) may go many minutes between getWork calls while still actively
    // submitting shares; only bumping lastSeenAt in getWork would let
    // pruneIdleSessions evict a perfectly active miner mid-round, silently
    // resetting their accumulated workUnits to zero and dropping every
    // share submitted right after until the client's next getWork refetch
    // recreates the session from scratch.
    session.lastSeenAt = Date.now();

    if (typeof blockHex !== "string" || !/^[0-9a-fA-F]+$/.test(blockHex) || blockHex.length > 4_000_000) {
      return { ok: false, reason: "invalid blockHex" };
    }
    if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffff_ffff) {
      return { ok: false, reason: "invalid nonce" };
    }

    let header: BlockHeader;
    let block: Block;
    try {
      const bytes = patchNonce(hexToBytes(blockHex), nonce);
      block = deserializeBlock(bytes);
      header = block.header;
    } catch {
      return { ok: false, reason: "could not deserialize submitted block" };
    }

    // Independently re-hash under the network's activeConsensusAlgorithm
    // (WPoW-V1) — never trust a client-supplied hash. This used to call
    // plain getBlockHash (SHA-256d) directly, which meant a share/block
    // that satisfied the pool's own check could still be rejected by
    // node.acceptLocalBlock's real WPoW-V1 validation below — fixed by
    // hashing the same way the chain now actually verifies.
    const hash: Hash = activeConsensusAlgorithm.computeProofHash(header);

    if (!hashMeetsTarget(hash, session.shareTarget)) {
      return { ok: false, reason: "share does not meet this session's share target" };
    }

    this.creditShare(session, session.shareTarget);
    const retargeted = this.maybeRetargetSession(session);

    const networkTarget = compactToTarget(this.node.chain.nextDifficultyBits()) ?? MAX_TARGET;
    if (!hashMeetsTarget(hash, networkTarget)) {
      // Valid share, not (yet) a block — the common case.
      return {
        ok: true,
        newShareTargetHex: retargeted ? session.shareTarget.toString(16).padStart(64, "0") : undefined,
      };
    }

    // This share also clears the real network target: it's a block. The
    // candidate's coinbase already pays the round's proportional split —
    // fixed back at getWork, before this nonce was searched for (see
    // getWork's doc comment) — so `block` can go straight to the node's
    // normal acceptance path (which independently re-validates everything,
    // including this coinbase's total against subsidy+fees — see utxo.ts).
    const result = this.node.acceptLocalBlock(block);
    const blockHashHex = getBlockHashHex(block.header);

    if (result.ok) {
      this.poolBlocksFound += 1;
      this.round = new Map(); // fresh round for the next block
      this.roundStartedAt = Date.now();
    }

    return {
      ok: true,
      wasBlock: true,
      blockHash: blockHashHex,
      blockAccepted: result.ok,
      blockRejectReason: result.ok ? undefined : (result.reason ?? result.status),
    };
  }

  // ------------------------------------------------------------ accounting

  private creditShare(session: Session, shareTarget: bigint): void {
    const existing = this.round.get(session.addressHex);
    const workUnits = Number(MAX_TARGET / shareTarget) / WORK_UNIT_SCALE;
    if (existing) {
      existing.workUnits += workUnits;
      existing.shareCount += 1;
    } else {
      this.round.set(session.addressHex, { addressHex: session.addressHex, workUnits, shareCount: 1 });
    }
    session.recentShareTimestamps.push(Date.now());
    if (session.recentShareTimestamps.length > 20) session.recentShareTimestamps.shift();
  }

  /** Per-session retarget so each tab's share frequency stays near
   *  TARGET_SHARE_INTERVAL_MS regardless of its own hashrate — a fast
   *  multi-core desktop and a slow phone browser both end up submitting
   *  shares at a similar cadence, rather than the fast one flooding the
   *  pool with requests or the slow one almost never submitting. Returns
   *  true if the target actually changed. */
  private maybeRetargetSession(session: Session): boolean {
    const times = session.recentShareTimestamps;
    if (times.length < RETARGET_MIN_SHARES) return false;

    const span = times[times.length - 1]! - times[0]!;
    const avgIntervalMs = span / (times.length - 1);
    if (!Number.isFinite(avgIntervalMs) || avgIntervalMs <= 0) return false;

    let factor = avgIntervalMs / TARGET_SHARE_INTERVAL_MS;
    factor = Math.max(1 / MAX_SHARE_RETARGET_FACTOR, Math.min(MAX_SHARE_RETARGET_FACTOR, factor));
    if (Math.abs(factor - 1) < 0.15) return false; // don't thrash on small noise

    // Shares arriving faster than target (avgInterval < target -> factor<1)
    // means the current target is too easy for this session's actual
    // hashrate -> tighten it (smaller target = harder). Arriving slower ->
    // loosen it (larger target = easier).
    const networkTarget = compactToTarget(this.node.chain.nextDifficultyBits()) ?? MAX_TARGET;
    const proposed = clampTarget(BigInt(Math.round(Number(session.shareTarget) * factor)));
    session.shareTarget = proposed > networkTarget ? proposed : networkTarget;
    session.recentShareTimestamps = [];
    return true;
  }

  /**
   * Replaces `draft`'s single-payee coinbase with one paying every
   * contributor in the current round proportionally to their accumulated
   * work, using @weave/core's multi-output coinbase support, and
   * recomputes the header's merkle root to match — all *before* handing
   * the candidate to a miner (see getWork's doc comment for why this can't
   * happen after the fact, once a nonce has been searched for).
   *
   * `requesterPkh` covers the case where the round has no accumulated work
   * yet (e.g. the first getWork of a fresh round): rather than build a
   * zero-output coinbase, the requesting session is paid the full reward,
   * same as buildProportionalOutputs's own empty-round fallback would if
   * the round were merely thin rather than completely empty.
   *
   * Contributors whose share would round to below MIN_PAYOUT_SMALLEST_UNITS
   * are simply omitted — their work still counts once more shares
   * accumulate in future rounds, they just don't get a dust output this
   * time (any smallest units freed up by omission stay unclaimed by
   * design, same as how a solo miner's coinbase is allowed to pay *up to*
   * — not necessarily exactly — subsidy+fees; see utxo.ts's coinbase
   * check).
   */
  private buildRoundCoinbase(
    draft: Block,
    height: number,
    totalFees: bigint,
    requesterPkh: Uint8Array,
  ): Block {
    const totalReward = BigInt(getBlockRewardSmallestUnits(height)) + totalFees;

    const totalWork = [...this.round.values()].reduce((s, c) => s + c.workUnits, 0);
    const outputs =
      totalWork > 0
        ? buildProportionalOutputs(this.round, totalWork, totalReward)
        : [{ value: totalReward, lockingScript: createLockingScript(requesterPkh) }];

    const coinbase = createCoinbaseTransaction(height, outputs, coinbaseExtraFromCandidate(draft));
    const transactions = [coinbase, ...draft.transactions.slice(1)];
    const header: BlockHeader = {
      ...draft.header,
      merkleRoot: computeMerkleRootOfTransactions(transactions),
    };
    return { header, transactions };
  }

  // ------------------------------------------------------------- read-only

  status(): PoolStatus {
    const totalWorkUnits = [...this.round.values()].reduce((s, c) => s + c.workUnits, 0);
    return {
      active: this.active,
      round: {
        contributors: [...this.round.values()]
          .sort((a, b) => b.workUnits - a.workUnits)
          .map((c) => ({
            addressHex: c.addressHex,
            workUnits: c.workUnits,
            shareCount: c.shareCount,
            sharePct: totalWorkUnits > 0 ? (c.workUnits / totalWorkUnits) * 100 : 0,
          })),
        totalWorkUnits,
        startedAt: this.roundStartedAt,
      },
      poolBlocksFound: this.poolBlocksFound,
      sessionCount: this.sessions.size,
    };
  }

  /** Prunes sessions idle for longer than `maxIdleMs` — call periodically
   *  (see api/rest.ts's pool route registration) so a long-running node
   *  doesn't accumulate unbounded session state from tabs that navigated
   *  away without an explicit "stop mining". */
  pruneIdleSessions(maxIdleMs: number): void {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, s] of this.sessions) {
      if (s.lastSeenAt < cutoff) this.sessions.delete(k);
    }
  }
}

// --------------------------------------------------------------- utilities

function clampTarget(t: bigint): bigint {
  if (t < 1n) return 1n;
  if (t > MAX_TARGET) return MAX_TARGET;
  return t;
}

const NONCE_OFFSET = 4 + 32 + 32 + 4 + 4;

/** Patches the 4-byte little-endian nonce into an 80-byte-header-prefixed
 *  serialized block, same fixed-offset trick the wallet's minerPool.ts
 *  uses client-side — done again here server-side because a share
 *  submission carries the *candidate's* blockHex (nonce unset) plus the
 *  winning nonce separately, mirroring the client's own message shape
 *  rather than asking it to re-serialize the whole block just to change
 *  one field. */
function patchNonce(bytes: Uint8Array, nonce: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(NONCE_OFFSET, nonce, true);
  return out;
}

function buildProportionalOutputs(
  round: Map<string, RoundContributor>,
  totalWork: number,
  totalReward: bigint,
): { value: bigint; lockingScript: Uint8Array }[] {
  const outputs: { value: bigint; lockingScript: Uint8Array }[] = [];
  let distributed = 0n;
  const contributors = [...round.values()];
  const totalWorkScaled = BigInt(Math.round(totalWork * WORK_UNIT_SCALE));
  for (let i = 0; i < contributors.length; i++) {
    const c = contributors[i]!;
    const isLast = i === contributors.length - 1;
    // Last contributor gets the remainder rather than its own rounded
    // share, so integer-division rounding never leaves smallest units
    // unaccounted for while still respecting totalReward as a hard cap.
    const share = isLast
      ? totalReward - distributed
      : (totalReward * BigInt(Math.round(c.workUnits * WORK_UNIT_SCALE))) / totalWorkScaled;
    distributed += share;
    if (share < MIN_PAYOUT_SMALLEST_UNITS) continue; // see rebuildWithRoundCoinbase's doc comment
    outputs.push({ value: share, lockingScript: createLockingScript(hexToBytes(c.addressHex)) });
  }
  // Extremely unlikely (only if every contributor was below the dust
  // threshold), but never ship a coinbase with zero outputs: fall back to
  // paying the top contributor the full reward.
  if (outputs.length === 0 && contributors.length > 0) {
    const top = [...contributors].sort((a, b) => b.workUnits - a.workUnits)[0]!;
    outputs.push({ value: totalReward, lockingScript: createLockingScript(hexToBytes(top.addressHex)) });
  }
  return outputs;
}

function coinbaseExtraFromCandidate(block: Block): Uint8Array | undefined {
  // Preserve the candidate's extranonce bytes (everything after the
  // 4-byte height prefix — see @weave/core transaction.ts's
  // getCoinbaseHeight/createCoinbaseTransaction) so the rebuilt coinbase's
  // script is still unique per candidate even though its outputs changed;
  // createCoinbaseTransaction re-derives the height prefix itself, so only
  // the portion after it needs to be passed through here.
  const script = block.transactions[0]!.inputs[0]!.unlockingScript;
  return script.length > 4 ? script.slice(4) : undefined;
}