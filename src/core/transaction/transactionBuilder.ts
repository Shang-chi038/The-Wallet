import type { TransactionSerializable } from "viem";
import { isValidAddress, toChecksumAddress } from "../account/ethereumAddress";
import { computeMaxTransactionFee, type FeeEstimate } from "./feeEstimate";

/**
 * Assembles a signable EIP-1559 transaction and enforces the checks that must
 * pass before a user is ever shown an approval screen.
 *
 * The ordering principle: everything that can be known to fail is rejected
 * HERE, before the approval prompt. Asking a user to approve a transaction that
 * cannot succeed trains them to click through warnings, and burns a real fee
 * when it reverts on chain.
 */

export class InsufficientFundsError extends Error {
  readonly code = "insufficient_funds";
  constructor(
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super("This account does not have enough ETH to cover the amount plus the network fee.");
    this.name = "InsufficientFundsError";
  }
}

export class InvalidRecipientError extends Error {
  readonly code = "invalid_recipient";
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidRecipientError";
  }
}

export interface BuildTransactionParams {
  from: string;
  /** Undefined only for contract deployment. */
  to: string | undefined;
  /** Native value in wei. Zero for ERC-20 transfers, which move value in calldata. */
  value: bigint;
  data?: string;
  chainId: number;
  nonce: number;
  gasLimit: bigint;
  fee: FeeEstimate;
}

export function buildTransaction({
  to,
  value,
  data,
  chainId,
  nonce,
  gasLimit,
  fee,
}: BuildTransactionParams): TransactionSerializable {
  if (to !== undefined && !isValidAddress(to)) {
    throw new InvalidRecipientError(`"${to}" is not a valid Ethereum address.`);
  }
  if (value < 0n) throw new Error("Transaction value cannot be negative.");
  if (gasLimit <= 0n) throw new Error("Gas limit must be positive.");

  return {
    type: "eip1559",
    chainId,
    nonce,
    ...(to === undefined ? {} : { to: toChecksumAddress(to) as `0x${string}` }),
    value,
    gas: gasLimit,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    ...(data && data !== "0x" ? { data: data as `0x${string}` } : {}),
  };
}

export interface AssertSufficientBalanceParams {
  /** Native balance of the sending account, in wei. */
  nativeBalance: bigint;
  /** Native value being sent. Zero for token transfers. */
  value: bigint;
  gasLimit: bigint;
  fee: FeeEstimate;
}

/**
 * Checks the account can cover value plus the WORST-CASE fee.
 *
 * Deliberately checks against maxFeePerGas rather than the expected fee. The
 * expected fee is what they will probably pay, but the ceiling is what the
 * protocol may deduct if the base fee rises before inclusion. Approving against
 * the expected figure lets a transaction be accepted and then fail for
 * insufficient funds when the base fee moves.
 *
 * Note this applies to ERC-20 transfers too, where `value` is zero: the sender
 * still needs ETH for gas. "I have 500 USDC but cannot send it" is confusing
 * precisely because the missing asset is not the one being sent, so the UI must
 * say so explicitly.
 */
export function assertSufficientBalance({
  nativeBalance,
  value,
  gasLimit,
  fee,
}: AssertSufficientBalanceParams): void {
  const required = value + computeMaxTransactionFee(fee, gasLimit);
  if (required > nativeBalance) {
    throw new InsufficientFundsError(required, nativeBalance);
  }
}

export interface ComputeSendMaxParams {
  nativeBalance: bigint;
  gasLimit: bigint;
  fee: FeeEstimate;
}

/**
 * The largest native amount that can be sent while still paying for gas.
 *
 * "Send max" is one of the easiest features to get wrong: putting the full
 * balance in the value field produces a transaction that cannot pay its own fee
 * and is rejected outright. The ceiling is reserved, not the expected fee, so
 * the transaction stays valid even if the base fee climbs before inclusion. Any
 * unspent difference is refunded.
 *
 * Returns 0n when the balance cannot even cover the fee, rather than a negative
 * number the caller might use unchecked.
 */
export function computeSendMaxAmount({
  nativeBalance,
  gasLimit,
  fee,
}: ComputeSendMaxParams): bigint {
  const reserved = computeMaxTransactionFee(fee, gasLimit);
  return nativeBalance > reserved ? nativeBalance - reserved : 0n;
}

export interface TransactionCostSummary {
  /** Native value being transferred. */
  value: bigint;
  /** Expected fee at the current base fee. */
  expectedFee: bigint;
  /** Worst-case fee if the base fee rises to the ceiling. */
  maximumFee: bigint;
  expectedTotal: bigint;
  maximumTotal: bigint;
}

/**
 * The numbers the approval screen shows.
 *
 * Both figures are surfaced on purpose. Showing only the maximum makes the
 * wallet look expensive and pushes users to lower it into the stuck range;
 * showing only the expected cost hides the real worst case. Naming both is the
 * only honest presentation.
 */
export function summarizeTransactionCost({
  value,
  gasLimit,
  fee,
}: {
  value: bigint;
  gasLimit: bigint;
  fee: FeeEstimate;
}): TransactionCostSummary {
  const expectedFee = fee.expectedFeePerGas * gasLimit;
  const maximumFee = fee.maxFeePerGas * gasLimit;
  return {
    value,
    expectedFee,
    maximumFee,
    expectedTotal: value + expectedFee,
    maximumTotal: value + maximumFee,
  };
}
