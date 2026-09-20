/**
 * Merkle tree over a block's txids.
 *
 * Two deliberate departures from Bitcoin's construction, both to close known
 * weaknesses:
 *
 *  1. Odd nodes are PROMOTED unchanged to the next level instead of being
 *     paired with a copy of themselves. Bitcoin's duplicate-last-node rule
 *     makes [a,b,c] and [a,b,c,c] share a root (CVE-2012-2459), which lets an
 *     attacker forge a block with a repeated tx that has the same hash as the
 *     valid one. Here the two roots differ.
 *  2. Internal nodes are hashed as sha256d(0x01 || left || right). Leaves are
 *     the txids themselves. The prefix separates the two roles so an internal
 *     node can't be passed off as a leaf.
 *
 * These are consensus rules: every node and wallet must use this exact scheme.
 */

import { concatBytes } from "@noble/hashes/utils";
import { hashesEqual, sha256d, type Hash } from "./hash";
import { getTxId, type Transaction } from "./transaction";

const NODE_PREFIX = Uint8Array.of(0x01);

function hashPair(left: Hash, right: Hash): Hash {
  return sha256d(concatBytes(NODE_PREFIX, left, right));
}

/** Merkle root of a list of txids. A single txid is its own root. Throws on an empty list. */
export function computeMerkleRoot(txids: Hash[]): Hash {
  if (txids.length === 0) throw new Error("cannot compute merkle root of zero transactions");
  let level = txids;
  while (level.length > 1) {
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right ? hashPair(left, right) : left);
    }
    level = next;
  }
  return level[0]!;
}

export function computeMerkleRootOfTransactions(transactions: Transaction[]): Hash {
  return computeMerkleRoot(transactions.map(getTxId));
}

// ---------------------------------------------------------------------------
// Inclusion proofs (lets a browser light client verify a tx is in a block
// with just the header's merkleRoot + O(log n) hashes)
// ---------------------------------------------------------------------------

export interface MerkleProofStep {
  /** The sibling hash to combine with. */
  hash: Hash;
  /** Which side the sibling sits on when hashing. */
  position: "left" | "right";
}

/** Builds the proof that txids[index] is included under computeMerkleRoot(txids). */
export function buildMerkleProof(txids: Hash[], index: number): MerkleProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= txids.length) {
    throw new RangeError(`index out of range: ${index}`);
  }
  const proof: MerkleProofStep[] = [];
  let level = txids;
  let idx = index;
  while (level.length > 1) {
    const siblingIdx = idx ^ 1;
    if (siblingIdx < level.length) {
      proof.push({ hash: level[siblingIdx]!, position: idx % 2 === 0 ? "right" : "left" });
    } // else: this node is promoted unchanged — no sibling at this level
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      next.push(right ? hashPair(level[i]!, right) : level[i]!);
    }
    level = next;
    idx = idx >> 1;
  }
  return proof;
}

export function verifyMerkleProof(txid: Hash, proof: MerkleProofStep[], root: Hash): boolean {
  let current = txid;
  for (const step of proof) {
    current =
      step.position === "right" ? hashPair(current, step.hash) : hashPair(step.hash, current);
  }
  return hashesEqual(current, root);
}