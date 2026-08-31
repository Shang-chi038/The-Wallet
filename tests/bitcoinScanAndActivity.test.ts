import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { BITCOIN_MAINNET } from "@/core/bitcoin/bitcoinNetwork";
import {
  parseBtcToSatoshis,
  formatSatoshisToBtcString,
  formatBitcoinAmountForDisplay,
} from "@/core/bitcoin/bitcoinAmount";
import {
  scanBitcoinAccountAddresses,
  type BitcoinIndexHint,
} from "@/core/bitcoin/addressScan";
import type {
  AddressIndexReader,
  AddressStats,
  BitcoinTransaction,
} from "@/core/bitcoin/addressIndexReader";
import {
  mergeAndClassifyBitcoinActivity,
  classifyBitcoinTransaction,
} from "@/core/bitcoin/bitcoinActivity";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Bitcoin Amount Math & Formatting", () => {
  it("parses BTC string to exact satoshis", () => {
    expect(parseBtcToSatoshis("1")).toBe(100_000_000n);
    expect(parseBtcToSatoshis("0.00125")).toBe(125_000n);
    expect(parseBtcToSatoshis("0.00000001")).toBe(1n);
    expect(parseBtcToSatoshis("21000000")).toBe(2_100_000_000_000_000n);
  });

  it("formats satoshis to standard BTC string", () => {
    expect(formatSatoshisToBtcString(100_000_000n)).toBe("1.00000000");
    expect(formatSatoshisToBtcString(125_000n)).toBe("0.00125000");
    expect(formatSatoshisToBtcString(1n)).toBe("0.00000001");
  });

  it("formats for human display with trailing zero stripping", () => {
    expect(formatBitcoinAmountForDisplay(100_000_000n)).toBe("1 BTC");
    expect(formatBitcoinAmountForDisplay(125_000n)).toBe("0.00125 BTC");
    expect(formatBitcoinAmountForDisplay(0n)).toBe("0 BTC");
  });
});

describe("Bitcoin Gap Scanner", () => {
  const seed = mnemonicToSeedSync(TEST_MNEMONIC);
  const master = HDKey.fromMasterSeed(seed);
  const accountNode = HDKey.fromExtendedKey(
    master.derive("m/84'/0'/0'").publicExtendedKey,
  );

  function createMockIndexReader(statsMap: Map<string, Partial<AddressStats>>): AddressIndexReader {
    return {
      async readAddressStats({ addresses }) {
        const result = new Map<string, AddressStats>();
        for (const addr of addresses) {
          const custom = statsMap.get(addr) ?? {};
          result.set(addr, {
            address: addr,
            chainFundedSats: custom.chainFundedSats ?? 0n,
            chainSpentSats: custom.chainSpentSats ?? 0n,
            chainTxCount: custom.chainTxCount ?? 0,
            mempoolFundedSats: custom.mempoolFundedSats ?? 0n,
            mempoolSpentSats: custom.mempoolSpentSats ?? 0n,
            mempoolTxCount: custom.mempoolTxCount ?? 0,
          });
        }
        return result;
      },
      async listAddressTransactions() {
        return [];
      },
    };
  }

  it("returns zero balance and index -1 for unused wallet", async () => {
    const reader = createMockIndexReader(new Map());
    const result = await scanBitcoinAccountAddresses({
      accountNode,
      network: BITCOIN_MAINNET,
      reader,
      gapLimit: 20,
    });

    expect(result.confirmedSats).toBe(0n);
    expect(result.unconfirmedSats).toBe(0n);
    expect(result.totalSats).toBe(0n);
    expect(result.highestUsedReceiveIndex).toBe(-1);
    expect(result.highestUsedChangeIndex).toBe(-1);
    expect(result.nextReceiveAddress).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(result.scannedAddresses.length).toBe(40); // 20 receive + 20 change
  });

  it("finds used address at index 5 and computes exact confirmed balance", async () => {
    const receive0Addr = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const customStats = new Map<string, Partial<AddressStats>>([
      [
        receive0Addr,
        {
          chainFundedSats: 50_000_000n,
          chainSpentSats: 10_000_000n,
          chainTxCount: 2,
        },
      ],
    ]);

    const reader = createMockIndexReader(customStats);
    const result = await scanBitcoinAccountAddresses({
      accountNode,
      network: BITCOIN_MAINNET,
      reader,
      gapLimit: 20,
    });

    expect(result.confirmedSats).toBe(40_000_000n);
    expect(result.highestUsedReceiveIndex).toBe(0);
    expect(result.nextReceiveAddress).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(result.usedAddresses).toEqual([receive0Addr]);
  });

  it("fails the whole scan when any address query fails", async () => {
    const failingReader: AddressIndexReader = {
      async readAddressStats() {
        throw new Error("Indexer network timeout");
      },
      async listAddressTransactions() {
        return [];
      },
    };

    await expect(
      scanBitcoinAccountAddresses({
        accountNode,
        network: BITCOIN_MAINNET,
        reader: failingReader,
      }),
    ).rejects.toThrow("Indexer network timeout");
  });
});

describe("Bitcoin Activity Classification", () => {
  const ownedAddress1 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
  const ownedAddress2 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
  const externalAddress = "bc1qexternaladdress0000000000000000000000";
  const ownedSet = new Set([ownedAddress1, ownedAddress2]);

  it("classifies incoming transfer as received", () => {
    const tx: BitcoinTransaction = {
      txid: "tx-received-1",
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: "prev-tx",
          vout: 0,
          prevout: { scriptpubkey_address: externalAddress, value: 100_000_000n },
          sequence: 0xffffffff,
        },
      ],
      vout: [
        { scriptpubkey_address: ownedAddress1, value: 99_998_000n },
      ],
      size: 140,
      weight: 560,
      fee: 2_000n,
      status: { confirmed: true, block_height: 800000, block_time: 1700000000 },
    };

    const entry = classifyBitcoinTransaction({
      transaction: tx,
      ownedAddresses: ownedSet,
      explorerBaseUrl: "https://mempool.space",
    });

    expect(entry.direction).toBe("received");
    expect(entry.amountSats).toBe(99_998_000n);
    expect(entry.status).toBe("confirmed");
    expect(entry.counterparty).toBe(externalAddress);
  });

  it("classifies outgoing transfer with change as sent", () => {
    const tx: BitcoinTransaction = {
      txid: "tx-sent-1",
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: "prev-tx",
          vout: 0,
          prevout: { scriptpubkey_address: ownedAddress1, value: 100_000_000n },
          sequence: 0xffffffff,
        },
      ],
      vout: [
        { scriptpubkey_address: externalAddress, value: 40_000_000n }, // Payment
        { scriptpubkey_address: ownedAddress2, value: 59_998_000n }, // Change back
      ],
      size: 220,
      weight: 880,
      fee: 2_000n,
      status: { confirmed: false },
    };

    const entry = classifyBitcoinTransaction({
      transaction: tx,
      ownedAddresses: ownedSet,
      explorerBaseUrl: "https://mempool.space",
    });

    expect(entry.direction).toBe("sent");
    expect(entry.amountSats).toBe(40_000_000n);
    expect(entry.status).toBe("pending");
    expect(entry.counterparty).toBe(externalAddress);
  });

  it("classifies transfer between own addresses as self", () => {
    const tx: BitcoinTransaction = {
      txid: "tx-self-1",
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: "prev-tx",
          vout: 0,
          prevout: { scriptpubkey_address: ownedAddress1, value: 50_000_000n },
          sequence: 0xffffffff,
        },
      ],
      vout: [
        { scriptpubkey_address: ownedAddress2, value: 49_998_000n },
      ],
      size: 140,
      weight: 560,
      fee: 2_000n,
      status: { confirmed: true, block_height: 800005, block_time: 1700001000 },
    };

    const entry = classifyBitcoinTransaction({
      transaction: tx,
      ownedAddresses: ownedSet,
      explorerBaseUrl: "https://mempool.space",
    });

    expect(entry.direction).toBe("self");
    expect(entry.amountSats).toBe(2_000n); // Net fee
  });

  it("deduplicates multi-address transactions and sorts pending first", () => {
    const pendingTx: BitcoinTransaction = {
      txid: "tx-pending",
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: "prev-tx",
          vout: 0,
          prevout: { scriptpubkey_address: ownedAddress1, value: 10_000_000n },
          sequence: 0xffffffff,
        },
      ],
      vout: [{ scriptpubkey_address: externalAddress, value: 9_998_000n }],
      size: 140,
      weight: 560,
      fee: 2_000n,
      status: { confirmed: false },
    };

    const confirmedTx: BitcoinTransaction = {
      txid: "tx-confirmed",
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: "prev-tx",
          vout: 0,
          prevout: { scriptpubkey_address: externalAddress, value: 5_000_000n },
          sequence: 0xffffffff,
        },
      ],
      vout: [{ scriptpubkey_address: ownedAddress1, value: 4_998_000n }],
      size: 140,
      weight: 560,
      fee: 2_000n,
      status: { confirmed: true, block_height: 700000, block_time: 1600000000 },
    };

    // Passed twice to test deduplication
    const activities = mergeAndClassifyBitcoinActivity({
      transactions: [confirmedTx, pendingTx, confirmedTx],
      ownedAddresses: ownedSet,
      explorerBaseUrl: "https://mempool.space",
    });

    expect(activities.length).toBe(2);
    expect(activities[0]?.id).toBe("tx-pending");
    expect(activities[1]?.id).toBe("tx-confirmed");
  });
});
