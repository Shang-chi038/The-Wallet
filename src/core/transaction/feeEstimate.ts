/**
 * EIP-1559 fee estimation.
 *
 * ===========================================================================
 * HOW EIP-1559 ACTUALLY CHARGES, BECAUSE THE UI DEPENDS ON GETTING THIS RIGHT
 * ===========================================================================
 * Under EIP-1559 a transaction names two numbers:
 *
 *   maxPriorityFeePerGas  the tip to the validator
 *   maxFeePerGas          the absolute ceiling the sender will pay per gas
 *
 * The amount actually charged is:
 *
 *   min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)
 *
 * The consequence that most wallets communicate badly: RAISING maxFeePerGas
 * DOES NOT RAISE THE PRICE PAID. It only widens the ceiling. The unused
 * difference is never spent. So a generous ceiling is close to free insurance,
 * while a tight one gets the transaction stuck the moment the base fee ticks
 * up. Our UI must say "max" and show the expected cost separately, never
 * present the ceiling as the price.
 *
 * The base fee is set by the protocol per block and can rise at most 12.5% per
 * block. Over six blocks that compounds to 1.125^6 ~= 2.03x, which is why the
 * default ceiling multiplier below is 2: it keeps a transaction viable through
 * roughly six blocks of maximum congestion growth without the sender paying a
 * penny more than the prevailing rate.
 */

export const BASE_FEE_MAX_INCREASE_PER_BLOCK = 1.125;

export interface FeeHistorySample {
  /** Base fee of the most recent block, in wei. */
  baseFeePerGas: bigint;
  /**
   * Observed priority tips at the requested percentiles, oldest block first.
   * From eth_feeHistory's `reward` field.
   */
  rewardsByBlock: readonly (readonly bigint[])[];
}

export type FeeLevel = "low" | "medium" | "high";

export interface FeeEstimate {
  level: FeeLevel;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  /** What the sender should expect to pay per gas at the current base fee. */
  expectedFeePerGas: bigint;
}

export interface ComputeFeeEstimatesParams {
  history: FeeHistorySample;
  /**
   * How many blocks of base-fee growth the ceiling should tolerate. Defaults to
   * 6 (~2x). Raise for volatile conditions; it costs nothing.
   */
  ceilingBlocks?: number;
  /** Floor for the tip, so a zero-tip estimate cannot strand a transaction. */
  minimumPriorityFeePerGas?: bigint;
}

export const DEFAULT_CEILING_BLOCKS = 6;
/** 0.1 gwei. Below this, most validators will not include the transaction. */
export const DEFAULT_MINIMUM_PRIORITY_FEE = 100_000_000n;

/**
 * Median of the per-block samples at one percentile column.
 *
 * Median rather than mean, deliberately: a single block containing one
 * desperate high-tip transaction would drag a mean upward and cause us to
 * overbid on every subsequent estimate.
 */
function medianOfColumn(rewardsByBlock: readonly (readonly bigint[])[], column: number): bigint {
  const samples = rewardsByBlock
    .map((block) => block[column])
    .filter((value): value is bigint => value !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (samples.length === 0) return 0n;
  const middle = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) return samples[middle] as bigint;
  return ((samples[middle - 1] as bigint) + (samples[middle] as bigint)) / 2n;
}

/**
 * Multiplies a bigint by a decimal factor without floating point.
 *
 * `Number(wei) * 1.125` loses precision above 2^53 and silently corrupts fee
 * arithmetic on mainnet-sized values. Scaling by a rational instead keeps it
 * exact.
 */
export function scaleBigInt(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator) / denominator;
}

export function computeFeeEstimates({
  history,
  ceilingBlocks = DEFAULT_CEILING_BLOCKS,
  minimumPriorityFeePerGas = DEFAULT_MINIMUM_PRIORITY_FEE,
}: ComputeFeeEstimatesParams): Record<FeeLevel, FeeEstimate> {
  const { baseFeePerGas, rewardsByBlock } = history;

  // Columns correspond to the percentiles requested from eth_feeHistory.
  // We ask for [10, 50, 90] — see viemNetworkReader.
  const tips: Record<FeeLevel, bigint> = {
    low: medianOfColumn(rewardsByBlock, 0),
    medium: medianOfColumn(rewardsByBlock, 1),
    high: medianOfColumn(rewardsByBlock, 2),
  };

  // 1.125^ceilingBlocks as an exact rational: 9^n / 8^n.
  const ceilingNumerator = 9n ** BigInt(ceilingBlocks);
  const ceilingDenominator = 8n ** BigInt(ceilingBlocks);
  const baseFeeCeiling = scaleBigInt(baseFeePerGas, ceilingNumerator, ceilingDenominator);

  const build = (level: FeeLevel): FeeEstimate => {
    const maxPriorityFeePerGas =
      tips[level] < minimumPriorityFeePerGas ? minimumPriorityFeePerGas : tips[level];
    return {
      level,
      maxPriorityFeePerGas,
      maxFeePerGas: baseFeeCeiling + maxPriorityFeePerGas,
      // What they will actually be charged right now. This is the number the UI
      // shows as "estimated cost"; maxFeePerGas is shown as "max".
      expectedFeePerGas: baseFeePerGas + maxPriorityFeePerGas,
    };
  };

  return { low: build("low"), medium: build("medium"), high: build("high") };
}

/** Total wei the sender could pay at worst for a given gas limit. */
export function computeMaxTransactionFee(estimate: FeeEstimate, gasLimit: bigint): bigint {
  return estimate.maxFeePerGas * gasLimit;
}

/** Total wei the sender should expect to pay at the current base fee. */
export function computeExpectedTransactionFee(estimate: FeeEstimate, gasLimit: bigint): bigint {
  return estimate.expectedFeePerGas * gasLimit;
}

/**
 * Applies a safety margin to an estimated gas limit.
 *
 * eth_estimateGas simulates against current state. Real execution happens
 * against LATER state, and any storage slot that flips from zero to non-zero in
 * between costs more gas than the simulation saw. Without headroom, a
 * transaction that estimated fine reverts with out-of-gas and the sender pays
 * the full fee for nothing.
 *
 * Unused gas is refunded, so the margin costs nothing when it is not needed.
 */
export const GAS_LIMIT_MARGIN_PERCENT = 20n;

export function applyGasLimitMargin(estimatedGas: bigint): bigint {
  return estimatedGas + (estimatedGas * GAS_LIMIT_MARGIN_PERCENT) / 100n;
}

/**
 * Fallback gas limits for common operations.
 *
 * WHY THESE EXIST. `eth_estimateGas` runs a real simulation, and nodes reject
 * the call outright when the sender cannot afford the transaction — the error
 * is "insufficient funds for gas * price + value", not a gas figure. So a newly
 * created, unfunded account cannot get an estimate at all, and a naive wallet
 * shows an error instead of a fee on the one screen where the user is trying to
 * work out how much ETH they need to deposit.
 *
 * These are protocol-fixed or well-established empirical values used ONLY when
 * estimation is unavailable. They are conservative: a simple transfer is
 * exactly 21000 by protocol definition, and the token figures sit above typical
 * real usage. Any transaction that actually broadcasts is re-estimated first,
 * so these never silently under-fund a real send.
 */
export const FALLBACK_GAS_LIMITS = {
  /** Protocol-defined cost of a value transfer with empty calldata. */
  nativeTransfer: 21_000n,
  /** ERC-20 transfer: higher when the recipient's balance slot starts at zero. */
  tokenTransfer: 65_000n,
  tokenApproval: 55_000n,
  /** Unknown contract call. Deliberately generous. */
  contractCall: 150_000n,
} as const;

export type GasLimitFallbackKind = keyof typeof FALLBACK_GAS_LIMITS;

/**
 * True when a gas-estimation failure is caused by the sender being unable to
 * afford the transaction, rather than by the transaction being invalid.
 *
 * The distinction matters: an unaffordable transaction should still show a fee
 * so the user learns how much to deposit, whereas one that reverts must NOT be
 * presented as sendable behind a fallback number.
 */
export function isInsufficientFundsEstimationError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${String((error as { details?: string }).details ?? "")}`
      : String(error);
  return /insufficient funds/i.test(message);
}
