
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Weave browser wallet build config (Phase 7 + Phase 8 mining).
 *
 * Notes:
 * - `@weave/core` and `@weave/crypto` are workspace packages imported as
 *   TypeScript sources (see their package.json `main`/`types` pointing at
 *   src/index.ts), so Vite needs to actually transpile them rather than
 *   treat them as pre-built libraries — no special config needed for that,
 *   esbuild/Vite handles workspace TS deps out of the box.
 * - `worker: { format: "es" }` — the mining worker (mining/miner.worker.ts)
 *   uses ES module imports (it imports @weave/core's hashing/target helpers
 *   directly rather than duplicating hash logic), so it must be bundled as
 *   an ES module worker, not Vite's classic default.
 * - PWA plugin gives the "optional" install-like-an-app + offline tx queue
 *   packaging the build spec calls out for Phase 7, without changing how
 *   the app behaves when not installed.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Weave Wallet",
        short_name: "Weave",
        description: "A zero-install browser wallet and miner for the Weave (WVE) network.",
        theme_color: "#0B0D10",
        background_color: "#0B0D10",
        display: "standalone",
        // A single "any size" SVG icon rather than fabricated 192/512 PNGs:
        // this manifest field must point at a real file that exists, and
        // an SVG marked "any" is valid per the Web App Manifest spec and
        // scales cleanly for every install-icon size a platform asks for.
        icons: [{ src: "favicon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      workbox: {
        // Never cache API/WS calls to the node — the wallet's own offline
        // queue (see wallet/outbox.ts) is what handles "no connection",
        // not a stale cached response pretending to be live chain state.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  worker: { format: "es" },
  server: { port: 5173 },
  build: { target: "es2022", sourcemap: true },
});