import { describe, expect, it } from "vitest";
import {
  collapseSmallHoldings,
  describeChange,
  describeNetworks,
  formatFiatForHero,
  HERO_CHARACTER_BUDGET,
  selectOtherBucket,
} from "@/core/token/fiatDisplay";

describe("formatFiatForHero", () => {
  it("shows a normal USD balance in full", () => {
    expect(formatFiatForHero(285934.18, "USD")).toBe("$285,934.18");
  });

  /** The case the spec names: ₦438,909,466 must not shrink to unreadable. */
  it("abbreviates a long naira balance rather than shrinking it", () => {
    const formatted = formatFiatForHero(438909466, "NGN");
    expect(formatted).toBe("₦438.9M");
    expect(formatted.length).toBeLessThanOrEqual(HERO_CHARACTER_BUDGET);
  });

  it("keeps every output within the character budget", () => {
    for (const amount of [0, 1, 999.99, 1_000_000, 438_909_466, 9_999_999_999_999]) {
      for (const currency of ["USD", "NGN"] as const) {
        expect(formatFiatForHero(amount, currency).length).toBeLessThanOrEqual(
          HERO_CHARACTER_BUDGET,
        );
      }
    }
  });

  it("uses the right tier suffix", () => {
    expect(formatFiatForHero(2_400_000_000, "USD")).toBe("$2.4B");
    expect(formatFiatForHero(1_500_000_000_000, "USD")).toBe("$1.5T");
  });

  it("drops a trailing .0 from an abbreviation", () => {
    expect(formatFiatForHero(2_000_000_000, "USD")).toBe("$2B");
  });

  it("handles zero and negatives", () => {
    expect(formatFiatForHero(0, "USD")).toBe("$0.00");
    expect(formatFiatForHero(-1234.5, "USD")).toBe("-$1,234.50");
  });

  it("can be told not to abbreviate", () => {
    expect(formatFiatForHero(438909466, "NGN", { abbreviateWhenLong: false })).toBe(
      "₦438,909,466.00",
    );
  });
});

describe("describeChange", () => {
  /** Colour is never the only signal: arrow and sign carry direction too. */
  it("carries direction in the arrow and the sign, not just colour", () => {
    expect(describeChange(2.41)).toEqual({ arrow: "↑", label: "+2.41%", tone: "positive" });
    expect(describeChange(-1.2)).toEqual({ arrow: "↓", label: "-1.20%", tone: "negative" });
    expect(describeChange(0)).toEqual({ arrow: "→", label: "0.00%", tone: "neutral" });
  });
});

describe("describeNetworks", () => {
  /** One chain names it; two or more would overflow the row, so count. */
  it("names a single network", () => {
    expect(describeNetworks(["Tron"])).toBe("Tron");
  });

  it("counts multiple networks", () => {
    expect(describeNetworks(["Tron", "Ethereum", "BSC", "Polygon"])).toBe("4 networks");
  });

  it("returns nothing for no networks", () => {
    expect(describeNetworks([])).toBe("");
  });
});

describe("collapseSmallHoldings", () => {
  it("moves sub-1% holdings into Other and sorts the rest by value", () => {
    const { visible, otherValue } = collapseSmallHoldings([
      { symbol: "USDC", fiatValue: 300 },
      { symbol: "DUST", fiatValue: 0.5 },
      { symbol: "BTC", fiatValue: 700 },
    ]);
    expect(visible.map((s) => s.symbol)).toEqual(["BTC", "USDC"]);
    expect(otherValue).toBe(0.5);
  });

  it("handles an empty portfolio without dividing by zero", () => {
    expect(collapseSmallHoldings([])).toEqual({ visible: [], otherValue: 0 });
  });
});

describe("selectOtherBucket", () => {
  /** A priced, non-imported holding. Overridden per case. */
  const holding = (
    id: string,
    fiatValue: number | undefined,
    extra: { isImported?: boolean } = {},
  ) => ({ id, symbol: id.toUpperCase(), fiatValue, ...extra });

  it("collapses the sub-1% holdings and keeps the rest", () => {
    const bucket = selectOtherBucket([
      holding("eth", 700),
      holding("usdc", 290),
      holding("dust", 5),
      holding("grit", 5),
    ]);
    expect(bucket?.visible.map((entry) => entry.id)).toEqual(["eth", "usdc"]);
    expect(bucket?.collapsed.map((entry) => entry.id)).toEqual(["dust", "grit"]);
    expect(bucket?.otherValue).toBe(10);
  });

  it("collapses nothing when a single holding would be hidden", () => {
    // One asset behind an "Other" row is still one row; the swap saves nothing
    // and costs the user the asset's name.
    expect(selectOtherBucket([holding("eth", 995), holding("dust", 5)])).toBeUndefined();
  });

  /**
   * The regression this whole gate exists for: an imported token is unpriced by
   * DESIGN, so measuring it by fiat value reads it as worthless and files it
   * behind the chip. The wallet would be hiding exactly the tokens the user
   * went out of their way to add.
   */
  it("never collapses imported tokens, and does not let them suppress the bucket", () => {
    const bucket = selectOtherBucket([
      holding("eth", 700),
      holding("usdc", 290),
      holding("dust", 5),
      holding("grit", 5),
      holding("scam", undefined, { isImported: true }),
      holding("also-scam", undefined, { isImported: true }),
    ]);
    expect(bucket?.collapsed.map((entry) => entry.id)).toEqual(["dust", "grit"]);
    expect(bucket?.visible.some((entry) => entry.id === "scam")).toBe(false);
  });

  /**
   * A missing price is an OUTAGE, not a small holding. Shares are ratios and a
   * ratio needs every numerator, so one gap makes everything else look bigger
   * than it is -- and something real gets filed away as dust.
   */
  it("collapses nothing when any built-in holding has no price", () => {
    expect(
      selectOtherBucket([
        holding("eth", undefined),
        holding("usdc", 290),
        holding("dust", 5),
        holding("grit", 5),
      ]),
    ).toBeUndefined();
  });

  it("collapses nothing for an empty or worthless portfolio", () => {
    expect(selectOtherBucket([])).toBeUndefined();
    expect(selectOtherBucket([holding("eth", 0), holding("usdc", 0)])).toBeUndefined();
  });
});
