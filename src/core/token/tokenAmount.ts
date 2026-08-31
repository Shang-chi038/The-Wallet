/**
 * Fixed-point token amount conversion.
 *
 * ===========================================================================
 * WHY THIS IS HAND-WRITTEN AND HEAVILY TESTED
 * ===========================================================================
 * Every on-chain amount is an integer of the token's smallest unit. Turning
 * that into something a human reads, and back again, is where wallets lose
 * people's money:
 *
 *   - USDC and USDT use 6 decimals; ETH uses 18. Code that assumes 18
 *     everywhere sends a millionth of what the user typed, or a million times
 *     it. This is the single most common stablecoin-wallet bug.
 *   - IEEE-754 doubles cannot represent 0.1 exactly and lose integer precision
 *     above 2^53. A single `Number()` anywhere in this path silently corrupts
 *     large balances. Everything here is `bigint` and `string` end to end;
 *     there is no float arithmetic in this file at all.
 *   - Rounding direction matters. We always TRUNCATE toward zero when
 *     displaying, never round up: showing a user more than they hold leads to a
 *     "max" send that reverts, and erodes trust in every other number.
 */

export class InvalidTokenAmountError extends Error {
  readonly code = "invalid_token_amount";
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidTokenAmountError";
  }
}

/**
 * Parses human input into base units.
 *
 * Strict by design: this consumes what a user typed into a send field, so it
 * rejects anything ambiguous rather than guessing. Excess precision is an
 * error, not something to silently truncate — a user who types eight decimals
 * of USDC must be told those digits cannot be sent, not have them dropped.
 */
export function parseTokenAmount(value: string, decimals: number): bigint {
  assertValidDecimals(decimals);

  const trimmed = value.trim();
  if (trimmed === "") throw new InvalidTokenAmountError("Amount is empty.");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") {
    // No signs, no exponents, no thousands separators. A negative or
    // scientific-notation amount reaching a transaction builder is a bug we
    // want to catch here, loudly.
    throw new InvalidTokenAmountError(`"${value}" is not a valid amount.`);
  }

  const [wholePart = "", fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > decimals) {
    throw new InvalidTokenAmountError(`This token supports at most ${decimals} decimal places.`);
  }

  const combined = `${wholePart}${fractionPart.padEnd(decimals, "0")}`;
  return combined === "" ? 0n : BigInt(combined);
}

export interface FormatTokenAmountOptions {
  /**
   * Cap on fractional digits shown. Digits beyond this are TRUNCATED, never
   * rounded up. Omit to show the token's full precision.
   */
  maximumFractionDigits?: number;
  /** Keep trailing zeros (useful for fiat-style display). Default false. */
  trailingZeros?: boolean;
}

/**
 * Formats base units as an exact decimal string.
 * The result is always exact for the digits shown — no float ever touches it.
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  { maximumFractionDigits, trailingZeros = false }: FormatTokenAmountOptions = {},
): string {
  assertValidDecimals(decimals);

  const isNegative = amount < 0n;
  const absolute = isNegative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const wholePart = (absolute / base).toString();
  let fractionPart = decimals === 0 ? "" : (absolute % base).toString().padStart(decimals, "0");

  if (maximumFractionDigits !== undefined) {
    if (maximumFractionDigits < 0) {
      throw new InvalidTokenAmountError("maximumFractionDigits cannot be negative.");
    }
    fractionPart = fractionPart.slice(0, maximumFractionDigits);
  }
  if (!trailingZeros) {
    fractionPart = fractionPart.replace(/0+$/, "");
  }

  const magnitude = fractionPart === "" ? wholePart : `${wholePart}.${fractionPart}`;
  return isNegative && absolute !== 0n ? `-${magnitude}` : magnitude;
}

/**
 * Balance formatting for the UI.
 *
 * Two competing needs: small balances must stay legible (0.00004 ETH is not
 * "0"), while large ones must not sprawl to 18 decimals. So we scale the
 * precision to the magnitude, and flag genuinely-nonzero-but-too-small amounts
 * explicitly rather than rendering a misleading "0".
 */
export function formatTokenAmountForDisplay(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";

  const base = 10n ** BigInt(decimals);
  const absolute = amount < 0n ? -amount : amount;

  let maximumFractionDigits: number;
  if (absolute >= base * 1000n) maximumFractionDigits = 2;
  else if (absolute >= base) maximumFractionDigits = 4;
  else maximumFractionDigits = 6;
  maximumFractionDigits = Math.min(maximumFractionDigits, decimals);

  const formatted = formatTokenAmount(amount, decimals, { maximumFractionDigits });

  // Truncation produced "0" from a non-zero balance. Saying "0" here would be a
  // lie the user could act on, so say "less than the smallest unit shown".
  if (formatted === "0" || formatted === "-0") {
    const smallest = formatTokenAmount(1n, maximumFractionDigits, { trailingZeros: true });
    return amount < 0n ? `>-${smallest}` : `<${smallest}`;
  }

  return withThousandsSeparators(formatted);
}

function withThousandsSeparators(value: string): string {
  const [wholePart = "", fractionPart] = value.split(".");
  const sign = wholePart.startsWith("-") ? "-" : "";
  const digits = sign ? wholePart.slice(1) : wholePart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fractionPart === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fractionPart}`;
}

function assertValidDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new InvalidTokenAmountError(`Unsupported token decimals: ${decimals}.`);
  }
}
