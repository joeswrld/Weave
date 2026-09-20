/** Web security middleware: headers, CORS allow-list, per-IP fixed-window rate limit. No extra deps. */
import type { NextFunction, Request, Response } from "express";
import type { NodeConfig } from "../config";

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.removeHeader("X-Powered-By");
  next();
}

export function cors(cfg: NodeConfig) {
  const any = cfg.corsOrigins.includes("*");
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && (any || cfg.corsOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", any ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || e.reset <= now) hits.set(ip, (e = { count: 0, reset: now + windowMs }));
    e.count++;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - e.count)));
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    next();
  };
}

/** Per-IP connection cap for WebSocket upgrades. */
export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();
  constructor(private readonly maxPerIp: number) {}
  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.maxPerIp) return false;
    this.counts.set(ip, n + 1);
    return true;
  }
  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 1) - 1;
    if (n <= 0) this.counts.delete(ip);
    else this.counts.set(ip, n);
  }
}