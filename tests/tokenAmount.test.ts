import { describe, expect, it } from "vitest";
import {
  formatTokenAmount,
  formatTokenAmountForDisplay,
  InvalidTokenAmountError,
  parseTokenAmount,
} from "@/core/token/tokenAmount";

const ETH = 18;
const USDC = 6;

describe("parseTokenAmount", () => {
  it("parses whole units at 18 decimals", () => {
    expect(parseTokenAmount("1", ETH)).toBe(1_000_000_000_000_000_000n);
  });

  /** The decimals bug: the same string means very different amounts. */
  it("parses the same string differently for 6 and 18 decimals", () => {
    expect(parseTokenAmount("1", USDC)).toBe(1_000_000n);
    expect(parseTokenAmount("1", ETH)).toBe(1_000_000_000_000_000_000n);
  });

  it("parses fractional amounts exactly", () => {
    expect(parseTokenAmount("0.1", ETH)).toBe(100_000_000_000_000_000n);
    expect(parseTokenAmount("1.5", USDC)).toBe(1_500_000n);
    expect(parseTokenAmount("0.000001", USDC)).toBe(1n);
  });

  it("handles a leading decimal point", () => {
    expect(parseTokenAmount(".5", ETH)).toBe(500_000_000_000_000_000n);
  });

  it("handles a trailing decimal point", () => {
    expect(parseTokenAmount("5.", USDC)).toBe(5_000_000n);
  });

  it("parses zero in its various spellings", () => {
    expect(parseTokenAmount("0", USDC)).toBe(0n);
    expect(parseTokenAmount("0.0", USDC)).toBe(0n);
    expect(parseTokenAmount("0.000000", USDC)).toBe(0n);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseTokenAmount("  2.5  ", USDC)).toBe(2_500_000n);
  });

  /** Beyond 2^53; a float-based implementation loses this. */
  it("keeps full precision on very large amounts", () => {
    expect(parseTokenAmount("123456789.123456789123456789", ETH)).toBe(
      123_456_789_123_456_789_123_456_789n,
    );
  });

  describe("rejects ambiguous or dangerous input", () => {
    it("rejects excess precision rather than silently truncating", () => {
      expect(() => parseTokenAmount("1.1234567", USDC)).toThrow(InvalidTokenAmountError);
    });

    it.each(["", " ", ".", "abc", "1.2.3", "-1", "+1", "1e18", "1,000", "0x10"])(
      "rejects %o",
      (input) => {
        expect(() => parseTokenAmount(input, USDC)).toThrow(InvalidTokenAmountError);
      },
    );

    it("rejects nonsensical decimals", () => {
      expect(() => parseTokenAmount("1", -1)).toThrow(InvalidTokenAmountError);
      expect(() => parseTokenAmount("1", 1.5)).toThrow(InvalidTokenAmountError);
    });
  });
});

describe("formatTokenAmount", () => {
  it("round-trips with parseTokenAmount", () => {
    for (const value of ["1", "0.1", "123.456", "0.000001", "999999.999999"]) {
      expect(formatTokenAmount(parseTokenAmount(value, USDC), USDC)).toBe(value);
    }
  });

  it("formats zero", () => {
    expect(formatTokenAmount(0n, ETH)).toBe("0");
  });

  it("strips trailing zeros by default", () => {
    expect(formatTokenAmount(1_500_000n, USDC)).toBe("1.5");
  });

  it("keeps trailing zeros when asked", () => {
    expect(formatTokenAmount(1_500_000n, USDC, { trailingZeros: true })).toBe("1.500000");
  });

  /** Truncation, never rounding up — an inflated balance breaks "send max". */
  it("truncates toward zero rather than rounding", () => {
    expect(formatTokenAmount(1_999_999n, USDC, { maximumFractionDigits: 2 })).toBe("1.99");
    expect(formatTokenAmount(1_996_000n, USDC, { maximumFractionDigits: 2 })).toBe("1.99");
  });

  it("handles amounts smaller than one whole unit", () => {
    expect(formatTokenAmount(1n, ETH)).toBe("0.000000000000000001");
  });

  it("handles zero-decimal tokens", () => {
    expect(formatTokenAmount(42n, 0)).toBe("42");
  });

  it("formats negative amounts", () => {
    expect(formatTokenAmount(-1_500_000n, USDC)).toBe("-1.5");
  });
});

describe("formatTokenAmountForDisplay", () => {
  it("shows exact zero as 0", () => {
    expect(formatTokenAmountForDisplay(0n, ETH)).toBe("0");
  });

  it("groups thousands", () => {
    expect(formatTokenAmountForDisplay(1_234_567_000_000n, USDC)).toBe("1,234,567");
  });

  it("uses more precision for small balances", () => {
    expect(formatTokenAmountForDisplay(parseTokenAmount("0.001234", USDC), USDC)).toBe("0.001234");
  });

  it("uses less precision for large balances", () => {
    expect(formatTokenAmountForDisplay(parseTokenAmount("12345.678999", USDC), USDC)).toBe(
      "12,345.67",
    );
  });

  /**
   * The important one: a tiny non-zero balance must never render as "0". A user
   * seeing "0" concludes they hold nothing.
   */
  it("never renders a non-zero balance as 0", () => {
    const displayed = formatTokenAmountForDisplay(1n, ETH);
    expect(displayed).not.toBe("0");
    expect(displayed).toBe("<0.000001");
  });

  it("flags tiny negative balances distinctly", () => {
    expect(formatTokenAmountForDisplay(-1n, ETH)).toBe(">-0.000001");
  });
});
