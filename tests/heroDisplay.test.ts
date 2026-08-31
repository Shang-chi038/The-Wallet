import { describe, expect, it } from "vitest";
import { formatFiatForHero, splitHeroValue } from "@/core/token/fiatDisplay";
import { assetGlyph, glyphSizeRatio } from "@/ui/components";

describe("splitHeroValue", () => {
  it("separates cents so they can be de-emphasised", () => {
    expect(splitHeroValue("$285,934.18")).toEqual({ primary: "$285,934", cents: ".18" });
  });

  it("returns no cents when the figure is whole", () => {
    expect(splitHeroValue("$285,934")).toEqual({ primary: "$285,934", cents: "" });
  });

  /**
   * An abbreviated figure's decimal is a SIGNIFICANT digit, not a rounding
   * tail. Fading the ".9" in "₦438.9M" would misrepresent the magnitude.
   */
  it("never de-emphasises the decimal of an abbreviated figure", () => {
    for (const abbreviated of ["₦438.9M", "$2.4B", "$1.5T", "$12.3K"]) {
      expect(splitHeroValue(abbreviated)).toEqual({ primary: abbreviated, cents: "" });
    }
  });

  it("keeps a whole abbreviated figure intact", () => {
    expect(splitHeroValue("$2B")).toEqual({ primary: "$2B", cents: "" });
  });

  it("round-trips: primary + cents reconstructs the original", () => {
    for (const amount of [0, 1234.5, 285934.18, 438909466, 999.99]) {
      const formatted = formatFiatForHero(amount, "USD");
      const { primary, cents } = splitHeroValue(formatted);
      expect(primary + cents).toBe(formatted);
    }
  });

  it("handles a negative balance", () => {
    expect(splitHeroValue("-$1,234.50")).toEqual({ primary: "-$1,234", cents: ".50" });
  });
});

describe("asset glyphs", () => {
  /**
   * The spec uses currency signs rather than letters. This also resolves the
   * collision a lettermark cannot: USDC and USDT both begin with "U", which
   * would leave colour as the sole differentiator — invisible to a colour-blind
   * user and against the design rule.
   */
  it("uses the asset's own currency sign", () => {
    expect(assetGlyph("BTC")).toBe("₿");
    expect(assetGlyph("USDT")).toBe("₮");
    expect(assetGlyph("USDC")).toBe("$");
    expect(assetGlyph("ETH")).toBe("Ξ");
  });

  it("gives USDC and USDT visibly different glyphs", () => {
    expect(assetGlyph("USDC")).not.toBe(assetGlyph("USDT"));
  });

  it("falls back to a letter for assets with no currency sign", () => {
    expect(assetGlyph("TRX")).toBe("T");
    expect(assetGlyph("DAI")).toBe("D");
  });

  it("is case-insensitive", () => {
    expect(assetGlyph("btc")).toBe(assetGlyph("BTC"));
  });

  /** ₿ ₮ Ξ and $ have different optical weights at the same point size. */
  it("sizes each glyph individually", () => {
    expect(glyphSizeRatio("BTC")).not.toBe(glyphSizeRatio("USDC"));
    for (const symbol of ["BTC", "USDT", "USDC", "ETH", "TRX"]) {
      const ratio = glyphSizeRatio(symbol);
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(0.6);
    }
  });
});
