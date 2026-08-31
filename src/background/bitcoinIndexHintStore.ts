import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";
import type { BitcoinIndexHint } from "@/core/bitcoin/addressScan";
import type { BitcoinNetworkName } from "@/core/bitcoin/bitcoinNetwork";

export const BITCOIN_INDEX_HINT_STORAGE_KEY = "wallet.bitcoinIndexHint.v1";

export interface BitcoinIndexHintStoreOptions {
  area: KeyValueStorageArea;
}

export class BitcoinIndexHintStore {
  private hints: Map<string, BitcoinIndexHint> = new Map();
  private loaded = false;
  private readonly area: KeyValueStorageArea;

  constructor({ area }: BitcoinIndexHintStoreOptions) {
    this.area = area;
  }

  private makeKey(network: BitcoinNetworkName, accountIndex: number): string {
    return `${network}:${accountIndex}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(BITCOIN_INDEX_HINT_STORAGE_KEY);
    if (typeof stored === "string") {
      try {
        const parsed = JSON.parse(stored) as Record<string, BitcoinIndexHint>;
        if (parsed && typeof parsed === "object") {
          this.hints = new Map(Object.entries(parsed));
        }
      } catch {
        this.hints = new Map();
      }
    }
    this.loaded = true;
  }

  async getHint(
    network: BitcoinNetworkName,
    accountIndex: number,
  ): Promise<BitcoinIndexHint | undefined> {
    await this.load();
    return this.hints.get(this.makeKey(network, accountIndex));
  }

  async updateHint(
    network: BitcoinNetworkName,
    accountIndex: number,
    hint: BitcoinIndexHint,
  ): Promise<void> {
    await this.load();
    const key = this.makeKey(network, accountIndex);
    const existing = this.hints.get(key) ?? {};

    const merged: BitcoinIndexHint = {
      highestUsedReceiveIndex: Math.max(
        existing.highestUsedReceiveIndex ?? -1,
        hint.highestUsedReceiveIndex ?? -1,
      ),
      highestUsedChangeIndex: Math.max(
        existing.highestUsedChangeIndex ?? -1,
        hint.highestUsedChangeIndex ?? -1,
      ),
    };

    this.hints.set(key, merged);
    const serialized = JSON.stringify(Object.fromEntries(this.hints.entries()));
    await this.area.set(BITCOIN_INDEX_HINT_STORAGE_KEY, serialized);
  }

  async clear(): Promise<void> {
    this.hints.clear();
    this.loaded = true;
    await this.area.remove(BITCOIN_INDEX_HINT_STORAGE_KEY);
  }
}
