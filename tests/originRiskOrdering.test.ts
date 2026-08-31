import { describe, expect, it } from "vitest";
import { assessOriginRisk } from "@/core/security/originRisk";

/**
 * THE VERDICT MUST NOT DEPEND ON CONNECTION ORDER.
 *
 * `assessOriginRisk` walks the user's connected origins. Three of its branches
 * used to answer "not a lookalike of THIS one" with `return NO_ORIGIN_RISK`,
 * which ended the whole walk and skipped every origin after it. Since the list
 * is `Object.keys(grants)` -- insertion order -- the answer depended on the
 * order the user happened to connect their sites, and an attacker could
 * arrange it by getting one harmless connection under their own domain first.
 *
 * Every case below is asserted in BOTH orders. That is the actual property;
 * checking one order is what let this survive.
 */

function bothOrders(origin: string, connected: [string, string]) {
  const forward = assessOriginRisk({ origin, connectedOrigins: connected });
  const reversed = assessOriginRisk({
    origin,
    connectedOrigins: [connected[1], connected[0]],
  });
  expect(forward).toEqual(reversed);
  return forward;
}

describe("lookalike detection is order-independent", () => {
  it("flags an embedded trusted domain whichever way round the list is", () => {
    // Reads as uniswap.org; owned by attacker.com. The attacker has also got
    // the user to connect a harmless dApp on their own domain.
    expect(
      bothOrders("https://uniswap.org.attacker.com", [
        "https://uniswap.org",
        "https://dapp.attacker.com",
      ]),
    ).toEqual({ level: "lookalike", resembles: "uniswap.org" });
  });

  it("is not disarmed by an unrelated site on a shared hosting suffix", () => {
    // Both hosts reduce to the comparable domain `pages.dev`, which used to
    // short-circuit the walk before `uniswap.org` was ever examined.
    expect(
      bothOrders("https://uniswap.org.evil.pages.dev", [
        "https://alice.pages.dev",
        "https://uniswap.org",
      ]),
    ).toEqual({ level: "lookalike", resembles: "uniswap.org" });
  });

  /**
   * The connected origin here is a SUBDOMAIN of the host being judged -- the
   * weak direction. A grant to `notes.unisw0p.org` is not a grant to
   * `unisw0p.org`, which still has to ask for accounts; treating it as trust
   * would let an attacker buy silence with one harmless subdomain connection.
   */
  it("flags a typosquat that has connected one of its own subdomains", () => {
    expect(
      bothOrders("https://unisw0p.org", [
        "https://uniswap.org",
        "https://notes.unisw0p.org",
      ]),
    ).toEqual({ level: "lookalike", resembles: "uniswap.org" });
  });
});

describe("the ranking between signals", () => {
  it("an embedded trusted domain outranks the user having connected the parent", () => {
    // Connecting `attacker.com` once is not consent to every subdomain of it,
    // and the label sequence is a fact about THIS host.
    expect(
      assessOriginRisk({
        origin: "https://uniswap.org.attacker.com",
        connectedOrigins: ["https://attacker.com", "https://uniswap.org"],
      }),
    ).toEqual({ level: "lookalike", resembles: "uniswap.org" });
  });

  it("a genuine subdomain of a connected site is not accused on edit distance", () => {
    // Host is UNDER a connected site -- the strong direction. The user has
    // explicitly trusted this domain, so its subdomains are not accused of
    // imitating the near neighbour they also connected.
    expect(
      assessOriginRisk({
        origin: "https://app.uniswap.org",
        connectedOrigins: ["https://uniswap.org", "https://uniswop.org"],
      }),
    ).toEqual({ level: "none" });
  });

  it("still says nothing about a site the user has plainly connected", () => {
    expect(
      assessOriginRisk({
        origin: "https://app.uniswap.org",
        connectedOrigins: ["https://uniswap.org"],
      }),
    ).toEqual({ level: "none" });
  });

  it("still says nothing about an unremarkable stranger", () => {
    expect(
      assessOriginRisk({
        origin: "https://example.com",
        connectedOrigins: ["https://uniswap.org", "https://aave.com"],
      }),
    ).toEqual({ level: "none" });
  });
});
