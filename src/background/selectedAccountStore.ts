import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";

/**
 * Which account the UI is currently showing.
 *
 * Persisted rather than held in memory, because the alternative resets the
 * user's choice every time the service worker naps. A user who switched to
 * their second account and came back to find the first one selected would
 * reasonably assume the wallet had lost it -- or, worse, send from the wrong
 * account without noticing.
 *
 * This is a PREFERENCE, not a permission. It never widens what a dApp can see:
 * a site is shown the accounts its grant names, whatever happens to be selected
 * here. And it is not secret -- it is one of the user's own addresses, which is
 * public by nature -- so chrome.storage.local is the right home.
 */

export const SELECTED_ACCOUNT_STORAGE_KEY = "wallet.selectedAccount.v1";

export interface SelectedAccountStoreOptions {
  area: KeyValueStorageArea;
}

export class SelectedAccountStore {
  private selected: string | undefined;
  private loaded = false;
  private readonly area: KeyValueStorageArea;

  constructor({ area }: SelectedAccountStoreOptions) {
    this.area = area;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(SELECTED_ACCOUNT_STORAGE_KEY);
    this.selected = typeof stored === "string" ? stored : undefined;
    this.loaded = true;
  }

  /**
   * The selected address, validated against the accounts that actually exist.
   *
   * Falls back to the first account rather than returning a stale address. A
   * stored selection can outlive the account it names -- after a wallet reset
   * and restore from a different phrase, or after removing an imported key --
   * and a UI showing an address the keyring does not know produces a balance
   * query for a stranger's account and a send button that cannot sign.
   */
  resolve(existingAccounts: readonly string[]): string | undefined {
    if (existingAccounts.length === 0) return undefined;
    const match = existingAccounts.find(
      (address) => address.toLowerCase() === this.selected?.toLowerCase(),
    );
    return match ?? existingAccounts[0];
  }

  async select(address: string): Promise<void> {
    this.selected = address;
    this.loaded = true;
    await this.area.set(SELECTED_ACCOUNT_STORAGE_KEY, address);
  }

  async clear(): Promise<void> {
    this.selected = undefined;
    this.loaded = true;
    await this.area.remove(SELECTED_ACCOUNT_STORAGE_KEY);
  }
}
