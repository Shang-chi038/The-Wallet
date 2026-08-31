import { describe, expect, it } from "vitest";
import { selectHeroPresentation } from "@/core/portfolio/heroPresentation";
import type { PortfolioChange } from "@/core/price/priceReader";

/**
 * ===========================================================================
 * THE ZERO THAT WAS NOT A ZERO
 * ===========================================================================
 * This decision was a ternary in `PortfolioScreen`, and with no portfolio at
 * all it fell through to `0 ETH`. An unreachable RPC therefore printed a
 * balance of zero in the largest type on the screen -- the same defect the
 * "no price is `undefined`, never `0`" rule exists to prevent, one field down
 * and considerably louder.
 *
 * Three states, and only one of them is allowed to print a zero.
 */

const NOTHING_HELD: PortfolioChange = { status: "unavailable", reason: "nothing_held" };
const NO_PRICES: PortfolioChange = { status: "unavailable", reason: "no_price_data" };

describe("hero presentation", () => {
  it("shows a dash, not a zero, when there was no successful read", () => {
    const hero = selectHeroPresentation({
      totalFiat: undefined,
      nativeBalanceLabel: undefined,
      change: NOTHING_HELD,
      isRefreshing: false,
      portfolioError: "Can't reach Sepolia",
    });

    expect(hero.figure).toEqual({ kind: "unavailable" });
    expect(hero.note).toBe("Can't reach Sepolia");
    expect(hero.canRetry).toBe(true);
  });

  it("still prints a zero the engine actually reported", () => {
    // An empty wallet is a fact, and it formats like any other number. The
    // distinction is whether a balance came back at all, never whether it was
    // greater than zero.
    const hero = selectHeroPresentation({
      totalFiat: undefined,
      nativeBalanceLabel: "0 ETH",
      change: NOTHING_HELD,
      isRefreshing: false,
      portfolioError: undefined,
    });

    expect(hero.figure).toEqual({ kind: "native", label: "0 ETH" });
    expect(hero.note).toBe("Nothing to track yet");
    expect(hero.canRetry).toBe(false);
  });

  it("falls back to the native balance when only prices are missing", () => {
    const hero = selectHeroPresentation({
      totalFiat: undefined,
      nativeBalanceLabel: "0.4218 ETH",
      change: NO_PRICES,
      isRefreshing: false,
      portfolioError: undefined,
    });

    expect(hero.figure).toEqual({ kind: "native", label: "0.4218 ETH" });
    expect(hero.note).toBe("Prices unavailable");
  });

  it("prefers the fiat total when there is one", () => {
    const hero = selectHeroPresentation({
      totalFiat: 1234.5,
      nativeBalanceLabel: "0.4218 ETH",
      change: { status: "available", percentChange: 2.5 },
      isRefreshing: false,
      portfolioError: undefined,
    });

    expect(hero.figure).toEqual({ kind: "fiat", totalFiat: 1234.5 });
  });

  it("never says the wallet is empty while the chain is unreachable", () => {
    // "Nothing to track yet" is a statement about the user's money, and this is
    // the one moment it is certainly wrong.
    const hero = selectHeroPresentation({
      totalFiat: undefined,
      nativeBalanceLabel: undefined,
      change: NOTHING_HELD,
      isRefreshing: false,
      portfolioError: "Can't reach Sepolia",
    });

    expect(hero.note).not.toBe("Nothing to track yet");
  });

  it("lets a running refresh speak over a stale failure", () => {
    // A previous failure printed over a retry in flight reads as the retry
    // having already failed, and hides the only thing that is currently true.
    const hero = selectHeroPresentation({
      totalFiat: undefined,
      nativeBalanceLabel: undefined,
      change: NOTHING_HELD,
      isRefreshing: true,
      portfolioError: "Can't reach Sepolia",
    });

    expect(hero.note).toBe("Refreshing...");
    expect(hero.canRetry).toBe(false);
  });
});
