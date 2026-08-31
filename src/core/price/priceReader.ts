import { formatTokenAmount } from "../token/tokenAmount";

/**
 * Fiat pricing contract.
 *
 * ===========================================================================
 * PRICES ARE DECORATION. BALANCES ARE TRUTH.
 * ===========================================================================
 * Everything in this module is display-only. No value produced here is ever an
 * input to a transaction, which is why it is the one place a `number` is
 * allowed near a balance -- and why the whole subsystem must degrade to
 * "unavailable" rather than to zero.
 *
 * A wallet that renders "$0.00" because a price API timed out has told the user
 * their money is gone. That is a worse failure than showing no fiat total at
 * all, so `readPrices` returning an empty map is a normal, expected outcome and
 * every caller must handle it as "no price", never as "price of zero".
 *
 * Privacy: a price lookup tells the provider which assets the user holds. We
 * therefore query a FIXED symbol list per chain rather than one derived from
 * the user's actual holdings, so the request looks the same whether they own
 * the token or not.
 */

export interface PriceQuote {
  /** USD per whole unit. */
  price: number;
  /**
   * 24-hour change, as a percentage. Undefined when the feed did not supply
   * one -- which the UI must render as "no change shown", never as 0.00%.
   *
   * A wallet that displays a made-up change figure next to a real balance is
   * lying about the only number on the screen the user cannot verify for
   * themselves.
   */
  change24hPercent: number | undefined;
}

export interface PriceReader {
  /**
   * Returns USD quotes keyed by uppercase symbol. Symbols with no known price
   * are ABSENT from the map -- they are never present with a zero value.
   */
  readPrices(symbols: readonly string[]): Promise<Map<string, PriceQuote>>;
}

/** A reader that always reports "no prices". The offline/failure default. */
export function createUnavailablePriceReader(): PriceReader {
  return {
    async readPrices() {
      return new Map();
    },
  };
}

/**
 * Converts a base-unit balance to a fiat figure.
 *
 * The bigint is stringified at full precision and parsed once, rather than
 * divided as a number, so the conversion loses precision exactly once at the
 * end instead of compounding. Returns undefined when there is no price, which
 * propagates all the way to the UI as "unavailable".
 */
export function computeFiatValue(
  amount: bigint,
  decimals: number,
  price: number | undefined,
): number | undefined {
  // Zero is checked BEFORE the price. A balance of nothing is worth nothing at
  // any price, so reporting it as "unknown" would put a dash next to a holding
  // whose value is not in doubt -- and would let one unpriced token the user
  // does not even own suppress the fiat column for the ones they do.
  if (amount === 0n) return 0;
  if (price === undefined || !Number.isFinite(price)) return undefined;
  const exact = formatTokenAmount(amount, decimals);
  const magnitude = Number(exact);
  if (!Number.isFinite(magnitude)) return undefined;
  return magnitude * price;
}

/**
 * Sums a portfolio's fiat values.
 *
 * Returns undefined when ANY entry with a non-zero balance has no price. A
 * partial total presented as "your portfolio" understates what the user holds,
 * and understating a balance is the direction that causes bad decisions.
 * Zero-balance entries are ignored: an unpriced token you own none of cannot
 * change the total.
 */
export function sumFiatValues(
  entries: readonly { amount: bigint; fiatValue: number | undefined }[],
): number | undefined {
  let total = 0;
  for (const entry of entries) {
    if (entry.amount === 0n) continue;
    if (entry.fiatValue === undefined) return undefined;
    total += entry.fiatValue;
  }
  return total;
}

/**
 * Why a portfolio has no change figure.
 *
 * ===========================================================================
 * WHY THIS IS A REASON AND NOT JUST `undefined`
 * ===========================================================================
 * Two completely different situations produce "no percentage to show", and the
 * UI has to say different things about them:
 *
 *   nothing_held    the wallet is empty. There is nothing to have moved. The
 *                   correct display is silence -- an empty wallet does not need
 *                   commentary about today.
 *
 *   no_price_data   we hold something but could not price it or could not get a
 *                   change for it. The correct display says so, because the
 *                   user is looking at a balance whose value we are not showing.
 *
 * Collapsing both to `undefined` forced the popup to guess, and it guessed
 * wrong: a brand-new empty wallet rendered "$0.00" directly above "Prices
 * unavailable", which reads as though the zero itself were unreliable. The
 * reason travels with the answer instead.
 */
export type PortfolioChange =
  | { status: "available"; percentChange: number }
  | { status: "unavailable"; reason: "nothing_held" | "no_price_data" };

/**
 * The portfolio's own 24-hour change.
 *
 * NOT an average of the per-asset percentages, which is the tempting and wrong
 * calculation: a 50% move on a $2 holding would count as much as a 1% move on
 * $2,000. The correct figure reconstructs what the portfolio was worth
 * yesterday -- each holding's current value divided by (1 + its change) -- and
 * compares totals.
 *
 * Unavailable unless EVERY non-zero holding has both a value and a change. A
 * change figure computed from a subset describes a portfolio the user does not
 * have.
 */
export function computePortfolioChange(
  entries: readonly {
    amount: bigint;
    fiatValue: number | undefined;
    change24hPercent: number | undefined;
  }[],
): PortfolioChange {
  let now = 0;
  let previous = 0;
  let heldAnything = false;

  for (const entry of entries) {
    if (entry.amount === 0n) continue;
    heldAnything = true;

    if (entry.fiatValue === undefined || entry.change24hPercent === undefined) {
      return { status: "unavailable", reason: "no_price_data" };
    }

    const ratio = 1 + entry.change24hPercent / 100;
    // A -100% move (or worse data) would divide by zero or flip the sign. The
    // change is unreportable rather than wrong.
    if (ratio <= 0) return { status: "unavailable", reason: "no_price_data" };

    now += entry.fiatValue;
    previous += entry.fiatValue / ratio;
  }

  if (!heldAnything) return { status: "unavailable", reason: "nothing_held" };
  if (previous === 0) return { status: "unavailable", reason: "no_price_data" };
  return { status: "available", percentChange: (now / previous - 1) * 100 };
}
