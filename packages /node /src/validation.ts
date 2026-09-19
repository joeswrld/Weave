/**
 * Wires @weave/crypto's ECDSA verifier into @weave/core's validation
 * engine. Kept as a one-line seam (rather than a core dependency) because
 * `core` deliberately has no secp256k1/curve dependency — see script.ts's
 * header comment — so something at the node boundary has to connect them.
 * Call this once, before any transaction/block validation happens.
 */

import { setSignatureVerifier } from "@weave/core";
import { verifyP2PKHUnlockingScript } from "@weave/crypto";

let wired = false;

export function wireSignatureVerification(): void {
  if (wired) return;
  setSignatureVerifier(verifyP2PKHUnlockingScript);
  wired = true;
}