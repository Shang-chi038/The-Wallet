/**
 * Origin risk, the half the approval WINDOW needs.
 *
 * WHY THIS IS A SEPARATE FILE -- the same reason `passwordPolicy.ts` is not in
 * `walletService.ts`. The approval screen has to render a sentence about the
 * risk, so it needs `describeOriginRisk` and the type. Importing those from
 * `originRisk.ts` drags in `phishingHosts.ts`, which is ~2 MB of blocklist,
 * into the one screen where a click authorises a signature -- 2,071 kB
 * preloaded before the window can paint, to print one line of text it was
 * handed already.
 *
 * The split is by AUDIENCE, not by tidiness. Assessing risk needs the list and
 * happens once, in the background, in `baseApproval`. Describing a risk that
 * has already been assessed needs nothing but the level. `originRisk.ts`
 * re-exports everything here, so the engine still reads as one surface and no
 * existing import had to move.
 *
 * This file must stay import-free. That is the entire point of it.
 */

export type OriginRiskLevel = "none" | "lookalike" | "encodedCharacters" | "knownPhishing";

export interface OriginRisk {
  level: OriginRiskLevel;
  /**
   * The connected domain this one resembles. Present for "lookalike" only, and
   * it is the useful half of that warning -- "this looks like uniswap.org" is
   * something the user can act on; "this looks suspicious" is not.
   */
  resembles?: string | undefined;
}

export const NO_ORIGIN_RISK: OriginRisk = { level: "none" };

/**
 * The warning, in the user's terms.
 *
 * Each one names what was observed and what it would mean, because "this site
 * may be dangerous" tells the user nothing they can check. Kept here rather
 * than in the approval window so the wording is testable.
 */
export function describeOriginRisk(risk: OriginRisk): { title: string; body: string } | undefined {
  switch (risk.level) {
    case "knownPhishing":
      return {
        title: "This site is on a known-phishing list",
        body: "This domain has been reported for stealing funds. Nothing you sign here can be undone. Close this and go to the site by typing its address yourself.",
      };
    case "encodedCharacters":
      return {
        title: "This address is not what it looks like",
        body: "The domain contains characters that display as ordinary letters but are not -- the standard way of imitating a site you trust. Check the address carefully before continuing.",
      };
    case "lookalike":
      return {
        title: `This is not ${risk.resembles ?? "a site you use"}`,
        body: `The domain is a near-copy of ${risk.resembles ?? "a site you have connected before"}, which you have used before -- and this is your first visit here. That is what a phishing domain looks like.`,
      };
    case "none":
      return undefined;
  }
}
