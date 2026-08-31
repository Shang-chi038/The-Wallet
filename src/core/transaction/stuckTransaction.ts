import { computeReplacementFees } from "./nonceAllocator";

/**
 * Unsticking a transaction that the network has not picked up.
 *
 * ===========================================================================
 * WHAT "STUCK" MEANS, AND WHY IT IS NOT "PENDING"
 * ===========================================================================
 * Every transaction is pending for a while; that is normal and the wallet
 * already says so. A transaction is STUCK when it has been pending long enough
 * that waiting is no longer the obvious answer -- the fee was too low for the
 * market it landed in, and it will sit in mempools until it is dropped.
 *
 * The distinction matters because the two need opposite things from the UI. A
 * pending transaction needs reassurance. A stuck one needs a button. Offering
 * the button immediately would train users to bid up fees on transactions that
 * were about to confirm anyway, which is how a wallet quietly costs people
 * money.
 *
 * ===========================================================================
 * THE NONCE IS THE WHOLE MECHANISM
 * ===========================================================================
 * A replacement is not a new transaction; it is the SAME nonce, broadcast
 * again with a higher fee. That is what makes nodes evict the original instead
 * of queueing a second one. Cancelling works the same way: a transfer of
 * nothing, from the account to itself, occupying the nonce so the original can
 * never be mined.
 *
 * Both therefore require the original transaction's nonce and its original
 * fees -- which is why they are stored at broadcast. A node will not hand back
 * your own pending transaction, so a wallet that lost those numbers cannot bid
 * over them and can only offer a button that silently fails.
 */

export interface OutstandingTransaction {
  chainId: number;
  from: string;
  nonce: number;
  transactionHash: string;
  to: string | undefined;
  value: bigint;
  data: string | undefined;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  submittedAt: number;
  /** What the user thinks it is -- "0.25 ETH to 0x1234...abcd". */
  description: string;
}

/**
 * How long a transaction waits before the wallet offers to intervene.
 *
 * Ninety seconds is several blocks on any chain this wallet supports. Under
 * that, the honest advice is to wait: a fee that was adequate at broadcast
 * usually still is, and replacing it costs the user the higher fee for nothing.
 */
export const STUCK_TRANSACTION_AGE_MS = 90 * 1000;

export type ReplacementMode = "speedUp" | "cancel";

export interface StuckTransaction {
  nonce: number;
  transactionHash: string;
  description: string;
  submittedAt: number;
  /**
   * Only the OLDEST outstanding transaction can be acted on, and this says so.
   *
   * Nonces are sequential: nothing at nonce 8 can be mined while 7 is
   * outstanding, so a user who speeds up 8 pays more and waits exactly as long.
   * Worse, they would read the still-stuck queue as the button not working.
   * The oldest one is the blockage; clearing it releases the rest.
   */
  isBlocked: boolean;
}

export interface SelectStuckTransactionsParams {
  outstanding: readonly OutstandingTransaction[];
  now: number;
  minimumAgeMs?: number | undefined;
}

export function selectStuckTransactions({
  outstanding,
  now,
  minimumAgeMs = STUCK_TRANSACTION_AGE_MS,
}: SelectStuckTransactionsParams): StuckTransaction[] {
  const ordered = [...outstanding].sort((left, right) => left.nonce - right.nonce);
  const lowestNonce = ordered[0]?.nonce;

  return ordered
    .filter((entry) => now - entry.submittedAt >= minimumAgeMs)
    .map((entry) => ({
      nonce: entry.nonce,
      transactionHash: entry.transactionHash,
      description: entry.description,
      submittedAt: entry.submittedAt,
      isBlocked: entry.nonce !== lowestNonce,
    }));
}

export interface ReplacementFeeParams {
  /** What the stuck transaction bid. The floor a node will accept is set by it. */
  previous: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** What the network is charging now, from a fresh estimate. */
  current: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

/**
 * The fees a replacement must carry: over the original AND over the market.
 *
 * TWO FLOORS, and missing either one produces a button that does nothing.
 *
 * The node's rule is relative: geth evicts a transaction only for a
 * replacement bidding meaningfully more than IT did, which is what
 * `computeReplacementFees` satisfies. But a transaction is usually stuck
 * because the market moved above its bid, and +15% of a number that was too
 * low an hour ago is still too low -- accepted into the mempool, and stuck
 * again at a higher price.
 *
 * So the replacement takes the higher of the two, per field. It is the more
 * expensive answer and it is the only one that ends with the transaction
 * mined, which is what the user pressed the button for.
 */
export function computeReplacementFeesForMarket({
  previous,
  current,
}: ReplacementFeeParams): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const bumped = computeReplacementFees(previous);
  return {
    maxFeePerGas: bumped.maxFeePerGas > current.maxFeePerGas ? bumped.maxFeePerGas : current.maxFeePerGas,
    maxPriorityFeePerGas:
      bumped.maxPriorityFeePerGas > current.maxPriorityFeePerGas
        ? bumped.maxPriorityFeePerGas
        : current.maxPriorityFeePerGas,
  };
}

/**
 * What a replacement transaction is, per mode.
 *
 * A cancel is a self-transfer of zero. It is not "cancellation" in any sense
 * the chain understands -- there is no such operation -- it is a cheaper
 * transaction claiming the same nonce, so that when one of the two is mined it
 * is this one. That is worth saying in the UI too, because a user who believes
 * the original was withdrawn will not understand a fee they still have to pay.
 */
export function buildReplacementRequest(
  outstanding: OutstandingTransaction,
  mode: ReplacementMode,
): { to: string | undefined; value: bigint; data: string | undefined; gasLimit: bigint } {
  if (mode === "cancel") {
    return {
      to: outstanding.from,
      value: 0n,
      data: undefined,
      // A plain transfer, which is exactly 21000. Reusing the original's limit
      // would overstate the maximum fee of a transaction that does nothing.
      gasLimit: 21_000n,
    };
  }
  return {
    to: outstanding.to,
    value: outstanding.value,
    data: outstanding.data,
    // The same call, so the same limit. Re-estimating would ask the node about
    // a state that has moved on since the transaction was built, and an
    // estimate that came back LOWER would produce a replacement that runs out
    // of gas where the original would not have.
    gasLimit: outstanding.gasLimit,
  };
}
