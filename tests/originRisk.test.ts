import { describe, expect, it } from "vitest";
import {
  assessOriginRisk,
  describeOriginRisk,
  editDistanceWithin,
  toHost,
} from "@/core/security/originRisk";
import {
  isKnownPhishingHost,
  listPhishingHosts,
  PHISHING_LIST_SOURCE,
} from "@/core/security/phishingHosts";
import type { ApprovalPresentation } from "@/core/approval/approvalRequest";
import {
  createHarness,
  expectResult,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
} from "./support/routerHarness";

/**
 * What the wallet says about the site making a request.
 *
 * Two properties are load-bearing and everything here defends one of them:
 *
 *   IT NEVER BLOCKS. A false positive must cost the user a sentence, not
 *   access to their own money.
 *
 *   IT NEVER MATCHES BY SUBSTRING. Substring matching flags innocent domains
 *   for containing a good name, and -- the dangerous direction -- passes
 *   `uniswap.org.attacker.com` for the same reason.
 */

describe("toHost", () => {
  it("reads the host out of an origin", () => {
    expect(toHost("https://app.uniswap.org")).toBe("app.uniswap.org");
    expect(toHost("https://APP.Uniswap.ORG")).toBe("app.uniswap.org");
  });

  /**
   * `new URL("about:blank").origin` is the STRING "null", and every opaque
   * origin shares it -- see the trap in CLAUDE.md. Nothing may be inferred
   * from it.
   */
  it("has nothing to say about an origin that is not a website", () => {
    for (const origin of [undefined, "", "null", "about:blank", "chrome-extension://abc", "junk"]) {
      expect(toHost(origin)).toBeUndefined();
    }
  });
});

describe("editDistanceWithin", () => {
  it("measures edits up to the limit and gives up past it", () => {
    expect(editDistanceWithin("uniswap.org", "uniswap.org", 2)).toBe(0);
    expect(editDistanceWithin("uniswap.org", "unlswap.org", 2)).toBe(1);
    expect(editDistanceWithin("uniswap.org", "un1swaps.org", 2)).toBe(2);
    expect(editDistanceWithin("uniswap.org", "completelyother.com", 2)).toBeUndefined();
  });
});

describe("assessOriginRisk", () => {
  const connected = ["https://app.uniswap.org"];

  it("says nothing about a site with no signal against it", () => {
    expect(assessOriginRisk({ origin: "https://etherscan.io", connectedOrigins: [] })).toEqual({
      level: "none",
    });
  });

  /**
   * The signal that needs no list and cannot go stale: a first visit to a
   * near-copy of a domain this user has already connected.
   */
  it("flags a near-copy of a site the user already connected", () => {
    const risk = assessOriginRisk({
      origin: "https://app.unlswap.org",
      connectedOrigins: connected,
    });
    expect(risk.level).toBe("lookalike");
    expect(risk.resembles).toBe("uniswap.org");
  });

  it("says nothing about the connected site itself, or another subdomain of it", () => {
    for (const origin of ["https://app.uniswap.org", "https://info.uniswap.org"]) {
      expect(assessOriginRisk({ origin, connectedOrigins: connected }).level).toBe("none");
    }
  });

  /**
   * A Punycode label means the host contains characters that render as
   * something other than what they are -- the mechanism of every IDN homograph
   * attack, and one no user can be expected to spot.
   */
  it("flags a host with encoded characters in it", () => {
    // xn--nsw-... is an IDN label; what matters is the xn-- prefix.
    const risk = assessOriginRisk({
      origin: "https://xn--uniswp-8va.org",
      connectedOrigins: [],
    });
    expect(risk.level).toBe("encodedCharacters");
  });

  /**
   * The direction that matters. `uniswap.org.attacker.com` is a domain the
   * attacker controls, and a substring match would clear it precisely because
   * it contains a name the user trusts.
   */
  it("does not treat a trusted name inside another domain as trusted", () => {
    const risk = assessOriginRisk({
      origin: "https://app.uniswap.org.attacker.com",
      connectedOrigins: connected,
    });
    expect(risk.level).toBe("lookalike");
    expect(risk.resembles).toBe("app.uniswap.org");
  });

  it("does not flag a long-established different name that merely reads similarly", () => {
    expect(
      assessOriginRisk({ origin: "https://opensea.io", connectedOrigins: connected }).level,
    ).toBe("none");
  });

  /**
   * On a short name two edits stop meaning anything: `aave.com` and `wave.com`
   * are two apart and unrelated. A warning that fires during ordinary browsing
   * is one the user learns to scroll past, taking the right ones with it.
   */
  it("requires a closer match on short domains", () => {
    const usesShortDomain = ["https://app.gmx.io"];
    // Two edits on a six-character name is most of the name. Unrelated.
    expect(
      assessOriginRisk({ origin: "https://qmz.io", connectedOrigins: usesShortDomain }).level,
    ).toBe("none");
    // One edit is still an imitation, however short the name.
    expect(
      assessOriginRisk({ origin: "https://qmx.io", connectedOrigins: usesShortDomain }).level,
    ).toBe("lookalike");
  });

  /**
   * And the budget stays at two for a name long enough that two edits are
   * deliberate rather than coincidental.
   */
  it("still catches a two-edit imitation of a longer domain", () => {
    expect(
      assessOriginRisk({ origin: "https://app.un1swaps.org", connectedOrigins: connected }).level,
    ).toBe("lookalike");
  });

  it("has nothing to say about an opaque origin", () => {
    expect(assessOriginRisk({ origin: "null", connectedOrigins: connected }).level).toBe("none");
  });

  /**
   * The SHAPE the list must keep, so an update script that writes entries with
   * a scheme, a path or an uppercase label is caught before those entries
   * silently match nothing. `toHost` lowercases and strips both, so an entry
   * carrying either can never be equal to anything it is compared against --
   * a blocklist that fails open, quietly, with a full-looking list.
   */
  it("keeps the bundled list in bare-hostname form", () => {
    /**
     * Checked in plain JavaScript with a single assertion at the end. Calling
     * `expect` per host is ~390,000 assertions and took 5.6 seconds on its
     * own; the failure this needs to produce is "which entries are malformed",
     * which a collected list says better than the first one to throw.
     */
    const malformed = listPhishingHosts().filter(
      (host) =>
        !/^[a-z0-9.-]+$/.test(host) ||
        !host.includes(".") ||
        host.startsWith(".") ||
        host.endsWith("."),
    );
    expect(malformed.slice(0, 10)).toEqual([]);
  });

  /**
   * The list ships populated, and it should be obvious when it stops being.
   *
   * `updateBlocklist.mjs` refuses to write an empty list, but nothing stops a
   * merge or a bad rebase from landing one, and the failure mode is a security
   * feature that is simply off -- with no error anywhere, because an empty
   * blocklist behaves exactly like a clean browsing session.
   */
  it("ships a populated list from a named source", () => {
    expect(listPhishingHosts().length).toBeGreaterThan(1000);
    expect(PHISHING_LIST_SOURCE.name).not.toBe("none");
    expect(PHISHING_LIST_SOURCE.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * The suffix walk in `isKnownPhishingHost` replaced a scan over every
   * bundled host, because at ~98,000 entries that scan cost 4.4 ms on the path
   * that renders an approval. The two must agree exactly, and "exactly" here
   * means over the real list rather than over a handful of examples -- so this
   * runs the naive predicate the walk replaced against every entry, plus the
   * cases where a cheaper implementation would diverge.
   *
   * A STRIDE SAMPLE, not the whole list. Checking every host against the naive
   * predicate is a cross product -- ~98,000 probes over a ~98,000-entry scan,
   * around nine billion string comparisons, which took 282 seconds and blew
   * the worker timeout. The stride walks the entire alphabetical range rather
   * than the first N, so it is a sample of the list's whole shape and not of
   * its beginning. The exhaustive sweep was run once, out of band, over all
   * 97,730 hosts with zero disagreements; this keeps a fast standing check.
   */
  it("matches the naive scan it replaced", () => {
    const hosts = listPhishingHosts();
    const naive = (host: string): boolean =>
      hosts.some((listed) => host === listed || host.endsWith(`.${listed}`));

    const first = hosts[0];
    const middle = hosts[Math.floor(hosts.length / 2)];
    expect(first).toBeDefined();
    expect(middle).toBeDefined();

    const stride = Math.max(1, Math.floor(hosts.length / 750));
    const sampled = hosts.filter((_, index) => index % stride === 0);

    const probes = [
      ...sampled,
      // A subdomain of a listed host: must match.
      `login.${first}`,
      `a.b.${middle}`,
      // Substring, not subdomain: must NOT match, in both directions.
      `not${first}`,
      `${first}.attacker.com`,
      `x${middle}`,
      // Unrelated, and the shapes the walk terminates on.
      "app.uniswap.org",
      "example.com",
      "localhost",
      "com",
    ];

    for (const probe of probes) {
      expect(isKnownPhishingHost(probe), `disagreed on ${probe}`).toBe(naive(probe));
    }
  });

  /**
   * The one that matters most, stated on its own rather than left inside the
   * equivalence sweep: a listed host must not clear a domain that merely
   * CONTAINS it. `uniswap.org.attacker.com` belongs to attacker.com.
   */
  it("matches a subdomain but never a substring", () => {
    const listed = listPhishingHosts()[0];
    expect(listed).toBeDefined();
    expect(isKnownPhishingHost(String(listed))).toBe(true);
    expect(isKnownPhishingHost(`deep.sub.${String(listed)}`)).toBe(true);
    expect(isKnownPhishingHost(`${String(listed)}.attacker.com`)).toBe(false);
    expect(isKnownPhishingHost(`prefix${String(listed)}`)).toBe(false);
  });
});

describe("describeOriginRisk", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeOriginRisk({ level: "none" })).toBeUndefined();
  });

  it("names the site a lookalike is imitating", () => {
    const described = describeOriginRisk({ level: "lookalike", resembles: "uniswap.org" });
    expect(described?.title).toContain("uniswap.org");
  });
});

describe("origin risk on the approval screen", () => {
  /**
   * Assessed at the single point every prompt is built from, so a new approval
   * kind cannot ship without it. This checks it through the router rather than
   * by calling the assessor, because the property is "every prompt carries it".
   */
  it("reaches the prompt for a site that imitates a connected one", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    // One character away from the origin connected above, and never seen
    // before. `eth_requestAccounts` rather than a signature, because an
    // unconnected origin cannot reach the signing path at all -- which is the
    // router working correctly, and the reason a connect prompt is where this
    // warning earns its place.
    const lookalike = { ...PAGE_SENDER, origin: "https://apq.example" };
    const pending = harness.route({ method: "eth_requestAccounts", params: [] }, lookalike);
    await harness.waitForPendingApproval();

    const presentation = harness.context.approvalService.listPending()[0] as ApprovalPresentation;
    expect(presentation.originRisk.level).toBe("lookalike");

    await harness.answerNextApproval(false);
    await pending;
  });

  it("says nothing about an ordinary first-time site", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pending = harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER);
    await harness.waitForPendingApproval();

    const presentation = harness.context.approvalService.listPending()[0] as ApprovalPresentation;
    expect(presentation.originRisk.level).toBe("none");

    await harness.answerNextApproval(true, [TEST_ADDRESS]);
    await pending;
    // And the wallet's own status is unaffected by any of it.
    expect(
      expectResult<{ accounts: unknown[] }>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      ).accounts.length,
    ).toBeGreaterThan(0);
  });
});
