import type { HDKey } from "@scure/bip32";
import {
  BUILT_IN_BITCOIN_NETWORKS,
  findBitcoinNetwork,
  type BitcoinNetworkDefinition,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";
import {
  scanBitcoinAccountAddresses,
  type BitcoinAccountScanResult,
} from "@/core/bitcoin/addressScan";
import type { AddressIndexReader } from "@/core/bitcoin/addressIndexReader";
import { formatBitcoinAmountForDisplay } from "@/core/bitcoin/bitcoinAmount";
import { mergeAndClassifyBitcoinActivity } from "@/core/bitcoin/bitcoinActivity";
import { createBitcoinDerivationPath } from "@/core/bitcoin/derivationPath";
import {
  deriveBitcoinAccountPublicNode,
  type Keyring,
} from "@/core/keyring/keyring";
import type { PriceReader } from "@/core/price/priceReader";
import type {
  BitcoinActivityResult,
  BitcoinNetworkSummary,
  BitcoinPortfolioResult,
  BitcoinReceiveAddressResult,
} from "@/core/messaging/walletApi";
import type { BitcoinIndexHintStore } from "./bitcoinIndexHintStore";
import type { BitcoinNetworkStore } from "./bitcoinNetworkStore";

export const BITCOIN_SCAN_TTL_MS = 60_000;

export interface BitcoinServiceOptions {
  readonly reader: AddressIndexReader;
  readonly priceReader: PriceReader;
  readonly hintStore: BitcoinIndexHintStore;
  /**
   * The active network lives here rather than in a field on this service.
   *
   * One source of truth, and a persisted one: a field would be re-defaulted
   * every time MV3 collects the worker, so a user on mainnet would find
   * themselves back on the build's default network without having asked. See
   * the header of bitcoinNetworkStore.ts.
   */
  readonly networkStore: BitcoinNetworkStore;
  readonly getKeyring: () => Keyring;
  readonly now?: () => number;
}

export function toBitcoinNetworkSummary(
  def: BitcoinNetworkDefinition,
): BitcoinNetworkSummary {
  return {
    network: def.network,
    name: def.name,
    shortName: def.shortName,
    isTestnet: def.isTestnet,
    explorerUrl: def.explorerUrl,
  };
}

export class BitcoinService {
  private readonly reader: AddressIndexReader;
  private readonly priceReader: PriceReader;
  private readonly hintStore: BitcoinIndexHintStore;
  private readonly networkStore: BitcoinNetworkStore;
  private readonly getKeyring: () => Keyring;
  private readonly now: () => number;

  private scanCache = new Map<
    string,
    { result: BitcoinAccountScanResult; cachedAt: number }
  >();

  constructor({
    reader,
    priceReader,
    hintStore,
    networkStore,
    getKeyring,
    now = Date.now,
  }: BitcoinServiceOptions) {
    this.reader = reader;
    this.priceReader = priceReader;
    this.hintStore = hintStore;
    this.networkStore = networkStore;
    this.getKeyring = getKeyring;
    this.now = now;
  }

  getActiveNetworkDefinition(): BitcoinNetworkDefinition {
    return findBitcoinNetwork(this.getActiveNetwork());
  }

  getActiveNetwork(): BitcoinNetworkName {
    return this.networkStore.get();
  }

  listNetworks(): readonly BitcoinNetworkDefinition[] {
    return BUILT_IN_BITCOIN_NETWORKS;
  }

  /**
   * Resolved through `findBitcoinNetwork` before it is written, so an
   * unsupported name throws here rather than being stored and thrown on
   * afterwards -- at which point every Bitcoin read fails and the setting that
   * would fix it is the one that broke.
   *
   * The cache is dropped rather than left keyed by network. Entries cannot
   * collide (the key carries the network), so this is not correctness; it is
   * that switching away and back should re-read, since "the balance I saw a
   * minute ago on the other network" is not an answer anyone wants.
   */
  async setActiveNetwork(network: BitcoinNetworkName): Promise<void> {
    const resolved = findBitcoinNetwork(network).network;
    await this.networkStore.select(resolved);
    this.scanCache.clear();
  }

  private makeCacheKey(network: BitcoinNetworkName, accountIndex: number): string {
    return `${network}:${accountIndex}`;
  }

  async scanAccount(
    accountIndex = 0,
    forceRefresh = false,
  ): Promise<BitcoinAccountScanResult> {
    const network = this.getActiveNetwork();
    const networkDef = this.getActiveNetworkDefinition();
    const cacheKey = this.makeCacheKey(network, accountIndex);
    const cached = this.scanCache.get(cacheKey);

    if (!forceRefresh && cached && this.now() - cached.cachedAt < BITCOIN_SCAN_TTL_MS) {
      return cached.result;
    }

    const keyring = this.getKeyring();
    const accountNode = deriveBitcoinAccountPublicNode({
      keyring,
      accountIndex,
      network,
    });

    const indexHint = await this.hintStore.getHint(network, accountIndex);
    const result = await scanBitcoinAccountAddresses({
      accountNode,
      network: networkDef,
      reader: this.reader,
      accountIndex,
      indexHint,
    });

    await this.hintStore.updateHint(network, accountIndex, {
      highestUsedReceiveIndex: result.highestUsedReceiveIndex,
      highestUsedChangeIndex: result.highestUsedChangeIndex,
    });

    this.scanCache.set(cacheKey, { result, cachedAt: this.now() });
    return result;
  }

  async getPortfolio(accountIndex = 0): Promise<BitcoinPortfolioResult> {
    const networkDef = this.getActiveNetworkDefinition();
    const scan = await this.scanAccount(accountIndex);

    const prices = await this.priceReader.readPrices(["BTC"]);
    const btcQuote = prices.get("BTC");

    let fiatValue: number | undefined;
    let fiatStatus: "priced" | "unavailable" = "unavailable";

    if (btcQuote && btcQuote.price > 0) {
      const btcDouble = Number(scan.totalSats) / 100_000_000;
      fiatValue = btcDouble * btcQuote.price;
      fiatStatus = "priced";
    }

    return {
      accountIndex,
      network: toBitcoinNetworkSummary(networkDef),
      confirmedSats: scan.confirmedSats.toString(),
      unconfirmedSats: scan.unconfirmedSats.toString(),
      totalSats: scan.totalSats.toString(),
      balanceLabel: formatBitcoinAmountForDisplay(scan.totalSats),
      fiatValue,
      fiatStatus,
      usedAddressCount: scan.usedAddresses.length,
      fetchedAt: this.now(),
    };
  }

  async getReceiveAddress(accountIndex = 0): Promise<BitcoinReceiveAddressResult> {
    const networkDef = this.getActiveNetworkDefinition();
    const scan = await this.scanAccount(accountIndex);

    const nextIndex = scan.highestUsedReceiveIndex + 1;
    const derivationPath = createBitcoinDerivationPath({
      coinType: networkDef.coinType,
      accountIndex,
      branch: 0,
      addressIndex: nextIndex,
    });

    return {
      address: scan.nextReceiveAddress,
      addressIndex: nextIndex,
      derivationPath,
      network: toBitcoinNetworkSummary(networkDef),
    };
  }

  async getActivity(accountIndex = 0): Promise<BitcoinActivityResult> {
    const networkDef = this.getActiveNetworkDefinition();
    const scan = await this.scanAccount(accountIndex);

    const queryAddresses =
      scan.usedAddresses.length > 0
        ? scan.usedAddresses
        : [scan.scannedAddresses[0]?.address].filter((a): a is string => Boolean(a));

    const txsBatches = await Promise.all(
      queryAddresses.map((addr) =>
        this.reader.listAddressTransactions({
          address: addr,
          network: networkDef.network,
        }),
      ),
    );

    const allTxs = txsBatches.flat();
    const ownedAddressSet = new Set(scan.scannedAddresses.map((s) => s.address));

    const classified = mergeAndClassifyBitcoinActivity({
      transactions: allTxs,
      ownedAddresses: ownedAddressSet,
      explorerBaseUrl: networkDef.explorerUrl,
    });

    const entries = classified.map((entry) => ({
      id: entry.id,
      transactionHash: entry.transactionHash,
      direction: entry.direction,
      status: entry.status,
      amountSats: entry.amountSats.toString(),
      amountLabel: entry.amountLabel,
      feeSats: entry.feeSats.toString(),
      blockNumber: entry.blockNumber,
      timestamp: entry.timestamp,
      counterparty: entry.counterparty,
      explorerUrl: entry.explorerUrl,
    }));

    return {
      accountIndex,
      network: toBitcoinNetworkSummary(networkDef),
      entries,
      status: "ok",
      fetchedAt: this.now(),
    };
  }
}
