import { describe, expect, it } from "vitest";
import {
  applyGasLimitMargin,
  computeExpectedTransactionFee,
  computeFeeEstimates,
  computeMaxTransactionFee,
  DEFAULT_MINIMUM_PRIORITY_FEE,
  scaleBigInt,
  type FeeHistorySample,
} from "@/core/transaction/feeEstimate";
import {
  computeReplacementFees,
  NonceAllocator,
  REPLACEMENT_FEE_BUMP_PERCENT,
} from "@/core/transaction/nonceAllocator";
import {
  assertSufficientBalance,
  buildTransaction,
  computeSendMaxAmount,
  InsufficientFundsError,
  InvalidRecipientError,
  summarizeTransactionCost,
} from "@/core/transaction/transactionBuilder";

const GWEI = 1_000_000_000n;

const HISTORY: FeeHistorySample = {
  baseFeePerGas: 20n * GWEI,
  rewardsByBlock: [
    [1n * GWEI, 2n * GWEI, 5n * GWEI],
    [1n * GWEI, 2n * GWEI, 6n * GWEI],
    [2n * GWEI, 3n * GWEI, 7n * GWEI],
  ],
};

describe("computeFeeEstimates", () => {
  it("orders the three levels by tip", () => {
    const estimates = computeFeeEstimates({ history: HISTORY });
    expect(estimates.low.maxPriorityFeePerGas).toBeLessThan(estimates.medium.maxPriorityFeePerGas);
    expect(estimates.medium.maxPriorityFeePerGas).toBeLessThan(estimates.high.maxPriorityFeePerGas);
  });

  it("takes the median tip per percentile column", () => {
    // Low column samples are 1, 1, 2 gwei -> median 1 gwei.
    expect(computeFeeEstimates({ history: HISTORY }).low.maxPriorityFeePerGas).toBe(1n * GWEI);
  });

  /** A mean would be dragged upward by one desperate high-tip transaction. */
  it("is not skewed by a single outlier block", () => {
    const withOutlier: FeeHistorySample = {
      ...HISTORY,
      rewardsByBlock: [...HISTORY.rewardsByBlock, [1n * GWEI, 2n * GWEI, 5000n * GWEI]],
    };
    expect(computeFeeEstimates({ history: withOutlier }).high.maxPriorityFeePerGas).toBeLessThan(
      100n * GWEI,
    );
  });

  /** 1.125^6 ~= 2.03x, covering six blocks of maximum base-fee growth. */
  it("sets the ceiling about 2x the base fee plus the tip", () => {
    const { medium } = computeFeeEstimates({ history: HISTORY });
    const ceilingPortion = medium.maxFeePerGas - medium.maxPriorityFeePerGas;
    expect(ceilingPortion).toBeGreaterThan(2n * HISTORY.baseFeePerGas);
    expect(ceilingPortion).toBeLessThan((21n * HISTORY.baseFeePerGas) / 10n);
  });

  it("expected cost is base fee plus tip, below the ceiling", () => {
    const { medium } = computeFeeEstimates({ history: HISTORY });
    expect(medium.expectedFeePerGas).toBe(HISTORY.baseFeePerGas + medium.maxPriorityFeePerGas);
    expect(medium.expectedFeePerGas).toBeLessThan(medium.maxFeePerGas);
  });

  it("applies a tip floor so a zero-tip estimate cannot strand a transaction", () => {
    const zeroTips: FeeHistorySample = {
      baseFeePerGas: 10n * GWEI,
      rewardsByBlock: [[0n, 0n, 0n]],
    };
    expect(computeFeeEstimates({ history: zeroTips }).low.maxPriorityFeePerGas).toBe(
      DEFAULT_MINIMUM_PRIORITY_FEE,
    );
  });

  it("handles empty fee history without throwing", () => {
    const empty: FeeHistorySample = { baseFeePerGas: 10n * GWEI, rewardsByBlock: [] };
    expect(computeFeeEstimates({ history: empty }).medium.maxPriorityFeePerGas).toBe(
      DEFAULT_MINIMUM_PRIORITY_FEE,
    );
  });

  /** Number(wei) * 1.125 loses precision above 2^53. */
  it("stays exact at mainnet-scale values", () => {
    const huge = 12_345_678_901_234_567_890n;
    expect(scaleBigInt(huge, 9n, 8n)).toBe((huge * 9n) / 8n);
    expect(Number.isSafeInteger(Number(huge))).toBe(false);
  });
});

describe("gas limit margin", () => {
  it("adds 20% headroom", () => {
    expect(applyGasLimitMargin(21_000n)).toBe(25_200n);
  });

  it("never returns less than the estimate", () => {
    expect(applyGasLimitMargin(1n)).toBeGreaterThanOrEqual(1n);
  });
});

describe("NonceAllocator", () => {
  const account = { chainId: 1, address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" };

  it("returns the chain's pending nonce when nothing is in flight", () => {
    expect(new NonceAllocator().allocate({ ...account, pendingNonceFromChain: 5 })).toBe(5);
  });

  /** The collision failure: two rapid sends must not share a nonce. */
  it("hands out distinct nonces for concurrent sends", () => {
    const allocator = new NonceAllocator();
    const first = allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    const second = allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    const third = allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    expect([first, second, third]).toEqual([5, 6, 7]);
  });

  /** The gap failure: a rejected transaction must not strand the ones behind it. */
  it("reuses a released nonce instead of leaving a gap", () => {
    const allocator = new NonceAllocator();
    allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    const second = allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    allocator.release(account, second);
    expect(allocator.allocate({ ...account, pendingNonceFromChain: 5 })).toBe(second);
  });

  it("advances with the chain once a transaction confirms", () => {
    const allocator = new NonceAllocator();
    const first = allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    allocator.confirm(account, first);
    expect(allocator.allocate({ ...account, pendingNonceFromChain: 6 })).toBe(6);
  });

  it("keeps accounts and chains independent", () => {
    const allocator = new NonceAllocator();
    allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    const otherChain = allocator.allocate({
      ...account,
      chainId: 11155111,
      pendingNonceFromChain: 5,
    });
    const otherAccount = allocator.allocate({
      chainId: 1,
      address: "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
      pendingNonceFromChain: 5,
    });
    expect(otherChain).toBe(5);
    expect(otherAccount).toBe(5);
  });

  it("matches addresses case-insensitively", () => {
    const allocator = new NonceAllocator();
    allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    expect(
      allocator.allocate({
        ...account,
        address: account.address.toLowerCase(),
        pendingNonceFromChain: 5,
      }),
    ).toBe(6);
  });

  it("clears everything on reset, as required on lock", () => {
    const allocator = new NonceAllocator();
    allocator.allocate({ ...account, pendingNonceFromChain: 5 });
    allocator.reset();
    expect(allocator.listInFlight(account)).toEqual([]);
    expect(allocator.allocate({ ...account, pendingNonceFromChain: 5 })).toBe(5);
  });

  it("rejects a negative pending nonce", () => {
    expect(() =>
      new NonceAllocator().allocate({ ...account, pendingNonceFromChain: -1 }),
    ).toThrow();
  });
});

describe("computeReplacementFees", () => {
  /** Geth requires +10% to evict; we use +15% for margin. */
  it("bumps above the node eviction threshold", () => {
    const bumped = computeReplacementFees({
      maxFeePerGas: 100n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    expect(bumped.maxFeePerGas).toBe(115n * GWEI);
    expect(REPLACEMENT_FEE_BUMP_PERCENT).toBeGreaterThan(10n);
  });
});

describe("buildTransaction", () => {
  const fee = computeFeeEstimates({ history: HISTORY }).medium;
  const base = {
    from: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    to: "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
    value: 10n ** 15n,
    chainId: 11155111,
    nonce: 3,
    gasLimit: 21_000n,
    fee,
  };

  it("produces a well-formed EIP-1559 transaction", () => {
    expect(buildTransaction(base)).toMatchObject({
      type: "eip1559",
      chainId: 11155111,
      nonce: 3,
      gas: 21_000n,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    });
  });

  it("checksums the recipient", () => {
    expect(buildTransaction({ ...base, to: base.to.toLowerCase() }).to).toBe(base.to);
  });

  it("omits `to` for contract deployment", () => {
    expect(buildTransaction({ ...base, to: undefined }).to).toBeUndefined();
  });

  it("rejects an invalid recipient", () => {
    expect(() => buildTransaction({ ...base, to: "0xnothex" })).toThrow(InvalidRecipientError);
  });

  it("rejects a zero gas limit", () => {
    expect(() => buildTransaction({ ...base, gasLimit: 0n })).toThrow();
  });
});

describe("assertSufficientBalance", () => {
  const fee = computeFeeEstimates({ history: HISTORY }).medium;
  const gasLimit = 21_000n;
  const maxFee = computeMaxTransactionFee(fee, gasLimit);

  it("passes when the balance covers value plus the worst-case fee", () => {
    expect(() =>
      assertSufficientBalance({ nativeBalance: maxFee + 100n, value: 100n, gasLimit, fee }),
    ).not.toThrow();
  });

  /**
   * Checked against the ceiling, not the expected fee: a base-fee rise between
   * approval and inclusion must not turn an accepted transaction into a failed
   * one.
   */
  it("rejects a balance that only covers the expected fee", () => {
    const expectedFee = computeExpectedTransactionFee(fee, gasLimit);
    expect(expectedFee).toBeLessThan(maxFee);
    expect(() =>
      assertSufficientBalance({ nativeBalance: expectedFee + 100n, value: 100n, gasLimit, fee }),
    ).toThrow(InsufficientFundsError);
  });

  /** Token sends move no ETH but still need ETH for gas. */
  it("still requires gas money for a zero-value token transfer", () => {
    expect(() => assertSufficientBalance({ nativeBalance: 0n, value: 0n, gasLimit, fee })).toThrow(
      InsufficientFundsError,
    );
  });
});

describe("computeSendMaxAmount", () => {
  const fee = computeFeeEstimates({ history: HISTORY }).medium;
  const gasLimit = 21_000n;

  /** Sending the full balance produces a transaction that cannot pay its fee. */
  it("reserves the worst-case fee", () => {
    const balance = 10n ** 18n;
    expect(computeSendMaxAmount({ nativeBalance: balance, gasLimit, fee })).toBe(
      balance - computeMaxTransactionFee(fee, gasLimit),
    );
  });

  it("leaves a send-max transaction affordable", () => {
    const balance = 10n ** 18n;
    const value = computeSendMaxAmount({ nativeBalance: balance, gasLimit, fee });
    expect(() =>
      assertSufficientBalance({ nativeBalance: balance, value, gasLimit, fee }),
    ).not.toThrow();
  });

  it("returns zero rather than a negative when the fee exceeds the balance", () => {
    expect(computeSendMaxAmount({ nativeBalance: 1n, gasLimit, fee })).toBe(0n);
  });
});

describe("summarizeTransactionCost", () => {
  const fee = computeFeeEstimates({ history: HISTORY }).medium;

  it("reports expected and maximum separately", () => {
    const summary = summarizeTransactionCost({ value: 1000n, gasLimit: 21_000n, fee });
    expect(summary.expectedFee).toBeLessThan(summary.maximumFee);
    expect(summary.expectedTotal).toBe(1000n + summary.expectedFee);
    expect(summary.maximumTotal).toBe(1000n + summary.maximumFee);
  });
});
