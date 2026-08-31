/**
 * Produces a Firefox-loadable build in `dist-firefox/`.
 *
 * WHY A SEPARATE BUILD. crxjs generates a Chrome-shaped manifest and strips any
 * `background.scripts` key we declare in manifest.config.ts, so the two targets
 * cannot share one output directory. This script copies `dist/` and rewrites
 * only the manifest.
 *
 * WHAT DIFFERS, AND WHY
 *
 *   background.scripts — Firefox does not implement `background.service_worker`
 *     at all (bugzil.la/1573659). It runs MV3 background code as an EVENT PAGE.
 *     Both keys are kept: Chrome reads `service_worker`, Firefox reads
 *     `scripts`. Firefox 121+ starts the event page even when both are present.
 *
 *   browser_specific_settings.gecko — Firefox wants a stable extension id.
 *     Temporary loads via about:debugging work without one, but a permanent
 *     install needs it, and storage is keyed to it.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING A FIREFOX BUILD WITH REAL FUNDS
 * ---------------------------------------------------------------------------
 * This produces a build Firefox will LOAD. It does not make the security model
 * equivalent, and the difference is not cosmetic:
 *
 * The wallet's core guarantee is "service worker terminated == wallet locked",
 * documented in src/background/lockPolicy.ts. It holds because JavaScript
 * cannot erase a string from the heap, so process teardown is the only real
 * erasure primitive we have — and Chrome tears the worker down aggressively.
 *
 * A Firefox event page has a DIFFERENT lifetime. Until someone measures when
 * Firefox actually unloads it and re-verifies the lock behaviour against that,
 * the auto-lock guarantee on Firefox is unproven. chrome.alarms-based auto-lock
 * still fires, so the wallet is not unprotected — but the "termination is our
 * erasure primitive" claim needs re-establishing, not assuming.
 *
 * Treat Firefox as EXPERIMENTAL until that work is done.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("dist");
const target = resolve("dist-firefox");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

const manifestPath = resolve(target, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const serviceWorker = manifest.background?.service_worker;
if (!serviceWorker) {
  throw new Error("dist/manifest.json has no background.service_worker — run `npm run build` first.");
}

manifest.background = {
  ...manifest.background,
  // Same entry file, read by Firefox instead of service_worker.
  scripts: [serviceWorker],
};

manifest.browser_specific_settings = {
  gecko: {
    id: "wallet@xyz.wallet.extension",
    /**
     * Two separate floors, and 140 is the binding one.
     *
     *   128 — MAIN-world content scripts. Our inpage provider cannot run
     *         without them, so this is the hard technical minimum.
     *   140 — `data_collection_permissions` below. Firefox 140 desktop /
     *         142 Android introduced it.
     *
     * We take 140 rather than dropping the declaration. Excluding 128–139
     * costs very little, and for a wallet you want users on a currently
     * patched browser regardless.
     */
    strict_min_version: "140.0",
    /**
     * AMO requires an explicit data-collection declaration. "none" is the
     * literal truth here and is worth stating loudly: this wallet has no
     * backend, no telemetry, and transmits nothing. The only outbound requests
     * are JSON-RPC calls, which the user's own configured node sees.
     */
    data_collection_permissions: { required: ["none"] },
  },
  /**
   * Firefox for Android gained `data_collection_permissions` in 142, two
   * releases after desktop. Declared separately so the desktop floor does not
   * have to be dragged up to match Android's.
   */
  gecko_android: {
    strict_min_version: "142.0",
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("dist-firefox/ written");
console.log("  background.scripts:", manifest.background.scripts);
console.log("  gecko id:", manifest.browser_specific_settings.gecko.id);
console.log("  strict_min_version:", manifest.browser_specific_settings.gecko.strict_min_version);
console.log("");
console.log("Load it:  about:debugging#/runtime/this-firefox");
console.log("          -> Load Temporary Add-on -> pick dist-firefox/manifest.json");
console.log("");
console.log("Firefox support is EXPERIMENTAL — see the header of this file.");
