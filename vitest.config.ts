import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // The core layer is pure and platform-agnostic, so it runs in plain Node.
    // WebCrypto (globalThis.crypto.subtle) is native in Node >= 20, the same
    // primitive the extension uses in the browser. No polyfill, no divergence
    // between what we test and what we ship.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * The KDF tests are deliberately expensive — that is the entire point of a
     * memory-hard derivation. Each allocates tens to hundreds of MiB, and
     * vitest runs files in parallel, so under memory pressure a single
     * derivation can exceed the 5s default and fail a test that is working
     * correctly. A slower CI runner makes that worse.
     *
     * Raised rather than reduced: shrinking the parameters to fit the default
     * timeout would mean testing a configuration we do not ship.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
