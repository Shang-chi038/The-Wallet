/**
 * Satoshi and BTC unit arithmetic and formatting.
 *
 * Invariant: 1 BTC = 100,000,000 satoshis (8 decimal places).
 * All calculations and stored balances are bigint satoshis.
 * No Number() is ever used to represent satoshis or balances.
 */

export const SATS_PER_BTC = 100_000_000n;
export const BITCOIN_DECIMALS = 8;

export class InvalidBitcoinAmountError extends Error {
  readonly code = "invalid_bitcoin_amount";
  constructor(message: string) {
    super(message);
    this.name = "InvalidBitcoinAmountError";
  }
}

/**
 * Parses a decimal BTC string (e.g. "0.00125", "1.5") into exact satoshis (bigint).
 */
export function parseBtcToSatoshis(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidBitcoinAmountError(`"${value}" is not a valid Bitcoin amount.`);
  }

  const [wholePart = "0", fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > BITCOIN_DECIMALS) {
    throw new InvalidBitcoinAmountError(
      `Bitcoin amounts cannot have more than ${BITCOIN_DECIMALS} decimal places.`,
    );
  }

  const wholeSats = BigInt(wholePart) * SATS_PER_BTC;
  const paddedFraction = fractionPart.padEnd(BITCOIN_DECIMALS, "0");
  const fractionSats = BigInt(paddedFraction);

  return wholeSats + fractionSats;
}

/**
 * Formats bigint satoshis into a full decimal BTC string (e.g. 100000000n -> "1.00000000").
 */
export function formatSatoshisToBtcString(satoshis: bigint): string {
  const isNegative = satoshis < 0n;
  const absSats = isNegative ? -satoshis : satoshis;

  const whole = absSats / SATS_PER_BTC;
  const fraction = absSats % SATS_PER_BTC;
  const paddedFraction = fraction.toString().padStart(BITCOIN_DECIMALS, "0");

  const sign = isNegative ? "-" : "";
  return `${sign}${whole.toString()}.${paddedFraction}`;
}

export interface FormatBitcoinAmountForDisplayOptions {
  /** Maximum decimal places to display (default 8). */
  maxDecimals?: number;
  /** Whether to append the symbol ("BTC"). Defaults to true. */
  includeSymbol?: boolean;
}

/**
 * Formats satoshis for human display.
 * Truncates trailing zeroes while preserving precision.
 * Tiny non-zero balances (<0.00000001 BTC if maxDecimals < 8) render "<0.0001", never "0".
 */
export function formatBitcoinAmountForDisplay(
  satoshis: bigint,
  options: FormatBitcoinAmountForDisplayOptions = {},
): string {
  const { maxDecimals = 8, includeSymbol = true } = options;
  const symbolSuffix = includeSymbol ? " BTC" : "";

  if (satoshis === 0n) {
    return `0${symbolSuffix}`;
  }

  const isNegative = satoshis < 0n;
  const absSats = isNegative ? -satoshis : satoshis;

  const btcDecimal = formatSatoshisToBtcString(absSats);
  const [whole = "0", frac = ""] = btcDecimal.split(".");

  let truncatedFrac = frac.slice(0, maxDecimals);
  // Strip trailing zeros
  truncatedFrac = truncatedFrac.replace(/0+$/, "");

  if (truncatedFrac.length === 0) {
    const sign = isNegative ? "-" : "";
    return `${sign}${whole}${symbolSuffix}`;
  }

  // Check if non-zero satoshis got truncated to 0
  if (whole === "0" && truncatedFrac === "" && absSats > 0n) {
    return `<0.${"0".repeat(maxDecimals - 1)}1${symbolSuffix}`;
  }

  const sign = isNegative ? "-" : "";
  return `${sign}${whole}.${truncatedFrac}${symbolSuffix}`;
}
