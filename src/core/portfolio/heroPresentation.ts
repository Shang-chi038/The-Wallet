import type { PortfolioChange } from "@/core/price/priceReader";

/**
 * What the hero shows, and what the line under it says.
 *
 * ===========================================================================
 * WHY THIS IS NOT A TERNARY IN THE COMPONENT
 * ===========================================================================
 * It was, and the ternary was wrong in the one case nobody could test: with no
 * portfolio at all it fell through to `0 ETH`, so an unreachable RPC printed a
 * balance of zero in the largest type on the screen. That is the same class of
 * defect the "no price is `undefined`, never `0`" rule exists to stop, one
 * field further down and considerably louder, and a JSX conditional cannot be
 * reached by a hermetic suite without a DOM.
 *
 * So the decision lives here, next to `selectActivityPresentation`, which was
 * moved out of a component for exactly the same reason.
 *
 * ===========================================================================
 * THE DISTINCTION THIS FILE PROTECTS
 * ===========================================================================
 * Three states that a single "is there a number?" check collapses into one:
 *
 *   - the engine answered, and the answer is zero   -> "0 ETH". A fact.
 *   - the engine answered, prices did not           -> the native balance.
 *   - the engine did not answer                     -> a dash, and a reason.
 *
 * Only the first is entitled to print a zero, and it is the only one that
 * carries a balance to print it from.
 */

export type HeroFigure =
  | { readonly kind: "fiat"; readonly totalFiat: number }
  | { readonly kind: "native"; readonly label: string }
  | { readonly kind: "unavailable" };

export interface HeroPresentation {
  readonly figure: HeroFigure;
  /** The line under the hero. Never empty; something is always true. */
  readonly note: string;
  /** Whether the note is a failure the user can act on by retrying. */
  readonly canRetry: boolean;
}

export interface SelectHeroPresentationParams {
  /** Undefined when nothing could be priced, which is not a failure. */
  readonly totalFiat: number | undefined;
  /**
   * The native balance, e.g. "0.4218 ETH". Undefined when there was no
   * successful read to take it from -- NOT when the balance is zero, which is
   * a number and formats like one.
   */
  readonly nativeBalanceLabel: string | undefined;
  readonly change: PortfolioChange;
  readonly isRefreshing: boolean;
  /** "Can't reach Sepolia", or undefined when the read succeeded. */
  readonly portfolioError: string | undefined;
}

export function selectHeroPresentation({
  totalFiat,
  nativeBalanceLabel,
  change,
  isRefreshing,
  portfolioError,
}: SelectHeroPresentationParams): HeroPresentation {
  const figure: HeroFigure =
    totalFiat !== undefined
      ? { kind: "fiat", totalFiat }
      : nativeBalanceLabel !== undefined
        ? { kind: "native", label: nativeBalanceLabel }
        : { kind: "unavailable" };

  /**
   * Refreshing first: it is the only note that describes something in progress,
   * and a stale failure printed over a running retry reads as the retry having
   * already failed.
   *
   * The error next, ahead of the change note. "Nothing to track yet" is a
   * statement about the user's wallet, and saying it while the chain is
   * unreachable turns a connection problem into a claim about their money.
   */
  const note = isRefreshing
    ? "Refreshing..."
    : portfolioError
      ? portfolioError
      : change.status === "unavailable" && change.reason === "no_price_data"
        ? "Prices unavailable"
        : "Nothing to track yet";

  return {
    figure,
    note,
    canRetry: !isRefreshing && portfolioError !== undefined,
  };
}
