import { zeroHash } from "../hash";
import type { BlockHeader } from "../block";

/** Deterministic test header builder — same defaults everywhere so vectors stay reproducible. */
export function testHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    version: 1,
    prevHash: zeroHash(),
    merkleRoot: zeroHash(),
    timestamp: 1_700_000_000,
    difficultyTarget: 0x1f00ffff,
    nonce: 0,
    ...overrides,
  };
}