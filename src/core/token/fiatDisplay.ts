/**
 * Fiat and denomination display.
 *
 * Implements two rules the screens spec calls out explicitly.
 *
 * 1. THE HERO VALUE MUST FIT. "₦438,909,466" is far wider than "$285,934.18" at
 *    the same font size. Shrinking type to fit is the usual answer and it is
 *    the wrong one — past a certain size the number the user opened the wallet
 *    to read becomes unreadable. So we abbreviate instead (₦438.9M), which
 *    stays legible at full size and loses only precision the user does not need
 *    at a glance.
 *
 * 2. COLOUR IS NEVER THE ONLY SIGNAL. Direction is carried by an arrow and an
 *    explicit sign as well as by colour, so the delta reads correctly in both
 *    themes and for colour-blind users.
 */

export type FiatCurrency = "USD" | "NGN";
export type BitcoinUnit = "BTC" | "sats";
export type DenominationUnit = FiatCurrency | BitcoinUnit;

export const CURRENCY_SYMBOLS: Record<DenominationUnit, string> = {
  USD: "$",
  NGN: "₦",
  BTC: "₿",
  sats: "",
};

/** Beyond this many characters the hero value stops fitting the popup width. */
export const HERO_CHARACTER_BUDGET = 13;

const ABBREVIATION_TIERS = [
  { threshold: 1_000_000_000_000, suffix: "T" },
  { threshold: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, suffix: "M" },
  { threshold: 1_000, suffix: "K" },
] as const;

export interface FormatFiatOptions {
  /** Abbreviate once the grouped string exceeds the budget. Default true. */
  abbreviateWhenLong?: boolean;
  characterBudget?: number;
  fractionDigits?: number;
}

function groupThousands(value: string): string {
  const [whole = "", fraction] = value.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
}

/**
 * Formats a fiat amount for the hero position.
 *
 * Takes a `number` rather than bigint deliberately: this is a display-only fiat
 * conversion of an already-exact on-chain figure, never an input to a
 * transaction. Token amounts stay bigint end to end — see tokenAmount.ts.
 */
export function formatFiatForHero(
  amount: number,
  currency: FiatCurrency,
  {
    abbreviateWhenLong = true,
    characterBudget = HERO_CHARACTER_BUDGET,
    fractionDigits = 2,
  }: FormatFiatOptions = {},
): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const isNegative = amount < 0;
  const absolute = Math.abs(amount);

  const full = `${symbol}${groupThousands(absolute.toFixed(fractionDigits))}`;
  if (!abbreviateWhenLong || full.length <= characterBudget) {
    return isNegative ? `-${full}` : full;
  }

  for (const { threshold, suffix } of ABBREVIATION_TIERS) {
    if (absolute >= threshold) {
      // One decimal place: enough to distinguish 438.9M from 438.2M, short
      // enough to stay inside the budget at any realistic magnitude.
      const scaled = (absolute / threshold).toFixed(1).replace(/\.0$/, "");
      const abbreviated = `${symbol}${scaled}${suffix}`;
      return isNegative ? `-${abbreviated}` : abbreviated;
    }
  }
  return isNegative ? `-${full}` : full;
}

export interface ChangeIndicator {
  /** Arrow glyph — carries direction independently of colour. */
  arrow: "↑" | "↓" | "→";
  /** Signed percentage, e.g. "+2.41%". The sign is a second non-colour signal. */
  label: string;
  tone: "positive" | "negative" | "neutral";
}

export function describeChange(percentChange: number): ChangeIndicator {
  if (percentChange > 0) {
    return { arrow: "↑", label: `+${percentChange.toFixed(2)}%`, tone: "positive" };
  }
  if (percentChange < 0) {
    return { arrow: "↓", label: `${percentChange.toFixed(2)}%`, tone: "negative" };
  }
  return { arrow: "→", label: "0.00%", tone: "neutral" };
}

/**
 * Network label for an asset row.
 *
 * Per the spec: name the chain when the asset sits on exactly one, otherwise
 * show a count. A stablecoin can live on Tron, Ethereum, BSC and Polygon at
 * once, and listing them all overflows the row. The full breakdown belongs on
 * asset detail.
 */
export function describeNetworks(networkNames: readonly string[]): string {
  if (networkNames.length === 0) return "";
  if (networkNames.length === 1) return networkNames[0] as string;
  return `${networkNames.length} networks`;
}

/** Assets below this share of the portfolio collapse into an "Other" row. */
export const OTHER_BUCKET_THRESHOLD = 0.01;

export interface PortfolioSlice {
  symbol: string;
  fiatValue: number;
}

/**
 * Below this many collapsed assets, collapsing is not worth doing.
 *
 * One asset behind an "Other" row is still one row, so collapsing it trades a
 * name the user recognises for a euphemism and saves no space at all.
 */
export const MINIMUM_COLLAPSED_HOLDINGS = 2;

/**
 * How many collapsed symbols the "Other" row names before the "+N" chip.
 *
 * Naming a couple is what makes the row skippable: "Other · 4 assets" has to be
 * opened before it tells you anything, which defeats the point of collapsing it.
 */
export const NAMED_COLLAPSED_SYMBOLS = 2;

export interface CollapsibleHolding {
  /** Contract address or "native" -- NOT the symbol, which can repeat. */
  id: string;
  symbol: string;
  /** Undefined when there is no price. Never 0 as a stand-in. */
  fiatValue: number | undefined;
  /** User-imported: unpriced by design, and never collapsed. */
  isImported?: boolean | undefined;
}

export interface OtherHoldingsBucket<HoldingType> {
  /** Holdings that keep their own row, value-descending. */
  visible: HoldingType[];
  /** Holdings folded into the bucket, in the order they arrived. */
  collapsed: HoldingType[];
  /** Their combined fiat value. */
  otherValue: number;
}

/**
 * Decides which holdings collapse into the sub-1% "Other" row of screen 05,
 * or `undefined` when nothing should collapse.
 *
 * THREE GATES, and each one exists because failing it would hide money.
 *
 * 1. EVERY non-imported holding must be priced. A share of the portfolio is a
 *    ratio and a ratio needs every numerator; with one price missing, the
 *    assets we can value look larger than they are and something real gets
 *    filed away as dust. A missing price is an outage, and an outage must not
 *    quietly change what the user can see.
 * 2. IMPORTED HOLDINGS NEVER COLLAPSE. They have no price by design -- see the
 *    never-price rule in the README -- so measuring them by fiat value would
 *    read every one of them as 0 and file the whole set behind the chip. That
 *    is the wallet hiding precisely the tokens the user went out of their way
 *    to add, and it would look like a bug in token import rather than a
 *    display rule.
 * 3. At least `MINIMUM_COLLAPSED_HOLDINGS` must collapse.
 *
 * Membership only: the caller keeps its own row ORDER. `collapseSmallHoldings`
 * sorts by value, which is right for the proportion bar and wrong for the list,
 * where `sortPortfolioForDisplay` deliberately pins the native coin first
 * regardless of what it is worth.
 */
export function selectOtherBucket<HoldingType extends CollapsibleHolding>(
  holdings: readonly HoldingType[],
): OtherHoldingsBucket<HoldingType> | undefined {
  const priceable = holdings.filter((holding) => !holding.isImported);
  const priced = priceable.filter(
    (holding): holding is HoldingType & { fiatValue: number } => holding.fiatValue !== undefined,
  );
  if (priced.length !== priceable.length || priced.length === 0) return undefined;

  const { visible, otherValue } = collapseSmallHoldings(priced);
  const visibleIds = new Set(visible.map((holding) => holding.id));
  const collapsed = priced.filter((holding) => !visibleIds.has(holding.id));
  if (collapsed.length < MINIMUM_COLLAPSED_HOLDINGS) return undefined;

  return { visible, collapsed, otherValue };
}

/**
 * Splits holdings into the ones worth a row and a sub-1% "Other" bucket.
 *
 * Generic over the slice so the caller gets its OWN objects back rather than
 * `{ symbol, fiatValue }` pairs it then has to match up again. The popup keys
 * rows on contract address, not symbol, precisely because two rows can read
 * "USDC" -- so a round trip through symbols here would reintroduce the
 * ambiguity `PortfolioHolding.id` exists to remove.
 *
 * ONLY PRICED HOLDINGS MAY BE PASSED IN. A holding with no price is not a
 * small holding; feeding one in as 0 would file every imported token behind a
 * "+2" chip, which is the wallet hiding assets it told the user it was
 * tracking. The caller gates on that -- see `PortfolioScreen`.
 */
export function collapseSmallHoldings<SliceType extends PortfolioSlice>(
  slices: readonly SliceType[],
): {
  visible: SliceType[];
  otherValue: number;
} {
  const total = slices.reduce((sum, slice) => sum + slice.fiatValue, 0);
  if (total <= 0) return { visible: [...slices], otherValue: 0 };

  const visible: SliceType[] = [];
  let otherValue = 0;
  for (const slice of slices) {
    if (slice.fiatValue / total < OTHER_BUCKET_THRESHOLD) otherValue += slice.fiatValue;
    else visible.push(slice);
  }
  visible.sort((left, right) => right.fiatValue - left.fiatValue);
  return { visible, otherValue };
}


export interface SplitHeroValue {
  /** Whole units including the currency symbol, e.g. "$285,934". */
  primary: string;
  /** Fractional part including the separator, e.g. ".18". Empty when absent. */
  cents: string;
}

/**
 * Splits a hero figure so the cents can be de-emphasised.
 *
 * The spec renders "$285,934" in the ink colour and ".18" in the faint colour.
 * It is a small thing that does real work: it lets the eye land on the
 * magnitude first, which is the part a user actually reads at a glance, while
 * keeping the exact figure available.
 *
 * An abbreviated value ("₦438.9M") has no cents to split, so the whole string
 * comes back as `primary` — de-emphasising the ".9" there would be misleading,
 * since it is a significant digit rather than a rounding tail.
 */
export function splitHeroValue(formatted: string): SplitHeroValue {
  const isAbbreviated = /[KMBT]$/.test(formatted);
  if (isAbbreviated) return { primary: formatted, cents: "" };

  const separatorIndex = formatted.lastIndexOf(".");
  if (separatorIndex === -1) return { primary: formatted, cents: "" };

  return {
    primary: formatted.slice(0, separatorIndex),
    cents: formatted.slice(separatorIndex),
  };
}
