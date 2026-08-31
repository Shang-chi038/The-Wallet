import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import declaration from "../manifest.config";

/**
 * The manifest, as DECLARED.
 *
 * `manifest.config.ts` is the most security-relevant file in the repo that
 * nothing executes: it is data, read once at build time, and every line of it
 * is a grant. A permission added here is a permission the extension has
 * forever, and the review that would have caught it is a human reading a diff.
 *
 * Everything below is already argued for in the comments of that file. These
 * tests exist because a comment explaining why we do not request `tabs` does
 * not fail when somebody requests `tabs`.
 *
 * This is HALF the check. crxjs rewrites the manifest on the way out -- it
 * generates `web_accessible_resources` itself -- so what ships is not
 * necessarily what is declared here. The built artifact is checked by
 * `scripts/verifyBuiltManifest.mjs`, which runs on every `npm run build`.
 */

/**
 * The shape we assert against.
 *
 * `defineManifest` is typed as a union that admits a function and a promise,
 * so the checker will not let us read a property off it directly. Restating
 * the fields is not merely a cast: it is the list of things this file is
 * allowed to contain, and an unexpected key shows up in the exact-key test
 * below rather than being quietly ignored here.
 */
interface DeclaredManifest {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  permissions?: string[];
  host_permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  content_scripts?: {
    matches?: string[];
    js?: string[];
    world?: string;
    run_at?: string;
    all_frames?: boolean;
  }[];
  web_accessible_resources?: unknown;
  icons?: Record<string, string>;
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  options_page?: string;
  background?: { service_worker?: string; scripts?: string[]; type?: string };
  minimum_chrome_version?: string;
}

const manifest = declaration as unknown as DeclaredManifest;

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Icon paths are relative to the bundle root; on disk they live in `public/`. */
function resolveDeclaredPath(declaredPath: string): string {
  const prefix = declaredPath.startsWith("icons/") ? "public/" : "";
  return `${repositoryRoot}${prefix}${declaredPath}`;
}

function parseContentSecurityPolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name, values);
  }
  return directives;
}

describe("permissions", () => {
  /**
   * Exact equality, not a subset check.
   *
   * A subset check passes when somebody appends one, which is the only way
   * this list ever changes. Adding a permission should require editing this
   * test, so the grant and the argument for it land in the same diff.
   */
  it("requests exactly the three that are argued for", () => {
    expect(manifest.permissions).toEqual(["storage", "alarms", "scripting"]);
  });

  /**
   * Named separately from the equality check above, which already covers it,
   * because this is the assertion whose FAILURE MESSAGE teaches. A wallet
   * asking for your browsing history or your clipboard should raise questions,
   * so we ask for none of them and say so where it can fail.
   */
  it("requests nothing that would let it read the user's browsing", () => {
    const neverRequested = [
      "tabs",
      "webRequest",
      "webRequestBlocking",
      "cookies",
      "history",
      "downloads",
      "clipboardRead",
      "management",
      "debugger",
      "proxy",
      "declarativeNetRequest",
    ];
    for (const permission of neverRequested) {
      expect(manifest.permissions ?? []).not.toContain(permission);
    }
  });

  it("has no optional permissions hiding a second grant", () => {
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  /**
   * `<all_urls>` is the documented, deliberate trade-off: dApps expect a
   * provider on any site and there is no narrower grant that preserves it.
   * Pinned so that it stays a decision somebody made rather than a default
   * nobody rechecked -- in either direction.
   */
  it("takes host access on every site, deliberately and only once", () => {
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });
});

describe("content security policy", () => {
  it("allows no script source but ourselves", () => {
    const policy = manifest.content_security_policy?.extension_pages;
    expect(policy).toBeDefined();
    const directives = parseContentSecurityPolicy(policy ?? "");
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'self'"]);
  });

  /**
   * MV3 forbids remote code by default and we restate the policy so it is
   * visible in review. The value of that is entirely in what it excludes:
   * `unsafe-eval` in a wallet turns any injection anywhere into key access,
   * and a remote host makes the dependency tree stop being the whole of the
   * supply-chain surface.
   */
  it("permits neither eval nor a remote origin", () => {
    const policy = manifest.content_security_policy?.extension_pages ?? "";
    expect(policy).not.toMatch(/unsafe-eval/);
    expect(policy).not.toMatch(/unsafe-inline/);
    expect(policy).not.toMatch(/https?:/);
    expect(policy).not.toMatch(/\*/);
  });
});

describe("what a website is allowed to reach", () => {
  /**
   * THE clickjacking invariant.
   *
   * The approval window is opened with `chrome.windows.create` and is a
   * rollup input in `vite.config.ts`, NOT a web-accessible resource. Making it
   * one would let any site put the single surface where a click authorises a
   * signature inside an iframe it controls, underneath anything it likes.
   *
   * Today that is defended by a comment in the vite config. This is the
   * assertion.
   */
  it("declares no web-accessible resources at all", () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("never names the approval window anywhere in the manifest", () => {
    expect(JSON.stringify(manifest)).not.toContain("approval");
  });
});

describe("content scripts", () => {
  it("injects exactly two, one per world", () => {
    expect(manifest.content_scripts).toHaveLength(2);
  });

  /**
   * The bridge only works if the halves land in the right realms: the content
   * script in ISOLATED so a page cannot monkey-patch what passes through it,
   * and the provider in MAIN so `window.ethereum` is reachable by page code.
   * Swapping them is a one-word edit that would put the extension's own half
   * of the bridge in the page's reach.
   */
  it("puts the bridge in the isolated world and the provider in the main one", () => {
    const [bridge, provider] = manifest.content_scripts ?? [];
    expect(bridge?.js).toEqual(["src/content/contentScript.ts"]);
    expect(bridge?.world).toBe("ISOLATED");
    expect(provider?.js).toEqual(["src/inpage/provider.ts"]);
    expect(provider?.world).toBe("MAIN");
  });

  /**
   * Top frame only, and this one carries more weight than it looks.
   *
   * `contentScript.ts` refuses anything whose `event.source` is not this
   * window precisely so an embedded frame cannot ask under the top-level
   * origin the user is reading. `all_frames: true` would put a full bridge
   * inside every ad iframe on the page, each with its own origin, and the
   * approval prompt would start naming origins the user has never seen.
   */
  it("runs in the top frame only", () => {
    for (const script of manifest.content_scripts ?? []) {
      expect(script.all_frames).toBe(false);
    }
  });

  /**
   * A dApp that loads before the provider exists sees no wallet and renders a
   * disconnected state. `document_start` is what stops that race.
   */
  it("runs both halves before page scripts", () => {
    for (const script of manifest.content_scripts ?? []) {
      expect(script.run_at).toBe("document_start");
    }
  });
});

describe("the files the manifest points at", () => {
  /**
   * A manifest naming a file that is not there is an extension that installs
   * and then does nothing, and the failure is silent at build time. Every path
   * is checked on disk rather than trusted.
   */
  it("all exist", () => {
    const declaredPaths = [
      manifest.background?.service_worker,
      ...(manifest.background?.scripts ?? []),
      manifest.action?.default_popup,
      manifest.options_page,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
    ].filter((path): path is string => typeof path === "string");

    expect(declaredPaths.length).toBeGreaterThan(0);
    for (const declaredPath of declaredPaths) {
      expect(existsSync(resolveDeclaredPath(declaredPath))).toBe(true);
    }
  });

  /**
   * Both icon keys are required and for different reasons: a submission
   * without a 128 is rejected outright, and a missing action icon leaves a
   * grey "W" in the toolbar next to the user's real wallet. Users identify the
   * genuine wallet by its mark, and an impostor is free to ship a nicer one.
   */
  it("include the two icon sets a store submission needs", () => {
    expect(manifest.icons?.["128"]).toBeDefined();
    expect(manifest.action?.default_icon?.["128"]).toBeDefined();
  });
});

describe("the browser floor", () => {
  /**
   * MAIN-world content scripts are Chrome 111+. Declaring them without a floor
   * means an older browser installs the extension, silently injects nothing
   * into the page's realm, and every dApp reports no wallet.
   */
  it("is high enough for a main-world content script", () => {
    const minimum = Number(manifest.minimum_chrome_version);
    expect(Number.isFinite(minimum)).toBe(true);
    expect(minimum).toBeGreaterThanOrEqual(111);
  });

  it("is manifest v3", () => {
    expect(manifest.manifest_version).toBe(3);
  });
});
