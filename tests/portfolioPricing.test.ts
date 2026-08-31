import { describe, expect, it } from "vitest";
import {
  computeFiatValue,
  computePortfolioChange,
  sumFiatValues,
} from "@/core/price/priceReader";
import type { PortfolioResult } from "@/core/messaging/walletApi";
import { USDC_SEPOLIA } from "@/core/token/tokenRegistry";
import {
  createHarness,
  expectResult,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
} from "./support/routerHarness";

/**
 * Prices are decoration; balances are truth.
 *
 * The property every test here defends: an unavailable price must render as
 * "unknown", never as zero. A wallet showing "$0.00" because an API timed out
 * has told the user their money is gone, and that is the direction of error
 * that makes people do something drastic.
 */

describe("fiat conversion", () => {
  it("returns undefined when there is no price", () => {
    expect(computeFiatValue(10n ** 18n, 18, undefined)).toBeUndefined();
  });

  it("converts through an exact decimal string, not a float division", () => {
    expect(computeFiatValue(10n ** 18n, 18, 2_500)).toBe(2_500);
    expect(computeFiatValue(500_000_000n, 6, 1)).toBe(500);
  });

  it("values a zero balance at zero even with no price", () => {
    expect(computeFiatValue(0n, 18, undefined)).toBe(0);
  });
});

describe("portfolio totals", () => {
  it("refuses to total when a held asset has no price", () => {
    expect(
      sumFiatValues([
        { amount: 10n ** 18n, fiatValue: 2_500 },
        { amount: 1_000_000n, fiatValue: undefined },
      ]),
    ).toBeUndefined();
  });

  /**
   * An unpriced token you own NONE of cannot change the total, so it must not
   * suppress it. Otherwise a single unlisted token in the registry blanks out
   * the balance for every user.
   */
  it("ignores unpriced assets the user does not hold", () => {
    expect(
      sumFiatValues([
        { amount: 10n ** 18n, fiatValue: 2_500 },
        { amount: 0n, fiatValue: undefined },
      ]),
    ).toBe(2_500);
  });
});

describe("portfolio change", () => {
  /**
   * The tempting and wrong calculation is to average the per-asset
   * percentages: a 50% move on a $2 holding would then count as much as a 1%
   * move on $2,000.
   */
  it("weights by holding value rather than averaging percentages", () => {
    const change = computePortfolioChange([
      // $2000 now, up 1% -> was ~$1980.20
      { amount: 1n, fiatValue: 2_000, change24hPercent: 1 },
      // $2 now, up 50% -> was ~$1.33
      { amount: 1n, fiatValue: 2, change24hPercent: 50 },
    ]);
    // A naive mean would report 25.5%. The real answer is barely above 1%.
    expect(change.status).toBe("available");
    const percent = change.status === "available" ? change.percentChange : Number.NaN;
    expect(percent).toBeGreaterThan(1);
    expect(percent).toBeLessThan(1.1);
  });

  it("is unreportable when any held asset lacks a change figure", () => {
    expect(
      computePortfolioChange([
        { amount: 1n, fiatValue: 2_000, change24hPercent: 1 },
        { amount: 1n, fiatValue: 500, change24hPercent: undefined },
      ]),
    ).toEqual({ status: "unavailable", reason: "no_price_data" });
  });

  /**
   * THE ZERO-BALANCE BUG THIS TYPE EXISTS FOR.
   *
   * An empty wallet and an unpriced wallet both produce no percentage. Before
   * the reason travelled with the answer, the popup guessed -- and rendered a
   * perfectly reliable "$0.00" directly above "Prices unavailable", which reads
   * as though the zero itself were untrustworthy.
   */
  it("distinguishes an empty portfolio from an unpriced one", () => {
    expect(computePortfolioChange([])).toEqual({
      status: "unavailable",
      reason: "nothing_held",
    });
    expect(
      computePortfolioChange([{ amount: 0n, fiatValue: 0, change24hPercent: undefined }]),
    ).toEqual({ status: "unavailable", reason: "nothing_held" });
  });

  it("does not divide by zero on a total loss", () => {
    expect(
      computePortfolioChange([{ amount: 1n, fiatValue: 0, change24hPercent: -100 }]),
    ).toEqual({ status: "unavailable", reason: "no_price_data" });
  });
});

describe("wallet.getPortfolio", () => {
  it("reports balances with no fiat when the price feed is empty", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.nativeBalance = 421_800_000_000_000_000n;

    const portfolio = expectResult<PortfolioResult>(
      await harness.route({ method: "wallet.getPortfolio", params: {} }, PRIVILEGED_SENDER),
    );

    expect(portfolio.entries[0]?.balanceLabel).toBe("0.4218");
    expect(portfolio.entries[0]?.fiatValue).toBeUndefined();
    // Undefined, not 0. This is the whole point.
    expect(portfolio.totalFiatValue).toBeUndefined();
  });

  it("reports fiat and a change figure when prices are available", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.nativeBalance = 10n ** 18n;
    harness.prices.set("ETH", { price: 2_500, change24hPercent: 3.2 });

    const portfolio = expectResult<PortfolioResult>(
      await harness.route({ method: "wallet.getPortfolio", params: {} }, PRIVILEGED_SENDER),
    );

    expect(portfolio.totalFiatValue).toBe(2_500);
    expect(portfolio.change).toEqual({ status: "available", percentChange: expect.closeTo(3.2, 5) });
  });

  /**
   * A token whose balanceOf call fails is ABSENT, not zero. We do not know the
   * user holds none of it, and claiming so is a different lie from the price
   * one but the same shape.
   */
  it("omits a token whose balance call failed, and keeps the rest", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    // The fake client throws for any token not in this map.
    harness.chain.tokenBalances.clear();

    const portfolio = expectResult<PortfolioResult>(
      await harness.route({ method: "wallet.getPortfolio", params: {} }, PRIVILEGED_SENDER),
    );

    expect(portfolio.entries).toHaveLength(1);
    expect(portfolio.entries[0]?.kind).toBe("native");
  });

  it("includes a token whose balance did come back", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.tokenBalances.set(USDC_SEPOLIA.address.toLowerCase(), 12_340_000n);

    const portfolio = expectResult<PortfolioResult>(
      await harness.route({ method: "wallet.getPortfolio", params: {} }, PRIVILEGED_SENDER),
    );

    const usdc = portfolio.entries.find((entry) => entry.symbol === "USDC");
    expect(usdc?.balanceLabel).toBe("12.34");
    // Base units cross the wire as an exact decimal string, never a number.
    expect(usdc?.amountBaseUnits).toBe("12340000");
    expect(BigInt(usdc!.amountBaseUnits)).toBe(12_340_000n);
  });

  /**
   * A tiny but real balance must never render as "0". The user owns something,
   * and a wallet that rounds it away is telling them they do not.
   */
  it("renders a dust balance as less-than rather than zero", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.nativeBalance = 1n;

    const portfolio = expectResult<PortfolioResult>(
      await harness.route({ method: "wallet.getPortfolio", params: {} }, PRIVILEGED_SENDER),
    );

    expect(portfolio.entries[0]?.balanceLabel).toBe("<0.000001");
  });

  it("refuses to read an address this wallet does not own", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      {
        method: "wallet.getPortfolio",
        params: { address: "0x000000000000000000000000000000000000dEaD" },
      },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });

  it("refuses to read anything while locked", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.context.walletService.lock();

    const response = await harness.route(
      { method: "wallet.getPortfolio", params: { address: TEST_ADDRESS } },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });
});
