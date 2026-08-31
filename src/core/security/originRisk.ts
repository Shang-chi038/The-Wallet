import { isKnownPhishingHost } from "./phishingHosts";
import { NO_ORIGIN_RISK, type OriginRisk } from "./originRiskDescription";

/**
 * What the wallet can say about the site making a request.
 *
 * ===========================================================================
 * WARN, NEVER BLOCK
 * ===========================================================================
 * Nothing here refuses a request. A hard block fails closed on a false
 * positive -- and the false positive lands on someone trying to use their own
 * money, with no way to tell the wallet it is wrong. Worse, a wallet that
 * blocks is a wallet users learn to work around, usually by disabling the
 * feature entirely and losing the warnings that WERE right.
 *
 * So this produces a sentence for the approval screen, and the buttons stay
 * where they are.
 *
 * ===========================================================================
 * THREE SIGNALS, AND ONLY ONE OF THEM GOES STALE
 * ===========================================================================
 * A blocklist is the obvious mechanism and the weakest one: it knows only what
 * it was told, and phishing domains are registered by the hundred and
 * discarded within days. It is here because it is cheap and additive, not
 * because it is the defence.
 *
 * The other two need no list and cannot go out of date:
 *
 *   ENCODED CHARACTERS. A host with an `xn--` label contains non-ASCII
 *   characters chosen to be rendered as something else -- the whole point of
 *   an IDN homograph attack. The user cannot be expected to notice a Cyrillic
 *   "a", so the wallet says the address is not what it appears to be.
 *
 *   LOOKALIKES OF SITES THE USER ALREADY USES. This is the strongest signal
 *   available and it comes free: the user's own connection list is a list of
 *   domains they have decided to trust, and a first-time visitor one or two
 *   characters away from one of them is the shape of every phishing domain
 *   ever registered. It is high-signal precisely because it is personal --
 *   no blocklist can know that THIS user banks at THAT domain.
 */



/**
 * Below this many characters, a one-character difference between two domains is
 * usually two unrelated short names rather than an imitation.
 */
const MINIMUM_LOOKALIKE_LENGTH = 5;

/**
 * Edits away from a known domain that still counts as an imitation.
 *
 * Two, but only for a domain long enough for two edits to be deliberate. On a
 * short name the distance collapses: `aave.com` and `wave.com` are two edits
 * apart and unrelated, and a warning that fires on ordinary browsing is one the
 * user learns to scroll past -- taking the warnings that were right with it.
 */
const MAXIMUM_LOOKALIKE_DISTANCE = 2;
const SHORT_DOMAIN_LENGTH = 8;
const SHORT_DOMAIN_LOOKALIKE_DISTANCE = 1;

/**
 * The host of an origin, lowercased, or undefined when there isn't one.
 *
 * `new URL("about:blank").origin` is the string "null", and every opaque origin
 * shares it -- see the trap in CLAUDE.md. Anything that does not parse as an
 * http(s) URL with a host gets no risk assessment rather than a wrong one.
 */
export function toHost(origin: string | undefined): string | undefined {
  if (!origin || origin === "null") return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does `host` fall under `listed`?
 *
 * Exact match or a subdomain, never a substring. Substring matching is how a
 * blocklist ends up flagging `myuniswap-notes.com` for containing "uniswap" --
 * and, far worse, how `uniswap.org.attacker.com` gets a pass for containing a
 * good domain. The dot in the suffix check is what makes the difference.
 */
function isHostUnder(host: string, listed: string): boolean {
  return host === listed || host.endsWith(`.${listed}`);
}

/**
 * Does a trusted domain appear INSIDE this host without being its owner?
 *
 * `uniswap.org.attacker.com` belongs to attacker.com and reads, at a glance,
 * as uniswap.org -- the labels a user scans first are the ones furthest from
 * the part that decides ownership. This is the oldest trick in the list and it
 * needs no blocklist to spot: the domain is present as a label sequence, and it
 * is not the registrable domain.
 *
 * The `.` boundaries are what keep it from matching `notuniswap.org.com`; the
 * `isHostUnder` check ahead of it is what keeps a genuine subdomain out.
 */
function embedsDomainLabels(host: string, listed: string): boolean {
  return host.startsWith(`${listed}.`) || host.includes(`.${listed}.`);
}

/**
 * The registrable-looking part of a host: the last two labels.
 *
 * A deliberate approximation. Doing this exactly needs the Public Suffix List,
 * which is ~9,000 entries that would have to ship in the bundle and go stale
 * anyway. The approximation is wrong for multi-part suffixes -- `co.uk` reduces
 * to "co.uk" -- and the consequence is bounded: two `.co.uk` sites compare as
 * equal and produce no lookalike warning. A missed warning, never a false one,
 * which is the right direction for a signal that costs the user attention.
 */
function toComparableDomain(host: string): string {
  const labels = host.split(".");
  return labels.slice(-2).join(".");
}

/**
 * Levenshtein distance, bounded.
 *
 * Stops as soon as every cell in a row exceeds the limit, so a comparison
 * against a long connection list stays cheap -- this runs on the path that
 * opens an approval window, where a user is waiting.
 */
export function editDistanceWithin(left: string, right: string, limit: number): number | undefined {
  if (Math.abs(left.length - right.length) > limit) return undefined;

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] as number) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const deletion = (previous[rightIndex] as number) + 1;
      const insertion = (current[rightIndex - 1] as number) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current.push(best);
      rowMinimum = Math.min(rowMinimum, best);
    }
    if (rowMinimum > limit) return undefined;
    previous = current;
  }

  const distance = previous[right.length] as number;
  return distance <= limit ? distance : undefined;
}

export interface AssessOriginRiskParams {
  origin: string | undefined;
  /**
   * Origins the user has already connected. The wallet's own trust list, used
   * as the reference set for lookalikes.
   */
  connectedOrigins: readonly string[];
}

/**
 * The one entry point. Highest-severity signal wins.
 *
 * Order is not arbitrary: a host on the blocklist is a stated fact about that
 * exact domain, encoded characters are a property of the string itself, and a
 * lookalike is an inference. Reporting the strongest thing the wallet actually
 * knows keeps the sentence on the approval screen specific.
 */
export function assessOriginRisk({
  origin,
  connectedOrigins,
}: AssessOriginRiskParams): OriginRisk {
  const host = toHost(origin);
  if (!host) return NO_ORIGIN_RISK;

  if (isKnownPhishingHost(host)) {
    return { level: "knownPhishing" };
  }

  // "xn--" marks a Punycode label: the host contains characters that render as
  // something other than what they are.
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { level: "encodedCharacters" };
  }

  /**
   * THE WHOLE LIST IS WALKED. NOTHING RETURNS FROM INSIDE THE LOOP.
   *
   * Each branch below answers a question about ONE connected origin, and three
   * of them used to answer it with `return NO_ORIGIN_RISK` -- which ended the
   * walk and skipped every origin after it. The verdict therefore depended on
   * the order the user happened to connect their sites, which is
   * `Object.keys(grants)`, which is insertion order.
   *
   * An attacker could arrange that order: get one harmless connection under
   * their own registrable domain first, and every later phishing host under it
   * compared "same domain, not an imitation" against that entry and returned
   * before ever reaching the domain being imitated. `uniswap.org.attacker.com`
   * -- the exact shape `embedsDomainLabels` exists to catch -- came back clean
   * when `dapp.attacker.com` was connected first, and flagged when it was
   * connected second. Same set, same host, opposite answers.
   *
   * So findings are COLLECTED and ranked after the walk.
   */
  const domain = toComparableDomain(host);
  if (domain.length >= MINIMUM_LOOKALIKE_LENGTH) {
    let isUserOwnDomain = false;
    let embedded: OriginRisk | undefined;
    let nearMiss: OriginRisk | undefined;

    for (const connected of connectedOrigins) {
      const connectedHost = toHost(connected);
      if (!connectedHost) continue;

      /**
       * THE TWO DIRECTIONS OF "RELATED" ARE NOT EQUALLY STRONG, and collapsing
       * them into one veto hands the attacker the suppression back.
       *
       * HOST UNDER A CONNECTED SITE (`app.uniswap.org` when `uniswap.org` is
       * connected) is strong: the user has explicitly trusted this domain, and
       * its own subdomains should not be accused of imitating anything.
       *
       * A CONNECTED SITE UNDER THE HOST (`notes.unisw0p.org` connected, host
       * now `unisw0p.org`) is weak, and reading it as trust is the bug in
       * reverse: a grant to a subdomain is not a grant to its parent -- the
       * parent still has to run `eth_requestAccounts`, and THAT prompt is
       * exactly where the warning belongs. An attacker with one harmless
       * subdomain connection would otherwise silence the typosquat warning on
       * the domain they actually phish from.
       *
       * Either way this entry is not the one being imitated, so the walk
       * continues; only the strong direction records a veto.
       */
      if (isHostUnder(host, connectedHost)) {
        isUserOwnDomain = true;
        continue;
      }
      if (isHostUnder(connectedHost, host)) continue;

      if (!embedded && embedsDomainLabels(host, connectedHost)) {
        embedded = { level: "lookalike", resembles: connectedHost };
        continue;
      }

      const connectedDomain = toComparableDomain(connectedHost);
      // Same registrable domain, so not an imitation OF THIS ENTRY. That says
      // nothing whatever about the rest of the list, which is why it continues.
      if (connectedDomain === domain) continue;

      if (nearMiss) continue;
      const limit =
        Math.min(domain.length, connectedDomain.length) < SHORT_DOMAIN_LENGTH
          ? SHORT_DOMAIN_LOOKALIKE_DISTANCE
          : MAXIMUM_LOOKALIKE_DISTANCE;
      const distance = editDistanceWithin(domain, connectedDomain, limit);
      if (distance !== undefined && distance > 0) {
        nearMiss = { level: "lookalike", resembles: connectedDomain };
      }
    }

    /**
     * Ranked, and the order is the point.
     *
     * An EMBEDDED trusted domain outranks "the user has connected this domain".
     * `uniswap.org.attacker.com` is a subdomain of an attacker.com the user may
     * well have connected once, and that connection is not consent to every
     * subdomain of it -- the label sequence is a structural fact about THIS
     * host, and it is the oldest trick in the list.
     *
     * A NEAR MISS ranks below it, because an edit distance is an inference
     * rather than a fact, and a genuine subdomain of a site the user already
     * uses should not be accused on the strength of one. Someone who has
     * connected both `uniswap.org` and a one-character neighbour of it gets no
     * warning on their own subdomains.
     */
    if (embedded) return embedded;
    if (isUserOwnDomain) return NO_ORIGIN_RISK;
    if (nearMiss) return nearMiss;
  }

  return NO_ORIGIN_RISK;
}

/**
 * Re-exported so `originRisk.ts` remains the one surface for origin risk.
 * The definitions live in `originRiskDescription.ts` because the approval
 * window needs them without needing the blocklist -- see that file's header.
 */
export {
  NO_ORIGIN_RISK,
  describeOriginRisk,
  type OriginRisk,
  type OriginRiskLevel,
} from "./originRiskDescription";
