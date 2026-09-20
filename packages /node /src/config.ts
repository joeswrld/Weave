/** Node configuration — env-driven with safe defaults. */
import { readFileSync } from "node:fs";

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ["1", "true", "yes"].includes(v.toLowerCase()));
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export interface NodeConfig {
  dataDir: string;
  host: string;
  port: number;
  /** Public WSS/WS address advertised to peers (optional). */
  publicP2pAddress?: string;
  seeds: string[];
  tls?: { key: Buffer; cert: Buffer };
  corsOrigins: string[]; // ["*"] allows any
  rateLimit: { windowMs: number; max: number };
  /** Blocks whose bodies are kept; older bodies are pruned (headers/meta kept). 0 = keep all. */
  retainBlocks: number;
  mining: { enabled: boolean; payoutAddress?: string; maxAttemptsPerSlice: number };
  genesis: { timestamp: number; difficultyTarget: number; payoutAddress?: string; nonce?: number };
  /** If set, POST /api/mining requires this bearer token (optional hardening). */
  adminToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const tls = env.TLS_KEY_FILE && env.TLS_CERT_FILE
    ? { key: readFileSync(env.TLS_KEY_FILE), cert: readFileSync(env.TLS_CERT_FILE) }
    : undefined;
  return {
    dataDir: env.WEAVE_DATA_DIR ?? "./data",
    host: env.HOST ?? "0.0.0.0",
    port: num(env.PORT, 8433),
    publicP2pAddress: env.PUBLIC_P2P_ADDRESS,
    seeds: list(env.SEED_NODES),
    tls,
    corsOrigins: list(env.CORS_ORIGINS ?? "*"),
    rateLimit: { windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000), max: num(env.RATE_LIMIT_MAX, 240) },
    retainBlocks: num(env.RETAIN_BLOCKS, 2_016), // ~2.8 days at 120s blocks
    mining: {
      enabled: bool(env.MINING_ENABLED, false),
      payoutAddress: env.MINER_ADDRESS,
      maxAttemptsPerSlice: num(env.MINER_SLICE_ATTEMPTS, 200_000),
    },
    genesis: {
      timestamp: num(env.GENESIS_TIMESTAMP, 1_735_689_600),
      difficultyTarget: num(env.GENESIS_BITS, 0x207fffff),
      payoutAddress: env.GENESIS_ADDRESS,
    },
    adminToken: env.ADMIN_TOKEN,
  };
}