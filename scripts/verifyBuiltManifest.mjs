/**
 * Checks the manifest that actually SHIPS, and fails the build if it drifted.
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/manifestPolicy.test.ts
 *
 * That test reads `manifest.config.ts` — what we declare. This reads
 * `dist/manifest.json` — what Chrome will install. They are not the same file
 * and the difference is not cosmetic: crxjs rewrites the manifest on the way
 * out, and in particular it GENERATES `web_accessible_resources` itself, for
 * assets we never named. So the declaration can be perfect and the artifact
 * still wrong, and only the artifact is what a user installs.
 *
 * The check that motivates the whole script is the HTML one. The approval
 * window is opened with `chrome.windows.create` and is deliberately absent
 * from `web_accessible_resources` — a comment in `vite.config.ts` says so, and
 * a comment is not a control. If a crxjs upgrade ever starts emitting HTML
 * entries, any website could frame the single surface in this extension where
 * a click authorises a signature, and nothing anywhere would have failed.
 *
 * Wired into `npm run build`, not into `npm test`, on purpose. The unit suite
 * is hermetic and must run on a fresh clone with no `dist/`; a test that
 * skipped itself when the build was missing would be a check that silently
 * stops running. Every build runs this, including the one before a submission.
 *
 * Exit code 1 on any violation. It never rewrites anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const distDirectory = resolve(import.meta.dirname, "..", "dist");
const manifestPath = resolve(distDirectory, "manifest.json");

const violations = [];

function require(condition, message) {
  if (!condition) violations.push(message);
}

if (!existsSync(manifestPath)) {
  console.error(`No built manifest at ${manifestPath}. Run \`npm run build\`.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/* ---------------------------------------------------------------- grants -- */

require(manifest.manifest_version === 3, "manifest_version is not 3");

const EXPECTED_PERMISSIONS = ["storage", "alarms", "scripting"];
const actualPermissions = [...(manifest.permissions ?? [])].sort();
require(
  JSON.stringify(actualPermissions) === JSON.stringify([...EXPECTED_PERMISSIONS].sort()),
  `permissions drifted: expected ${EXPECTED_PERMISSIONS.join(", ")}, ` +
    `built manifest has ${actualPermissions.join(", ") || "none"}`,
);

require(
  !manifest.optional_permissions && !manifest.optional_host_permissions,
  "the built manifest declares optional permissions, which nothing asked for",
);

/* ------------------------------------------------------------------ CSP -- */

const policy = manifest.content_security_policy?.extension_pages ?? "";
require(
  /(^|;)\s*script-src\s+'self'\s*(;|$)/.test(policy),
  `script-src is not exactly 'self': ${policy || "(no policy declared)"}`,
);
for (const forbidden of ["unsafe-eval", "unsafe-inline", "http:", "https:", "*"]) {
  require(
    !policy.includes(forbidden),
    `content security policy admits ${forbidden}: ${policy}`,
  );
}

/* ------------------------------------- what a website is allowed to reach -- */

const webAccessibleResources = (manifest.web_accessible_resources ?? []).flatMap(
  (entry) => entry.resources ?? [],
);

/**
 * The one that matters. Nothing framable, ever.
 *
 * crxjs adds the compiled content-script assets here, which is correct and
 * necessary — they are code the page's own realm loads. An HTML page is a
 * different thing entirely: it is a document with our extension's privileges
 * that a hostile site could put in an invisible iframe.
 */
for (const resource of webAccessibleResources) {
  require(
    !resource.endsWith(".html"),
    `web_accessible_resources exposes an extension PAGE to every website: ` +
      `${resource}. Any site could frame it. See the rollupOptions comment in ` +
      `vite.config.ts.`,
  );
  require(
    !resource.includes("approval"),
    `the approval window is web-accessible: ${resource}. That is the one ` +
      `surface where a click authorises a signature.`,
  );
}

/* -------------------------------------------------------- content scripts -- */

const contentScripts = manifest.content_scripts ?? [];
require(contentScripts.length === 2, `expected 2 content scripts, found ${contentScripts.length}`);

const worlds = contentScripts.map((script) => script.world);
require(
  worlds.includes("ISOLATED") && worlds.includes("MAIN"),
  `content script worlds drifted: ${JSON.stringify(worlds)}. The bridge must ` +
    `stay ISOLATED and the provider MAIN.`,
);

for (const script of contentScripts) {
  require(
    script.all_frames === false || script.all_frames === undefined,
    "a content script runs in all frames; the bridge is top-frame only so an " +
      "embedded frame cannot ask under the top-level origin",
  );
  require(
    script.run_at === "document_start",
    `a content script does not run at document_start: ${script.run_at}`,
  );
}

/* -------------------------------------------- every referenced file exists -- */

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...contentScripts.flatMap((script) => script.js ?? []),
  ...webAccessibleResources,
].filter((path) => typeof path === "string" && !path.includes("*"));

for (const file of referencedFiles) {
  require(
    existsSync(resolve(distDirectory, file)),
    `manifest points at a file that is not in dist/: ${file}`,
  );
}

require(manifest.icons?.["128"], "no 128px icon; a store submission is rejected without one");
require(
  manifest.action?.default_icon?.["128"],
  "no 128px action icon; Chrome substitutes a grey square in the toolbar",
);

/* --------------------------------------------------------------- verdict -- */

if (violations.length > 0) {
  console.error(`\nBuilt manifest failed ${violations.length} check(s):\n`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Built manifest verified: ${actualPermissions.length} permissions, ` +
    `${webAccessibleResources.length} web-accessible asset(s), no framable pages.`,
);
