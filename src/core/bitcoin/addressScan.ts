import type { HDKey } from "@scure/bip32";
import type { BitcoinNetworkDefinition, BitcoinNetworkName } from "./bitcoinNetwork";
import {
  deriveBitcoinAddressSummary,
  type BitcoinAddressSummary,
} from "./bitcoinAccount";
import {
  computeConfirmedBalance,
  computeUnconfirmedBalance,
  isAddressUsed,
  type AddressIndexReader,
  type AddressStats,
} from "./addressIndexReader";

/**
 * Standard BIP-44 / BIP-84 gap limit: 20 consecutive unused addresses.
 */
export const DEFAULT_BITCOIN_GAP_LIMIT = 20;

export interface BitcoinIndexHint {
  readonly highestUsedReceiveIndex?: number | undefined;
  readonly highestUsedChangeIndex?: number | undefined;
}

export interface ScanBitcoinAccountAddressesParams {
  readonly accountNode: HDKey;
  readonly network: BitcoinNetworkDefinition;
  readonly reader: AddressIndexReader;
  readonly accountIndex?: number | undefined;
  readonly indexHint?: BitcoinIndexHint | undefined;
  readonly gapLimit?: number | undefined;
}

export interface BitcoinAccountScanResult {
  readonly network: BitcoinNetworkName;
  readonly accountIndex: number;
  readonly highestUsedReceiveIndex: number;
  readonly highestUsedChangeIndex: number;
  readonly nextReceiveAddress: string;
  readonly nextChangeAddress: string;
  readonly usedAddresses: readonly string[];
  readonly scannedAddresses: readonly BitcoinAddressSummary[];
  readonly statsByAddress: Map<string, AddressStats>;
  readonly confirmedSats: bigint;
  readonly unconfirmedSats: bigint;
  readonly totalSats: bigint;
  readonly scannedAt: number;
}

/**
 * Executes a pure BIP-44 gap scan over receive (0) and change (1) branches.
 *
 * Ground rules:
 * - The scan window starts at hint + gapLimit and expands if used addresses are found within the gap window.
 * - Any failed address query causes the whole scan to throw (never computes partial balances).
 * - All balance additions are bigint satoshis.
 */
export async function scanBitcoinAccountAddresses({
  accountNode,
  network,
  reader,
  accountIndex = 0,
  indexHint,
  gapLimit = DEFAULT_BITCOIN_GAP_LIMIT,
}: ScanBitcoinAccountAddressesParams): Promise<BitcoinAccountScanResult> {
  const statsByAddress = new Map<string, AddressStats>();
  const addressSummariesByIndex = new Map<string, BitcoinAddressSummary>();

  async function scanBranch(
    branch: 0 | 1,
    hintIndex: number | undefined,
  ): Promise<{ highestUsedIndex: number; summaries: BitcoinAddressSummary[] }> {
    let highestUsedIndex = hintIndex !== undefined && hintIndex >= 0 ? hintIndex : -1;
    let windowSize = Math.max(gapLimit, highestUsedIndex + 1 + gapLimit);
    let scannedUpToIndex = 0;
    const branchSummaries: BitcoinAddressSummary[] = [];

    while (scannedUpToIndex < windowSize) {
      const batchSummaries: BitcoinAddressSummary[] = [];
      const batchAddresses: string[] = [];

      for (let i = scannedUpToIndex; i < windowSize; i++) {
        const summary = deriveBitcoinAddressSummary({
          accountNode,
          branch,
          addressIndex: i,
          network,
          accountIndex,
        });
        batchSummaries.push(summary);
        batchAddresses.push(summary.address);
        branchSummaries.push(summary);
        addressSummariesByIndex.set(`${branch}:${i}`, summary);
      }

      // Read stats for newly derived addresses
      const batchStats = await reader.readAddressStats({
        addresses: batchAddresses,
        network: network.network,
      });

      for (const summary of batchSummaries) {
        const stats = batchStats.get(summary.address);
        if (!stats) {
          throw new Error(
            `Address index reader failed to return stats for ${summary.address}.`,
          );
        }
        statsByAddress.set(summary.address, stats);
        if (isAddressUsed(stats)) {
          if (summary.addressIndex > highestUsedIndex) {
            highestUsedIndex = summary.addressIndex;
          }
        }
      }

      scannedUpToIndex = windowSize;

      // If any used address is within gapLimit of the window boundary, expand window
      if (highestUsedIndex >= windowSize - gapLimit) {
        windowSize = highestUsedIndex + 1 + gapLimit;
      }
    }

    return { highestUsedIndex, summaries: branchSummaries };
  }

  const receiveScan = await scanBranch(0, indexHint?.highestUsedReceiveIndex);
  const changeScan = await scanBranch(1, indexHint?.highestUsedChangeIndex);

  const scannedAddresses = [...receiveScan.summaries, ...changeScan.summaries];
  const usedAddresses: string[] = [];

  let confirmedSats = 0n;
  let unconfirmedSats = 0n;

  for (const summary of scannedAddresses) {
    const stats = statsByAddress.get(summary.address);
    if (stats) {
      if (isAddressUsed(stats)) {
        usedAddresses.push(summary.address);
      }
      confirmedSats += computeConfirmedBalance(stats);
      unconfirmedSats += computeUnconfirmedBalance(stats);
    }
  }

  const nextReceiveSummary = deriveBitcoinAddressSummary({
    accountNode,
    branch: 0,
    addressIndex: receiveScan.highestUsedIndex + 1,
    network,
    accountIndex,
  });

  const nextChangeSummary = deriveBitcoinAddressSummary({
    accountNode,
    branch: 1,
    addressIndex: changeScan.highestUsedIndex + 1,
    network,
    accountIndex,
  });

  return {
    network: network.network,
    accountIndex,
    highestUsedReceiveIndex: receiveScan.highestUsedIndex,
    highestUsedChangeIndex: changeScan.highestUsedIndex,
    nextReceiveAddress: nextReceiveSummary.address,
    nextChangeAddress: nextChangeSummary.address,
    usedAddresses,
    scannedAddresses,
    statsByAddress,
    confirmedSats,
    unconfirmedSats,
    totalSats: confirmedSats + unconfirmedSats,
    scannedAt: Date.now(),
  };
}
