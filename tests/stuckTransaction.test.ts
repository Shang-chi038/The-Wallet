import { describe, expect, it } from "vitest";
import { createMemoryStorageArea } from "@/core/vault/vaultStorage";
import {
  OutstandingTransactionStore,
  OUTSTANDING_TRANSACTIONS_STORAGE_KEY,
  OUTSTANDING_TRANSACTION_TTL_MS,
} from "@/background/outstandingTransactionStore";
import {
  buildReplacementRequest,
  computeReplacementFeesForMarket,
  selectStuckTransactions,
  STUCK_TRANSACTION_AGE_MS,
  type OutstandingTransaction,
} from "@/core/transaction/stuckTransaction";
import { REPLACEMENT_FEE_BUMP_PERCENT } from "@/core/transaction/nonceAllocator";
import type {
  PrepareSendResult,
  StuckTransactionsResult,
  SubmitSendResult,
} from "@/core/messaging/walletApi";
import {
  createHarness,
  expectError,
  expectResult,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
  type Harness,
} from "./support/routerHarness";

/**
 * Unsticking a transaction.
 *
 * The properties that matter, and why each one is a real failure if it breaks:
 *
 *   A REPLACEMENT REUSES THE NONCE. Allocate a fresh one and the wallet has
 *   queued a second transaction behind the stuck one instead of replacing it --
 *   two fees, and neither moves until the first does.
 *
 *   IT OUTBIDS BOTH THE ORIGINAL AND THE MARKET. Nodes evict on a relative
 *   threshold; the market decides whether the result gets mined. Missing either
 *   floor produces a button that appears to do nothing.
 *
 *   IT SURVIVES THE WORKER. The question "why is this not going through" is
 *   asked hours later, by which time the service worker has been collected
 *   several times.
 */

const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

function outstanding(overrides: Partial<OutstandingTransaction> = {}): OutstandingTransaction {
  return {
    chainId: 11155111,
    from: TEST_ADDRESS,
    nonce: 7,
    transactionHash: `0x${"11".repeat(32)}`,
    to: RECIPIENT,
    value: 10n ** 17n,
    data: undefined,
    gasLimit: 21_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    submittedAt: 1_000_000,
    description: "0.1 ETH to 0x0000...dEaD",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The rules, with no engine involved
// ---------------------------------------------------------------------------

describe("selectStuckTransactions", () => {
  it("says nothing about a transaction that is merely young", () => {
    const now = 1_000_000 + STUCK_TRANSACTION_AGE_MS - 1;
    expect(selectStuckTransactions({ outstanding: [outstanding()], now })).toEqual([]);
  });

  it("reports one that has waited long enough", () => {
    const now = 1_000_000 + STUCK_TRANSACTION_AGE_MS;
    const stuck = selectStuckTransactions({ outstanding: [outstanding()], now });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.isBlocked).toBe(false);
  });

  /**
   * Nonces are sequential. Nothing at nonce 8 can be mined while 7 is
   * outstanding, so speeding up 8 costs more and changes nothing -- and leaves
   * the user reading an unchanged queue as a broken button.
   */
  it("marks everything behind the oldest as blocked by it", () => {
    const now = 1_000_000 + STUCK_TRANSACTION_AGE_MS;
    const stuck = selectStuckTransactions({
      outstanding: [outstanding({ nonce: 9 }), outstanding({ nonce: 7 }), outstanding({ nonce: 8 })],
      now,
    });
    expect(stuck.map((entry) => [entry.nonce, entry.isBlocked])).toEqual([
      [7, false],
      [8, true],
      [9, true],
    ]);
  });
});

describe("computeReplacementFeesForMarket", () => {
  const previous = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };

  it("bumps past the original when the market has not moved", () => {
    const fees = computeReplacementFeesForMarket({
      previous,
      current: { maxFeePerGas: 90n, maxPriorityFeePerGas: 9n },
    });
    expect(fees.maxFeePerGas).toBe(100n + (100n * REPLACEMENT_FEE_BUMP_PERCENT) / 100n);
    expect(fees.maxFeePerGas).toBeGreaterThan(previous.maxFeePerGas);
  });

  /**
   * The half a naive implementation misses. A transaction is usually stuck
   * because the market moved above its bid, and +15% of a number that was too
   * low an hour ago is still too low -- accepted, and stuck again.
   */
  it("takes the market price when it has moved above the bump", () => {
    const fees = computeReplacementFeesForMarket({
      previous,
      current: { maxFeePerGas: 500n, maxPriorityFeePerGas: 50n },
    });
    expect(fees).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 50n });
  });
});

describe("buildReplacementRequest", () => {
  it("repeats the original call for a speed-up", () => {
    const original = outstanding({ data: "0xabcdef", gasLimit: 65_000n });
    expect(buildReplacementRequest(original, "speedUp")).toEqual({
      to: original.to,
      value: original.value,
      data: original.data,
      gasLimit: 65_000n,
    });
  });

  /**
   * A cancel is a self-transfer of zero occupying the same nonce. There is no
   * "cancel" operation on the chain -- which is why the UI has to say the fee
   * is still payable.
   */
  it("builds a cancel as an empty self-transfer", () => {
    const original = outstanding({ data: "0xabcdef", gasLimit: 65_000n });
    expect(buildReplacementRequest(original, "cancel")).toEqual({
      to: original.from,
      value: 0n,
      data: undefined,
      gasLimit: 21_000n,
    });
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("OutstandingTransactionStore", () => {
  const key = { chainId: 11155111, address: TEST_ADDRESS };

  async function storeWith(now: () => number = () => 1_000_000) {
    const area = createMemoryStorageArea();
    const store = new OutstandingTransactionStore({ area, now });
    await store.load();
    return { area, store };
  }

  it("survives the worker that wrote it", async () => {
    const { area, store } = await storeWith();
    await store.record({ ...outstanding(), transactionHash: `0x${"aa".repeat(32)}` });

    // A cold store over the same area: the worker was collected and restarted.
    const revived = new OutstandingTransactionStore({ area, now: () => 1_000_000 });
    const found = await revived.find({ ...key, nonce: 7 });
    expect(found?.maxFeePerGas).toBe(20_000_000_000n);
    expect(found?.value).toBe(10n ** 17n);
  });

  /**
   * A speed-up records the SAME nonce again. Keeping both would leave the
   * wallet offering to replace a transaction that has already been replaced,
   * at the fees of the one that lost.
   */
  it("replaces the record for a nonce rather than accumulating", async () => {
    const { store } = await storeWith();
    await store.record(outstanding());
    await store.record({ ...outstanding(), maxFeePerGas: 40_000_000_000n });

    const remaining = await store.reconcile({ ...key, latestNonce: 7 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.maxFeePerGas).toBe(40_000_000_000n);
  });

  /**
   * The authority is the chain, not the record. Offering to replace something
   * already mined produces a transaction that can never be mined -- after the
   * user has paid to discover it.
   */
  it("deletes anything the chain has moved past", async () => {
    const { store } = await storeWith();
    await store.record(outstanding({ nonce: 7 }));
    await store.record(outstanding({ nonce: 8 }));

    expect(await store.reconcile({ ...key, latestNonce: 8 })).toHaveLength(1);
    expect(await store.find({ ...key, nonce: 7 })).toBeUndefined();
  });

  it("expires records nobody came back for", async () => {
    let clock = 1_000_000;
    const { store } = await storeWith(() => clock);
    await store.record(outstanding());

    clock += OUTSTANDING_TRANSACTION_TTL_MS + 1;
    expect(await store.reconcile({ ...key, latestNonce: 7 })).toEqual([]);
  });

  /**
   * These numbers become the fees and the nonce of a transaction the wallet
   * signs, so a malformed record is dropped rather than repaired.
   */
  it("drops stored records that do not parse exactly", async () => {
    const area = createMemoryStorageArea();
    await area.set(OUTSTANDING_TRANSACTIONS_STORAGE_KEY, [
      // Missing everything but a nonce.
      { nonce: 7 },
      // A fee stored as a NUMBER rather than a decimal string: the exact shape
      // a lossy round-trip through JSON would produce, and the one that must
      // never become a fee the wallet signs.
      {
        chainId: 11155111,
        from: TEST_ADDRESS,
        nonce: 8,
        transactionHash: "0x00",
        to: RECIPIENT,
        valueBaseUnits: "0",
        gasLimit: "21000",
        maxFeePerGas: 20_000_000_000,
        maxPriorityFeePerGas: "1000000000",
        submittedAt: 1_000_000,
        description: "x",
      },
      "not a record",
      null,
    ]);
    const store = new OutstandingTransactionStore({ area, now: () => 1_000_000 });
    expect(await store.reconcile({ ...key, latestNonce: 0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the router
// ---------------------------------------------------------------------------

async function sentHarness(): Promise<Harness> {
  const harness = createHarness();
  await harness.createAndUnlockWallet();

  const prepared = expectResult<PrepareSendResult>(
    await harness.route(
      {
        method: "wallet.prepareSend",
        params: { recipient: RECIPIENT, amountBaseUnits: (10n ** 16n).toString() },
      },
      PRIVILEGED_SENDER,
    ),
  );
  expectResult<SubmitSendResult>(
    await harness.route(
      { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
      PRIVILEGED_SENDER,
    ),
  );
  return harness;
}

async function listStuck(harness: Harness): Promise<StuckTransactionsResult> {
  return expectResult<StuckTransactionsResult>(
    await harness.route({ method: "wallet.listStuckTransactions" }, PRIVILEGED_SENDER),
  );
}

describe("wallet.listStuckTransactions", () => {
  /**
   * The harness clock is fixed, so a transaction broadcast during the test is
   * always younger than the stuck threshold. That IS the assertion: the wallet
   * does not offer to bid up a transaction that was sent a moment ago.
   */
  it("does not offer to replace a transaction that was just sent", async () => {
    const harness = await sentHarness();
    expect((await listStuck(harness)).transactions).toEqual([]);
  });

  it("reports one that has been outstanding long enough", async () => {
    const harness = await sentHarness();
    // Backdate the record rather than the clock: it is the transaction that
    // has aged, and everything else about the harness should stay still.
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);

    const result = await listStuck(harness);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.description).toContain("ETH");
    expect(result.transactions[0]?.isBlocked).toBe(false);
  });

  it("reports nothing once the chain has moved past it", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    harness.chain.confirmedNonce = harness.chain.pendingNonce + 1;

    expect((await listStuck(harness)).transactions).toEqual([]);
  });
});

describe("wallet.prepareReplacement", () => {
  it("reuses the stuck nonce and outbids the original", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    const stuck = (await listStuck(harness)).transactions[0];

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareReplacement",
          params: { nonce: stuck?.nonce, mode: "speedUp" },
        },
        PRIVILEGED_SENDER,
      ),
    );

    expect(prepared.presentation.nonce).toBe(stuck?.nonce);
    const original = await harness.context.outstandingTransactions.find({
      chainId: harness.chain.chainId,
      address: TEST_ADDRESS,
      nonce: stuck?.nonce ?? 0,
    });
    expect(BigInt(prepared.presentation.maximumFeeBaseUnits)).toBeGreaterThan(0n);
    expect(original).toBeDefined();
  });

  it("builds a cancel as a self-transfer of nothing", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    const stuck = (await listStuck(harness)).transactions[0];

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        { method: "wallet.prepareReplacement", params: { nonce: stuck?.nonce, mode: "cancel" } },
        PRIVILEGED_SENDER,
      ),
    );

    expect(prepared.presentation.recipient?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(prepared.presentation.valueBaseUnits).toBe("0");
    expect(prepared.transferLabel).toBe("Nothing, to yourself");
  });

  /**
   * The replacement is broadcast through the ordinary submit path, and the
   * record for that nonce is then the replacement's -- so a second speed-up
   * bids over the transaction that is actually in the mempool.
   */
  it("broadcasts through submitSend and takes over the record", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    const stuck = (await listStuck(harness)).transactions[0];
    const before = await harness.context.outstandingTransactions.find({
      chainId: harness.chain.chainId,
      address: TEST_ADDRESS,
      nonce: stuck?.nonce ?? 0,
    });

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        { method: "wallet.prepareReplacement", params: { nonce: stuck?.nonce, mode: "speedUp" } },
        PRIVILEGED_SENDER,
      ),
    );
    expectResult<SubmitSendResult>(
      await harness.route(
        { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
        PRIVILEGED_SENDER,
      ),
    );

    const after = await harness.context.outstandingTransactions.find({
      chainId: harness.chain.chainId,
      address: TEST_ADDRESS,
      nonce: stuck?.nonce ?? 0,
    });
    expect(after?.nonce).toBe(before?.nonce);
    expect(after?.maxFeePerGas).toBeGreaterThan(before?.maxFeePerGas ?? 0n);
  });

  it("refuses a nonce that is not outstanding", async () => {
    const harness = await sentHarness();
    expectError(
      await harness.route(
        { method: "wallet.prepareReplacement", params: { nonce: 999, mode: "speedUp" } },
        PRIVILEGED_SENDER,
      ),
    );
  });

  /**
   * The list was reconciled when it was fetched, and the user has been reading
   * it since. A transaction that confirmed in between must not be replaced:
   * the replacement would occupy a nonce the chain has passed, and be stuck by
   * construction.
   */
  it("refuses once the transaction has confirmed under the user", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    const stuck = (await listStuck(harness)).transactions[0];

    harness.chain.confirmedNonce = (stuck?.nonce ?? 0) + 1;

    expectError(
      await harness.route(
        { method: "wallet.prepareReplacement", params: { nonce: stuck?.nonce, mode: "speedUp" } },
        PRIVILEGED_SENDER,
      ),
    );
  });

  it("refuses a mode it was never offered", async () => {
    const harness = await sentHarness();
    await harness.backdateOutstandingTransactions(STUCK_TRANSACTION_AGE_MS);
    const stuck = (await listStuck(harness)).transactions[0];

    expectError(
      await harness.route(
        { method: "wallet.prepareReplacement", params: { nonce: stuck?.nonce, mode: "refund" } },
        PRIVILEGED_SENDER,
      ),
    );
  });

  /** Wallet state, erased with the wallet -- it names a recipient and an amount. */
  it("is cleared by a wallet reset", async () => {
    const harness = await sentHarness();
    await harness.route({ method: "wallet.reset" }, PRIVILEGED_SENDER);

    expect(
      await harness.context.outstandingTransactions.reconcile({
        chainId: harness.chain.chainId,
        address: TEST_ADDRESS,
        latestNonce: 0,
      }),
    ).toEqual([]);
  });
});
