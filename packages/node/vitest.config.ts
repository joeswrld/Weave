import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: {
    alias: {
      "@weave/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@weave/crypto": path.resolve(__dirname, "../crypto/src/index.ts"),
    },
  },
});