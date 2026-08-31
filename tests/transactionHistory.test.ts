import { describe, expect, it } from "vitest";
import {
  buildExplorerUrl,
  classifyDirection,
  describeActivity,
  describeActivityTime,
  dropSupersededPending,
  mergeActivity,
  type ActivityEntry,
} from "@/core/activity/transactionHistory";
import { PendingTransactionLog } from "@/background/pendingTransactionLog";
import type { ActivityResult } from "@/core/messaging/walletApi";
import {
  createHarness,
  expectResult,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
} from "./support/routerHarness";

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "t1",
    transactionHash: `0x${"11".repeat(32)}`,
    blockNumber: 100n,
    timestamp: 1_700_000_000_000,
    direction: "received",
    from: OTHER,
    to: OWNER,
    counterparty: OTHER,
    assetKind: "native",
    symbol: "ETH",
    decimals: 18,
    amount: 10n ** 18n,
    tokenAddress: undefined,
    chainId: 11155111,
    status: "confirmed",
    ...overrides,
  };
}

describe("direction", () => {
  it("reads sent and received from the owner's point of view", () => {
    expect(classifyDirection({ from: OWNER, to: OTHER, owner: OWNER })).toBe("sent");
    expect(classifyDirection({ from: OTHER, to: OWNER, owner: OWNER })).toBe("received");
  });

  /**
   * A move between the user's own accounts is not a payment. Labelling it
   * "sent" makes a rebalance look like money leaving -- which is the kind of
   * thing that makes someone think they have been robbed.
   */
  it("calls a self-transfer what it is", () => {
    expect(classifyDirection({ from: OWNER, to: OWNER, owner: OWNER })).toBe("self");
  });

  it("is case-insensitive, so a checksum difference does not flip it", () => {
    expect(classifyDirection({ from: OWNER.toLowerCase(), to: OTHER, owner: OWNER })).toBe("sent");
  });

  it("treats a contract deployment as sent, not received", () => {
    expect(classifyDirection({ from: OWNER, to: undefined, owner: OWNER })).toBe("sent");
  });
});

describe("merging", () => {
  /**
   * The indexer is queried once for transfers FROM the address and once for
   * transfers TO it, because that is the only way to get both directions. A
   * self-transfer appears in both, and without deduplication the activity list
   * shows it twice -- which reads as the wallet having sent something twice.
   */
  it("deduplicates a transfer that appears in both queries", () => {
    const shared = entry({ id: "same", direction: "self" });
    expect(mergeActivity([shared], [shared])).toHaveLength(1);
  });

  it("orders newest first", () => {
    const merged = mergeActivity([
      entry({ id: "a", blockNumber: 10n }),
      entry({ id: "b", blockNumber: 30n }),
      entry({ id: "c", blockNumber: 20n }),
    ]);
    expect(merged.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("orders stably within a block, so a refetch does not shuffle rows", () => {
    const first = mergeActivity([
      entry({ id: "a", blockNumber: 5n }),
      entry({ id: "b", blockNumber: 5n }),
    ]);
    const second = mergeActivity([
      entry({ id: "b", blockNumber: 5n }),
      entry({ id: "a", blockNumber: 5n }),
    ]);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  });

  /**
   * Pending has no block number. Sorting it by the 0n placeholder would bury
   * the transaction the user is actually waiting on beneath their whole
   * history.
   */
  it("puts pending first regardless of block number", () => {
    const merged = mergeActivity([
      entry({ id: "old", blockNumber: 900n }),
      entry({ id: "new", blockNumber: 0n, status: "pending" }),
    ]);
    expect(merged[0]?.id).toBe("new");
  });

  it("drops a pending row once the indexer reports the same hash", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const pending = [entry({ id: "pending:x", transactionHash: hash, status: "pending" })];
    const confirmed = [entry({ id: "indexed", transactionHash: hash })];
    expect(dropSupersededPending(pending, confirmed)).toEqual([]);
  });

  it("keeps a pending row the indexer has not caught up on", () => {
    const pending = [entry({ id: "pending:x", transactionHash: `0x${"cd".repeat(32)}`, status: "pending" })];
    const confirmed = [entry({ id: "indexed", transactionHash: `0x${"ab".repeat(32)}` })];
    expect(dropSupersededPending(pending, confirmed)).toHaveLength(1);
  });
});

describe("descriptions", () => {
  it("says what happened in the user's terms", () => {
    expect(describeActivity(entry({ direction: "received" }))).toBe("Received ETH");
    expect(describeActivity(entry({ direction: "sent" }))).toBe("Sent ETH");
    expect(describeActivity(entry({ direction: "self" }))).toContain("between your accounts");
  });

  it("says a pending transfer is still sending", () => {
    expect(describeActivity(entry({ status: "pending", direction: "sent" }))).toBe("Sending ETH");
  });

  it("is relative up to a week and absolute after", () => {
    const now = 1_700_000_000_000;
    expect(describeActivityTime(now - 30_000, now)).toBe("just now");
    expect(describeActivityTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(describeActivityTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(describeActivityTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(describeActivityTime(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /** Clock skew must not produce "in 3 seconds" next to a mined transaction. */
  it("does not render a future timestamp as negative", () => {
    const now = 1_700_000_000_000;
    expect(describeActivityTime(now + 5_000, now)).toBe("just now");
  });

  it("omits the explorer link when no explorer is configured", () => {
    expect(buildExplorerUrl("", `0x${"11".repeat(32)}`)).toBeUndefined();
    expect(buildExplorerUrl("https://sepolia.etherscan.io", "0xabc")).toBe(
      "https://sepolia.etherscan.io/tx/0xabc",
    );
  });
});

describe("pending transaction log", () => {
  it("filters by chain, so a testnet send is not shown on mainnet", () => {
    const log = new PendingTransactionLog();
    log.record({
      transactionHash: `0x${"11".repeat(32)}`,
      chainId: 11155111,
      from: OWNER,
      to: OTHER,
      amount: 1n,
      symbol: "ETH",
      decimals: 18,
      tokenAddress: undefined,
    });
    expect(log.list(11155111, OWNER)).toHaveLength(1);
    expect(log.list(1, OWNER)).toHaveLength(0);
  });

  it("filters by account", () => {
    const log = new PendingTransactionLog();
    log.record({
      transactionHash: `0x${"11".repeat(32)}`,
      chainId: 1,
      from: OWNER,
      to: OTHER,
      amount: 1n,
      symbol: "ETH",
      decimals: 18,
      tokenAddress: undefined,
    });
    expect(log.list(1, OTHER)).toHaveLength(0);
  });

  /**
   * A transaction still unmined after the TTL either made it -- and the
   * indexer will show it -- or was dropped from the mempool. Continuing to
   * display it as pending would be a lie the wallet cannot detect.
   */
  it("expires stale entries", () => {
    let clock = 1_000;
    const log = new PendingTransactionLog({ now: () => clock });
    log.record({
      transactionHash: `0x${"11".repeat(32)}`,
      chainId: 1,
      from: OWNER,
      to: OTHER,
      amount: 1n,
      symbol: "ETH",
      decimals: 18,
      tokenAddress: undefined,
    });
    expect(log.list(1, OWNER)).toHaveLength(1);
    clock += 31 * 60 * 1000;
    expect(log.list(1, OWNER)).toHaveLength(0);
  });

  it("clears on reset, alongside the nonce allocator", () => {
    const log = new PendingTransactionLog();
    log.record({
      transactionHash: `0x${"11".repeat(32)}`,
      chainId: 1,
      from: OWNER,
      to: OTHER,
      amount: 1n,
      symbol: "ETH",
      decimals: 18,
      tokenAddress: undefined,
    });
    log.reset();
    expect(log.list(1, OWNER)).toHaveLength(0);
  });
});

describe("wallet.getActivity", () => {
  /**
   * THE TRAP THIS TEST EXISTS FOR.
   *
   * Alchemy returns both a convenient `value` (a JSON double, already divided
   * by decimals) and an exact `rawContract.value` in base units. Above ~0.009
   * ETH the double has already lost precision by the time it reaches us. A
   * history built on it shows balances that do not match the chain.
   */
  it("reads the exact raw amount, never the lossy `value` field", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const exact = 123_456_789_012_345_678_901n;
    harness.chain.transfersTo = [
      {
        uniqueId: "u1",
        hash: `0x${"11".repeat(32)}`,
        blockNum: "0x64",
        from: OTHER,
        to: TEST_ADDRESS,
        asset: "ETH",
        category: "external",
        // Deliberately WRONG and lossy, as the real API's value field is.
        value: 123.45678901234568,
        rawContract: { value: `0x${exact.toString(16)}`, address: null, decimal: "0x12" },
        metadata: { blockTimestamp: "2024-01-01T00:00:00.000Z" },
      },
    ];

    const activity = expectResult<ActivityResult>(
      await harness.route({ method: "wallet.getActivity", params: {} }, PRIVILEGED_SENDER),
    );

    expect(activity.entries[0]?.amountBaseUnits).toBe(exact.toString());
    expect(BigInt(activity.entries[0]!.amountBaseUnits)).toBe(exact);
  });

  it("marks the direction and signs the amount label", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.transfersTo = [
      {
        uniqueId: "in",
        hash: `0x${"22".repeat(32)}`,
        blockNum: "0x64",
        from: OTHER,
        to: TEST_ADDRESS,
        asset: "ETH",
        category: "external",
        rawContract: { value: "0x0de0b6b3a7640000", address: null, decimal: "0x12" },
      },
    ];
    harness.chain.transfersFrom = [
      {
        uniqueId: "out",
        hash: `0x${"33".repeat(32)}`,
        blockNum: "0x63",
        from: TEST_ADDRESS,
        to: OTHER,
        asset: "ETH",
        category: "external",
        rawContract: { value: "0x016345785d8a0000", address: null, decimal: "0x12" },
      },
    ];

    const activity = expectResult<ActivityResult>(
      await harness.route({ method: "wallet.getActivity", params: {} }, PRIVILEGED_SENDER),
    );

    const received = activity.entries.find((item) => item.id === "in");
    const sent = activity.entries.find((item) => item.id === "out");
    expect(received?.amountLabel.startsWith("+")).toBe(true);
    expect(sent?.amountLabel.startsWith("-")).toBe(true);
  });

  /**
   * An empty array cannot distinguish "no transactions" from "this endpoint has
   * no index". Telling a user with a busy account that they have never
   * transacted is the worse of the two errors.
   */
  it("reports an index outage as a status, not as an empty history", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.transfersError = new Error("indexer down");

    const activity = expectResult<ActivityResult>(
      await harness.route({ method: "wallet.getActivity", params: {} }, PRIVILEGED_SENDER),
    );
    expect(activity.status).toBe("unavailable");
  });

  /**
   * The other half of the same rule: ONE direction failing is not an outage.
   * A user checking whether a payment arrived is served by the received half
   * alone, so it degrades rather than reporting failure.
   */
  it("degrades to half a history when only one direction fails", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.transfersTo = [
      {
        uniqueId: "in",
        hash: `0x${"22".repeat(32)}`,
        blockNum: "0x64",
        from: OTHER,
        to: TEST_ADDRESS,
        asset: "ETH",
        category: "external",
        rawContract: { value: "0x0de0b6b3a7640000", address: null, decimal: "0x12" },
      },
    ];
    // The fake client throws only for the `fromAddress` query.
    const original = harness.chain.transfersFrom;
    Object.defineProperty(harness.chain, "transfersFrom", {
      get() {
        throw new Error("one direction is down");
      },
      configurable: true,
    });

    const activity = expectResult<ActivityResult>(
      await harness.route({ method: "wallet.getActivity", params: {} }, PRIVILEGED_SENDER),
    );
    expect(activity.status).toBe("ok");
    expect(activity.entries).toHaveLength(1);

    Object.defineProperty(harness.chain, "transfersFrom", {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it("reports an empty history as ok, not as a failure", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const activity = expectResult<ActivityResult>(
      await harness.route({ method: "wallet.getActivity", params: {} }, PRIVILEGED_SENDER),
    );
    expect(activity.status).toBe("ok");
    expect(activity.entries).toEqual([]);
  });

  it("refuses to read an address this wallet does not own", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      { method: "wallet.getActivity", params: { address: OTHER } },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });

  it("refuses while locked", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.context.walletService.lock();

    const response = await harness.route(
      { method: "wallet.getActivity", params: {} },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });
});
