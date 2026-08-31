import type { PublicClient, TransactionSerializable } from "viem";
import {
  FALLBACK_GAS_LIMITS,
  isInsufficientFundsEstimationError,
  type FeeHistorySample,
  type GasLimitFallbackKind,
} from "@/core/transaction/feeEstimate";

/**
 * Chain reads that feed the fee and nonce builders.
 *
 * Kept behind this seam so the pure builders in `core/transaction` stay testable
 * without a network, and so the RPC provider remains swappable.
 */

/**
 * Percentiles requested from eth_feeHistory, matching the low/medium/high
 * columns that `computeFeeEstimates` reads by index. Changing these without
 * changing that reader silently mislabels the fee levels.
 */
export const FEE_HISTORY_PERCENTILES = [10, 50, 90] as const;

/**
 * Blocks of history to sample.
 *
 * Enough to smooth out a single unusual block, short enough to still track a
 * genuine congestion spike. Twenty blocks is roughly four minutes on mainnet.
 */
export const FEE_HISTORY_BLOCK_COUNT = 20;

export interface NetworkReader {
  readFeeHistory(): Promise<FeeHistorySample>;
  readPendingNonce(address: string): Promise<number>;
  /**
   * The account's nonce counting only MINED transactions.
   *
   * The counterpart to `readPendingNonce`, and the two are used for opposite
   * jobs. A send needs "pending" so it does not collide with something already
   * in the mempool. Deciding whether a transaction is still outstanding needs
   * "latest": anything below this number has settled -- mined, or replaced by
   * something that was -- and offering to replace it could only produce a
   * transaction that can never be mined.
   */
  readConfirmedNonce(address: string): Promise<number>;
  estimateGas(params: {
    from: string;
    to?: string | undefined;
    value?: bigint | undefined;
    data?: string | undefined;
  }): Promise<bigint>;
  /**
   * Estimates gas, falling back to a static limit when the sender cannot afford
   * the transaction. `isEstimated: false` means the figure is an approximation
   * and the UI must label the fee as such.
   */
  estimateGasWithFallback(params: {
    from: string;
    to?: string | undefined;
    value?: bigint | undefined;
    data?: string | undefined;
    fallbackKind: GasLimitFallbackKind;
  }): Promise<{ gasLimit: bigint; isEstimated: boolean }>;
  sendRawTransaction(serialized: string): Promise<string>;
}

export function createViemNetworkReader(client: PublicClient): NetworkReader {
  return {
    async readFeeHistory() {
      const history = await client.getFeeHistory({
        blockCount: FEE_HISTORY_BLOCK_COUNT,
        rewardPercentiles: [...FEE_HISTORY_PERCENTILES],
      });

      // getFeeHistory returns baseFeePerGas with one MORE entry than blocks: the
      // extra trailing value is the projected base fee for the NEXT block. That
      // projection is the right input for a transaction we are about to send —
      // using the last mined block's base fee instead consistently under-prices
      // during rising congestion.
      return {
        baseFeePerGas: history.baseFeePerGas.at(-1) ?? 0n,
        rewardsByBlock: history.reward ?? [],
      };
    },

    async readPendingNonce(address) {
      // "pending", not "latest": "latest" ignores transactions already in the
      // mempool, so every send made while one is unconfirmed would collide.
      return client.getTransactionCount({
        address: address as `0x${string}`,
        blockTag: "pending",
      });
    },

    async readConfirmedNonce(address) {
      return client.getTransactionCount({
        address: address as `0x${string}`,
        blockTag: "latest",
      });
    },

    async estimateGas({ from, to, value, data }) {
      return client.estimateGas({
        account: from as `0x${string}`,
        ...(to === undefined ? {} : { to: to as `0x${string}` }),
        ...(value === undefined ? {} : { value }),
        ...(data === undefined ? {} : { data: data as `0x${string}` }),
      });
    },

    async estimateGasWithFallback({ from, to, value, data, fallbackKind }) {
      try {
        return { gasLimit: await this.estimateGas({ from, to, value, data }), isEstimated: true };
      } catch (error) {
        // Only substitute a fallback when the failure is about affordability. A
        // revert means the transaction genuinely cannot succeed, and hiding that
        // behind a plausible gas number would let the user broadcast a
        // transaction that burns a fee to fail.
        if (!isInsufficientFundsEstimationError(error)) throw error;
        return { gasLimit: FALLBACK_GAS_LIMITS[fallbackKind], isEstimated: false };
      }
    },

    async sendRawTransaction(serialized) {
      return client.sendRawTransaction({ serializedTransaction: serialized as `0x${string}` });
    },
  };
}

/**
 * Convenience type re-export so the send flow can name what it signs without
 * reaching into viem directly.
 */
export type SignableTransaction = TransactionSerializable;
