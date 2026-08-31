/**
 * Rewrites `src/core/security/phishingHosts.ts` from a maintained source.
 *
 * RUN BY A PERSON, BEFORE A RELEASE. Never by the extension, and never on a
 * timer. The whole point of bundling the list is that the wallet does not talk
 * to a blocklist server while someone is browsing -- see the header of
 * phishingHosts.ts. This script is the reviewable step that keeps the bundled
 * copy current without building that channel.
 *
 * Source: MetaMask's eth-phishing-detect, which is the list most of the
 * ecosystem uses and is maintained in the open. Only the `blacklist` array is
 * taken; `fuzzylist` is deliberately ignored, because its matching semantics
 * are the wallet's own business and `originRisk.ts` already does that work
 * against the user's OWN connections, which is a better reference set than a
 * global list of popular domains.
 *
 *     node scripts/updateBlocklist.mjs
 *
 * Then review the diff and run the test suite before committing.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json";

const TARGET = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "src",
  "core",
  "security",
  "phishingHosts.ts",
);

/** Bare hostnames only: lowercase, no scheme, no path, no trailing dot. */
function isUsableHost(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9.-]+$/.test(value) &&
    value.includes(".") &&
    !value.startsWith(".") &&
    !value.endsWith(".")
  );
}

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Blocklist source answered ${response.status}.`);
}

const config = await response.json();
const hosts = [...new Set((config.blacklist ?? []).map((host) => String(host).toLowerCase()))]
  .filter(isUsableHost)
  .sort();

if (hosts.length === 0) {
  // A source that answers 200 with nothing usable would otherwise silently
  // empty the list, turning a security feature off without anyone noticing.
  throw new Error("Source returned no usable hosts; refusing to write an empty list.");
}

/**
 * The file's own documentation and its lookup are the point of it, so both are
 * preserved and only the data below the marker is replaced.
 *
 * Keyed off an explicit marker rather than off the name of the declaration
 * that follows. Keying off a declaration means renaming it silently turns this
 * script into one that appends a second copy, or throws on a file that is
 * perfectly fine.
 */
const GENERATED_MARKER = "// === GENERATED BELOW";
const existing = readFileSync(TARGET, "utf8");
const markerAt = existing.indexOf(GENERATED_MARKER);
if (markerAt === -1) {
  throw new Error(`Could not find "${GENERATED_MARKER}" in ${TARGET}.`);
}

/**
 * ONE STRING, NOT AN ARRAY LITERAL.
 *
 * The reasoning and the measurements are in the header of the target file.
 * Briefly: an array literal of this length costs ~37 ms to parse on every
 * service-worker cold start, a single string ~13 ms, and under MV3 that start
 * happens constantly. Do not "tidy" this back into an array.
 *
 * `JSON.stringify` on the joined string is what escapes it safely -- hostnames
 * are filtered to `[a-z0-9.-]` above, so nothing exotic can appear, but the
 * escaping should not depend on that filter staying correct.
 */
const body = `${GENERATED_MARKER} — rewritten by scripts/updateBlocklist.mjs ===

/** Where the current entries came from. Rewritten by the update script. */
export const PHISHING_LIST_SOURCE = {
  name: "MetaMask/eth-phishing-detect",
  fetchedAt: ${JSON.stringify(new Date().toISOString().slice(0, 10))} as string | undefined,
} as const;

/** ${hosts.length.toLocaleString("en-US")} hosts, newline-delimited. */
const PHISHING_HOST_LIST = ${JSON.stringify(hosts.join("\n"))};
`;

writeFileSync(TARGET, existing.slice(0, markerAt) + body);
console.log(`wrote ${hosts.length} hosts to ${TARGET}`);
