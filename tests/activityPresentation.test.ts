import { describe, expect, it } from "vitest";
import type {
  ActivityEntryResult,
  ActivityResult,
  ActivityStatus,
  BitcoinActivityEntryResult,
  BitcoinActivityResult,
} from "@/core/messaging/walletApi";
import {
  mergeActivityRows,
  selectActivityPresentation,
} from "@/core/activity/activityPresentation";

function evmEntry(overrides: Partial<ActivityEntryResult> = {}): ActivityEntryResult {
  return {
    id: "0xabc-0",
    transactionHash: "0xabc",
    direction: "received",
    assetKind: "native",
    status: "confirmed",
    symbol: "ETH",
    amountBaseUnits: "1000000000000000000",
    decimals: 18,
    amountLabel: "+1 ETH",
    headline: "Received ETH",
    timeLabel: "Mar 3",
    timestamp: 1_700_000_000_000,
    counterparty: "0xdead",
    explorerUrl: "https://etherscan.io/tx/0xabc",
    ...overrides,
  };
}

function evmActivity(
  status: ActivityStatus,
  entries: ActivityEntryResult[] = [],
): ActivityResult {
  return {
    address: "0x1111111111111111111111111111111111111111",
    chain: {
      chainId: 11155111,
      name: "Sepolia",
      shortName: "Sepolia",
      isTestnet: true,
      nativeCurrencySymbol: "ETH",
      nativeCurrencyDecimals: 18,
      blockExplorerUrl: "https://sepolia.etherscan.io",
    },
    entries,
    status,
    fetchedAt: 1_700_000_000_000,
  };
}

function btcEntry(
  overrides: Partial<BitcoinActivityEntryResult> = {},
): BitcoinActivityEntryResult {
  return {
    id: "txid-1",
    transactionHash: "txid-1",
    direction: "received",
    status: "confirmed",
    amountSats: "100000000",
    amountLabel: "1 BTC",
    feeSats: "0",
    blockNumber: 800_000,
    timestamp: 1_600_000_000_000,
    counterparty: undefined,
    explorerUrl: "https://mempool.space/tx/txid-1",
    ...overrides,
  };
}

function btcActivity(entries: BitcoinActivityEntryResult[]): BitcoinActivityResult {
  return {
    accountIndex: 0,
    network: {
      network: "signet",
      name: "Bitcoin Signet",
      shortName: "Signet",
      isTestnet: true,
      explorerUrl: "https://mempool.space/signet",
    },
    entries,
    status: "ok",
    fetchedAt: 1_700_000_000_000,
  };
}

describe("an empty activity list is never shown bare", () => {
  // The regression this file exists for: a degraded status with nothing to
  // show must explain itself, NOT claim the user has never transacted.
  for (const status of ["unsupported_endpoint", "unavailable"] as const) {
    it(`explains an empty list when the status is "${status}"`, () => {
      const presentation = selectActivityPresentation({
        activity: evmActivity(status),
        bitcoinActivity: undefined,
      });

      expect(presentation.kind).toBe("degraded");
      if (presentation.kind !== "degraded") throw new Error("unreachable");
      expect(presentation.degraded.status).toBe(status);
      expect(presentation.degraded.chainName).toBe("Sepolia");
    });
  }

  it("says 'no activity' only when the history is known to be complete", () => {
    expect(
      selectActivityPresentation({
        activity: evmActivity("ok"),
        bitcoinActivity: undefined,
      }).kind,
    ).toBe("empty");
  });

  it("still explains a degraded status when Bitcoin supplied the only rows", () => {
    // Half the history is missing. The rows that DID arrive must not be
    // mistaken for the whole picture just because the list is non-empty.
    const presentation = selectActivityPresentation({
      activity: evmActivity("unavailable"),
      bitcoinActivity: btcActivity([btcEntry()]),
    });

    expect(presentation.kind).toBe("rows");
    if (presentation.kind !== "rows") throw new Error("unreachable");
    expect(presentation.rows.length).toBe(1);
    expect(presentation.degraded?.status).toBe("unavailable");
  });

  it("loads only while neither side has answered", () => {
    expect(
      selectActivityPresentation({ activity: undefined, bitcoinActivity: undefined }).kind,
    ).toBe("loading");
    // Bitcoin answered, Ethereum did not: that is not a loading screen.
    expect(
      selectActivityPresentation({
        activity: undefined,
        bitcoinActivity: btcActivity([]),
      }).kind,
    ).toBe("empty");
  });
});

describe("merging two chains into one list", () => {
  it("orders by timestamp across chains, not by chain", () => {
    const rows = mergeActivityRows(
      evmActivity("ok", [evmEntry({ id: "old-eth", timestamp: 1_500_000_000_000 })]),
      btcActivity([btcEntry({ id: "new-btc", timestamp: 1_900_000_000_000 })]),
    );

    // The Bitcoin row is newer, so it leads -- a merge that grouped by chain
    // would put the older Ethereum row on top.
    expect(rows.map((row) => row.id)).toEqual(["btc:new-btc", "old-eth"]);
  });

  it("hoists pending rows from either chain above confirmed ones", () => {
    const rows = mergeActivityRows(
      evmActivity("ok", [evmEntry({ id: "eth-confirmed", timestamp: 1_900_000_000_000 })]),
      btcActivity([
        btcEntry({ id: "btc-pending", status: "pending", timestamp: undefined }),
      ]),
    );

    expect(rows[0]?.id).toBe("btc:btc-pending");
    expect(rows[1]?.id).toBe("eth-confirmed");
  });

  it("namespaces Bitcoin ids so they cannot collide with EVM entry ids", () => {
    const rows = mergeActivityRows(
      evmActivity("ok", [evmEntry({ id: "shared-id" })]),
      btcActivity([btcEntry({ id: "shared-id" })]),
    );

    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("signs Bitcoin amounts by direction", () => {
    const rows = mergeActivityRows(
      undefined,
      btcActivity([
        btcEntry({ id: "in", direction: "received", amountLabel: "1 BTC" }),
        btcEntry({ id: "out", direction: "sent", amountLabel: "2 BTC" }),
        btcEntry({ id: "self", direction: "self", amountLabel: "0.0001 BTC" }),
      ]),
    );

    const labels = new Map(rows.map((row) => [row.id, row.amountLabel]));
    expect(labels.get("btc:in")).toBe("+1 BTC");
    expect(labels.get("btc:out")).toBe("-2 BTC");
    expect(labels.get("btc:self")).toBe("0.0001 BTC");
  });
});
