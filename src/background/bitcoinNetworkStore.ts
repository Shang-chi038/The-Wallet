import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";
import {
  isValidBitcoinNetworkName,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";

export const BITCOIN_NETWORK_STORAGE_KEY = "wallet.bitcoinNetwork.v1";

export interface BitcoinNetworkStoreOptions {
  area: KeyValueStorageArea;
  /**
   * The build's configured network, used until the user chooses and whenever
   * what was stored cannot be trusted.
   */
  fallback: BitcoinNetworkName;
}

/**
 * The Bitcoin network the user picked, across worker restarts.
 *
 * ===========================================================================
 * WHY THIS IS PERSISTED AND THE EVM CHAIN'S SIBLING IS NOT AN ACCIDENT
 * ===========================================================================
 * `BitcoinService` held the active network in a field, which is correct for as
 * long as the worker lives and worthless afterwards -- and under MV3 the
 * worker is collected constantly, on purpose (see "SW termination = wallet
 * locked"). A selector without this store would therefore be a control that
 * appears to work and silently reverts, and what it reverts BETWEEN is
 * mainnet and a test network: the user sets mainnet, reads their real balance,
 * closes the popup, and the next open shows signet's zero under the same
 * "Bitcoin" heading. Persisting the choice is what makes the selector a
 * setting rather than a suggestion.
 *
 * ===========================================================================
 * AN UNRECOGNISED STORED VALUE IS DISCARDED, NOT CARRIED
 * ===========================================================================
 * Same rule `LockSettingsStore` applies to `unlockPersistence`: what comes
 * back off disk is input, not state. A build that drops a network -- or a
 * value edited by hand -- must not put the wallet on a network this build
 * cannot describe, because `findBitcoinNetwork` throws on one and the symptom
 * is every Bitcoin read failing with no way to get back. Falling back to the
 * configured network fails toward a network that certainly works.
 */
export class BitcoinNetworkStore {
  private selected: BitcoinNetworkName | undefined;
  private loaded = false;
  private readonly area: KeyValueStorageArea;
  private readonly fallback: BitcoinNetworkName;

  constructor({ area, fallback }: BitcoinNetworkStoreOptions) {
    this.area = area;
    this.fallback = fallback;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(BITCOIN_NETWORK_STORAGE_KEY);
    this.selected = isValidBitcoinNetworkName(stored) ? stored : undefined;
    this.loaded = true;
  }

  /**
   * Synchronous, and safe only behind the worker's `ready` gate -- the same
   * contract `permissionStore.getState()` has. Before the load resolves this
   * answers the configured default, which is the honest answer to "what
   * network is this wallet on" for a wallet that has not read its setting yet.
   */
  get(): BitcoinNetworkName {
    return this.selected ?? this.fallback;
  }

  async select(network: BitcoinNetworkName): Promise<void> {
    if (!isValidBitcoinNetworkName(network)) {
      throw new Error(`Unsupported Bitcoin network: "${String(network)}".`);
    }
    await this.load();
    this.selected = network;
    await this.area.set(BITCOIN_NETWORK_STORAGE_KEY, network);
  }

  async clear(): Promise<void> {
    this.selected = undefined;
    this.loaded = true;
    await this.area.remove(BITCOIN_NETWORK_STORAGE_KEY);
  }
}
