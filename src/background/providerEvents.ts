import { listAccountsForOrigin } from "@/core/messaging/originPermissions";
import { normalizeOrigin, BRIDGE_NAMESPACE } from "@/core/messaging/protocol";
import type { OriginPermissionStore } from "./originPermissionStore";

/**
 * EIP-1193 event delivery to connected pages.
 *
 * ===========================================================================
 * WHY EVENTS ARE NOT OPTIONAL
 * ===========================================================================
 * A dApp that never receives `accountsChanged` keeps operating on the account
 * the user switched away from: it displays the wrong balance, and it builds
 * transactions `from` an address the wallet will refuse to sign for. A dApp
 * that never receives `chainChanged` will happily prepare a mainnet transaction
 * while the wallet is on Sepolia. Both look like wallet bugs to the user.
 *
 * ===========================================================================
 * ACCOUNTS ARE PER-ORIGIN, SO THE EVENT IS TOO
 * ===========================================================================
 * There is no such thing as "the account list". Each origin sees the subset the
 * user granted it, so a single broadcast payload would leak every account to
 * every connected site -- undoing the entire point of per-origin grants in the
 * one code path most likely to be written carelessly.
 *
 * So the payload is computed PER TAB from that tab's own origin, and a tab with
 * no grant receives nothing at all. Not an empty array: nothing. An unconnected
 * site should not learn that the user's account list changed, because that is a
 * signal about activity in another tab.
 *
 * `chainChanged` is different and IS broadcast to every connected origin: the
 * active chain is global to the wallet and is not a per-origin secret.
 *
 * ===========================================================================
 * WHY chrome.tabs AND NOT A LONG-LIVED PORT
 * ===========================================================================
 * A persistent port from every tab would keep the service worker alive
 * indefinitely, and "worker termination == wallet locked" is our only real
 * erasure primitive (see lockPolicy.ts). One-shot `chrome.tabs.sendMessage`
 * keeps the worker free to die.
 *
 * This needs no "tabs" permission: that permission gates reading sensitive tab
 * properties, and `<all_urls>` host access -- which we already hold in order to
 * inject the provider at all -- covers `tab.url` for the origins we can message.
 */

export const PROVIDER_EVENT_NAMESPACE = `${BRIDGE_NAMESPACE}:event`;

export type ProviderEventName = "accountsChanged" | "chainChanged" | "disconnect";

export interface ProviderEventMessage {
  namespace: typeof PROVIDER_EVENT_NAMESPACE;
  event: ProviderEventName;
  params: unknown;
}

export interface ProviderEventBroadcasterOptions {
  permissionStore: OriginPermissionStore;
  /** Live account list. Empty while locked, which is the correct payload. */
  listWalletAccounts: () => readonly string[];
  /** Injectable so the broadcaster is testable without chrome.*. */
  listTabs?: () => Promise<{ id: number | undefined; url: string | undefined }[]>;
  sendToTab?: (tabId: number, message: ProviderEventMessage) => Promise<void>;
}

export interface ProviderEventBroadcaster {
  broadcastAccountsChanged(): Promise<void>;
  broadcastChainChanged(chainIdHex: string): Promise<void>;
}

export function createProviderEventBroadcaster({
  permissionStore,
  listWalletAccounts,
  listTabs = defaultListTabs,
  sendToTab = defaultSendToTab,
}: ProviderEventBroadcasterOptions): ProviderEventBroadcaster {
  async function forEachConnectedTab(
    build: (origin: string) => ProviderEventMessage | undefined,
  ): Promise<void> {
    const tabs = await listTabs();
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        const origin = normalizeOrigin(tab.url);
        if (!origin) return;
        const message = build(origin);
        if (!message) return;
        await sendToTab(tab.id, message);
      }),
    );
  }

  return {
    async broadcastAccountsChanged() {
      const accounts = listWalletAccounts();
      const state = permissionStore.getState();
      await forEachConnectedTab((origin) => {
        const permitted = listAccountsForOrigin(state, origin, accounts);
        // A site with no grant gets no event. Silence here is deliberate: see
        // the header.
        if (permitted.length === 0 && listGrantedCount(state, origin) === 0) return undefined;
        return {
          namespace: PROVIDER_EVENT_NAMESPACE,
          event: "accountsChanged",
          // Lowercase, matching what `eth_accounts` returns. dApps compare these
          // to the array they cached with `===`.
          params: permitted.map((address) => address.toLowerCase()),
        };
      });
    },

    async broadcastChainChanged(chainIdHex) {
      const state = permissionStore.getState();
      await forEachConnectedTab((origin) => {
        if (listGrantedCount(state, origin) === 0) return undefined;
        return {
          namespace: PROVIDER_EVENT_NAMESPACE,
          event: "chainChanged",
          params: chainIdHex,
        };
      });
    },
  };
}

function listGrantedCount(
  state: ReturnType<OriginPermissionStore["getState"]>,
  origin: string,
): number {
  return state.grants[origin]?.accounts.length ?? 0;
}

async function defaultListTabs(): Promise<{ id: number | undefined; url: string | undefined }[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({ id: tab.id, url: tab.url }));
}

async function defaultSendToTab(tabId: number, message: ProviderEventMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Expected and ignored: chrome:// pages, the web store, discarded tabs and
    // tabs whose content script has not loaded all reject. A failed event
    // delivery to one tab must never abort delivery to the rest, and must never
    // surface as an error in a user flow that has already succeeded.
  }
}
