import {
  AUTO_LOCK_ALARM_NAME,
  cancelAutoLock,
  createChromeAlarmScheduler,
  decideAutoLockAction,
  KEEP_ALIVE_ALARM_NAME,
  scheduleAutoLock,
} from "./lockPolicy";
import { LockSettingsStore } from "./lockSettingsStore";
import { WalletService } from "@/core/wallet/walletService";
import { NonceAllocator } from "@/core/transaction/nonceAllocator";
import { OutstandingTransactionStore } from "./outstandingTransactionStore";
import { PendingTransactionLog } from "./pendingTransactionLog";
import { PreparedTransactionStore } from "./preparedTransactionStore";
import { releasePreparedNonce } from "./transactionPreparation";
import { createVaultStorage } from "@/core/vault/vaultStorage";
import { createChromeLocalStorageArea } from "@/platform/storage/chromeStorage";
import { createCoinGeckoPriceReader } from "@/platform/price/coinGeckoPriceReader";
import { createUnavailablePriceReader } from "@/core/price/priceReader";
import { ApprovalService } from "./approvalService";
import { createApprovalWindowPresenter } from "./approvalWindow";
import { createMessageRouter } from "./messageRouter";
import { createProviderEventBroadcaster } from "./providerEvents";
import { NetworkService } from "./networkService";
import { TokenService } from "./tokenService";
import { OriginPermissionStore } from "./originPermissionStore";
import { SelectedAccountStore } from "./selectedAccountStore";
import { registerMessageBridge } from "./chromeMessageBridge";
import type { SenderKind } from "@/core/messaging/protocol";
import { listWalletAddresses, type RouterContext } from "./routerContext";
import { BitcoinService } from "./bitcoinService";
import { BitcoinIndexHintStore } from "./bitcoinIndexHintStore";
import { BitcoinNetworkStore } from "./bitcoinNetworkStore";
import { createEsploraAddressReader } from "@/platform/indexer/esploraAddressReader";
import { resolveBitcoinIndexerOverrides } from "@/platform/indexer/indexerOverrides";
import {
  DEFAULT_BITCOIN_NETWORK,
  isValidBitcoinNetworkName,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";

/**
 * Background service worker -- the wallet engine and the single source of truth.
 *
 * Everything secret happens here and nowhere else. The popup, the approval
 * window, the content script and the injected provider are all clients that
 * request operations over a message channel; none of them ever receives key
 * material.
 *
 * This file is WIRING ONLY. Every decision it might be tempted to make lives in
 * a module that can be tested without a browser -- which is what keeps the
 * security-critical logic inside the hermetic suite instead of behind a manual
 * "load unpacked and click around" check.
 */

const storageArea = createChromeLocalStorageArea();

/**
 * Instantiated at module scope, which IS the security model.
 *
 * When Chrome tears this worker down, every binding here goes with it and the
 * wallet is locked. JavaScript cannot erase a string from the heap, so worker
 * teardown is the only true erasure the platform offers -- see lockPolicy.ts
 * for why we treat MV3's aggressive termination as a feature rather than an
 * obstacle to work around.
 */
const walletService = new WalletService({ storage: createVaultStorage(storageArea) });
const permissionStore = new OriginPermissionStore({ area: storageArea });
const selectedAccountStore = new SelectedAccountStore({ area: storageArea });
const networkService = new NetworkService({
  area: storageArea,
  rpcApiKey: import.meta.env.VITE_ALCHEMY_API_KEY,
  defaultChainId: parseChainId(import.meta.env.VITE_EVM_CHAIN_ID),
});
/**
 * `onChanged` re-arms the countdown the moment the interval changes.
 *
 * Without it a user who shortens the interval to one minute because they are
 * about to walk away still has the previous alarm pending -- so the setting
 * they just chose would not apply to the session that prompted them to choose
 * it, which is the only session they were thinking about.
 */
const lockSettings = new LockSettingsStore({
  area: storageArea,
  onChanged: (settings) => {
    if (walletService.isUnlocked()) scheduleAutoLock(alarmScheduler, settings);
  },
});
const nonceAllocator = new NonceAllocator();
const pendingTransactions = new PendingTransactionLog();
const outstandingTransactions = new OutstandingTransactionStore({ area: storageArea });

/**
 * Reviewed-but-unconfirmed sends. `onRelease` is what returns their nonce, and
 * it must run on every path out -- cancel, expiry, lock, reset -- or the account
 * is left with a gap nothing will ever fill.
 */
const preparedTransactions = new PreparedTransactionStore({
  onRelease: (prepared) => releasePreparedNonce(routerContext, prepared),
});

const approvalService = new ApprovalService({
  presenter: createApprovalWindowPresenter({
    // A closed window is an unanswered request. Settling it as a rejection here
    // is what keeps the "every request settles" promise from depending on the
    // user clicking one of our buttons.
    onDismissed: () => approvalService.rejectAll("window_closed"),
  }),
  onQueueChanged: handleApprovalQueueChanged,
});

const providerEvents = createProviderEventBroadcaster({
  permissionStore,
  listWalletAccounts: () => listWalletAddresses(routerContext),
});

/**
 * Prices are optional infrastructure. With no API URL configured the wallet
 * still shows every balance -- it just shows no fiat, and says so. A missing
 * price feed must never be able to stop someone reading their own holdings.
 */
const priceReader = import.meta.env.VITE_COINGECKO_API_URL
  ? createCoinGeckoPriceReader({
      apiUrl: import.meta.env.VITE_COINGECKO_API_URL,
      apiKey: import.meta.env.VITE_COINGECKO_API_KEY,
    })
  : createUnavailablePriceReader();

const tokenService = new TokenService({ area: storageArea });

/**
 * ===========================================================================
 * BITCOIN IS OFF UNLESS AN INDEXER IS CONFIGURED
 * ===========================================================================
 * Ground rule 3 says any feature can be disabled without affecting the rest,
 * and the switch is the ABSENCE of `VITE_BITCOIN_INDEXER_URL` rather than a
 * boolean someone can half-set. With no indexer there is no service, so the
 * `bitcoin` facet is absent from `wallet.getStatus`, the four privileged
 * methods answer `unsupportedMethod`, and no Bitcoin UI can render -- one fact,
 * checked in one place, instead of a flag each layer has to remember.
 *
 * This also has to be a real off switch, not a tidy-looking one: reading a
 * Bitcoin balance is a gap scan against a third party that learns the user's
 * addresses and IP. Someone who does not want that must be able to have it not
 * happen, and "delete the config value" is the version of that promise which
 * cannot be undone by a bug somewhere else.
 *
 * The variable names ONE host and Esplora hosts are per-network
 * (`mempool.space/api` vs `mempool.space/signet/api`), so it overrides the
 * network it was configured FOR and nothing else. Pointing signet requests at a
 * mainnet indexer would not fail loudly -- every derived address would come
 * back unused and the wallet would report a confident zero.
 *
 * Every OTHER network is configured through `VITE_BITCOIN_INDEXER_URL_<NAME>`,
 * added because the picker made those networks reachable and this variable
 * could not follow. See `indexerOverrides.ts`. This one remains the switch: with
 * it unset, Bitcoin is off however many of the others are set.
 */
const bitcoinIndexerUrl = import.meta.env.VITE_BITCOIN_INDEXER_URL;
const configuredBitcoinNetwork = import.meta.env.VITE_BITCOIN_NETWORK;
/**
 * An unset network is the documented default. A SET but unrecognised one turns
 * the feature off instead of falling back: silently substituting signet for a
 * mistyped "mainet" would show testnet coins to someone who believes they are
 * looking at their real balance. Failing closed costs a feature; guessing costs
 * the user their understanding of which network they are on.
 */
const bitcoinNetwork: BitcoinNetworkName | undefined =
  configuredBitcoinNetwork === undefined || configuredBitcoinNetwork === ""
    ? DEFAULT_BITCOIN_NETWORK
    : isValidBitcoinNetworkName(configuredBitcoinNetwork)
      ? configuredBitcoinNetwork
      : undefined;

const bitcoinIndexHintStore =
  bitcoinIndexerUrl && bitcoinNetwork
    ? new BitcoinIndexHintStore({ area: storageArea })
    : undefined;

/**
 * `VITE_BITCOIN_NETWORK` is the network this build STARTS on, not the one it is
 * locked to. The user picks from `wallet.getStatus().bitcoin.availableNetworks`
 * and the choice persists here; the configured value is what a wallet that has
 * never chosen sees, and what an unreadable stored value falls back to.
 *
 * Each network reaches its own host, resolved below. A network with no override
 * uses its built-in one, which is correct but not always reachable -- and the
 * built-in mainnet host is a public server this machine may not be able to talk
 * to at all. That is what the per-network overrides exist to fix.
 */
const bitcoinNetworkStore =
  bitcoinIndexerUrl && bitcoinNetwork
    ? new BitcoinNetworkStore({ area: storageArea, fallback: bitcoinNetwork })
    : undefined;

/**
 * Written out one member access at a time because Vite substitutes literal
 * `import.meta.env.NAME` reads and nothing else -- a computed lookup would come
 * back undefined in the built extension and silently disable every override.
 */
const bitcoinIndexerOverrides = bitcoinNetwork
  ? resolveBitcoinIndexerOverrides({
      startingNetwork: bitcoinNetwork,
      defaultIndexerUrl: bitcoinIndexerUrl,
      perNetworkIndexerUrls: {
        mainnet: import.meta.env.VITE_BITCOIN_INDEXER_URL_MAINNET,
        signet: import.meta.env.VITE_BITCOIN_INDEXER_URL_SIGNET,
        testnet4: import.meta.env.VITE_BITCOIN_INDEXER_URL_TESTNET4,
      },
    })
  : undefined;

/**
 * A rejected override leaves its network on the built-in host, which is
 * indistinguishable from never having configured one. Said out loud in
 * development, where the person who typed the value is standing.
 */
if (import.meta.env.DEV && bitcoinIndexerOverrides) {
  for (const { network, host, reason } of bitcoinIndexerOverrides.rejected) {
    console.warn(
      `[wallet] Ignoring the ${network} indexer override (${host}): ${reason}.`,
    );
  }
}

const bitcoinService =
  bitcoinIndexerUrl && bitcoinNetwork && bitcoinIndexHintStore && bitcoinNetworkStore
    ? new BitcoinService({
        reader: createEsploraAddressReader({
          customIndexerUrls: bitcoinIndexerOverrides?.overrides ?? {},
        }),
        priceReader,
        hintStore: bitcoinIndexHintStore,
        networkStore: bitcoinNetworkStore,
        getKeyring: () => walletService.getKeyring(),
      })
    : undefined;

const routerContext: RouterContext = {
  walletService,
  permissionStore,
  selectedAccountStore,
  approvalService,
  networkService,
  lockSettings,
  tokenService,
  nonceAllocator,
  pendingTransactions,
  outstandingTransactions,
  preparedTransactions,
  extensionOrigin: chrome.runtime.getURL(""),
  priceReader,
  providerEvents,
  // Conditional spread, not `bitcoinService: undefined`:
  // `exactOptionalPropertyTypes` refuses the assignment, and an absent key is
  // the whole description of the feature being off.
  ...(bitcoinService ? { bitcoinService } : {}),
  now: Date.now,
};

const router = createMessageRouter(routerContext);
const alarmScheduler = createChromeAlarmScheduler();

/**
 * Persisted state is loaded once per worker start, and every request waits on
 * it.
 *
 * The gate is not optional. `permissionStore.getState()` is synchronous by
 * design -- the pure permission helpers take a plain state object -- so a
 * request that arrived before the load resolved would be authorised against an
 * EMPTY grant set. That fails closed rather than open, which is the right
 * direction, but it would silently re-prompt a connected dApp on every worker
 * wake-up, and a user prompted that often stops reading prompts.
 */
const ready = Promise.all([
  permissionStore.load(),
  selectedAccountStore.load(),
  networkService.load(),
  tokenService.load(),
  lockSettings.load(),
  outstandingTransactions.load(),
  ...(bitcoinIndexHintStore ? [bitcoinIndexHintStore.load()] : []),
  // Gated for the same reason the permission store is: `networkStore.get()` is
  // synchronous, so a Bitcoin read that arrived before this resolved would
  // scan the DEFAULT network and report its balance under the network the
  // popup names -- which on a mainnet wallet is a zero where the money is.
  ...(bitcoinNetworkStore ? [bitcoinNetworkStore.load()] : []),
]);

registerMessageBridge({
  router: {
    async route(request, sender) {
      await ready;
      try {
        return await router.route(request, sender);
      } finally {
        refreshAutoLock(sender.kind);
      }
    },
  },
});

/**
 * Pushes the auto-lock deadline out, and ONLY for the user's own UI.
 *
 * ===========================================================================
 * WHY IT IS HERE AND NOT ON THE APPROVAL QUEUE
 * ===========================================================================
 * It used to hang off `onQueueChanged`, which fires when a dApp APPROVAL is
 * queued or settles -- not on unlock, and not on ordinary use. So a wallet
 * unlocked from the popup by someone who never connects a site had no auto-lock
 * alarm scheduled at all, and auto-lock failed open: exactly the failure mode
 * `lockPolicy.ts` refuses `setTimeout` in order to avoid. The router is the one
 * place every interaction passes through, so arming here is what makes the
 * setting mean what it says.
 *
 * ===========================================================================
 * A WEBSITE MUST NOT BE ABLE TO HOLD THE WALLET OPEN
 * ===========================================================================
 * Privileged senders only. Auto-lock measures whether the USER is still here,
 * and a dApp polling `eth_chainId` every few seconds is not the user being
 * present -- it is a page in a background tab. Re-arming on page traffic would
 * let any open site keep an unlocked wallet unlocked indefinitely, which is the
 * whole protection inverted.
 *
 * A locked wallet clears the alarm instead: nothing to lock, and a stale alarm
 * would fire on the next session for a deadline that belonged to the last one.
 */
function refreshAutoLock(senderKind: SenderKind): void {
  switch (decideAutoLockAction({ senderKind, isUnlocked: walletService.isUnlocked() })) {
    case "schedule":
      scheduleAutoLock(alarmScheduler, lockSettings.get());
      return;
    case "cancel":
      void cancelAutoLock(alarmScheduler);
      return;
    case "ignore":
      return;
  }
}

// ---------------------------------------------------------------------------
// Lock lifecycle
// ---------------------------------------------------------------------------

function lockWallet(): void {
  walletService.lock();
  // Anything queued dies with the session. A signature request left pending
  // past an auto-lock would sit there until it timed out, and the user would
  // have no idea it was still waiting.
  approvalService.rejectAll("wallet_locked");
  nonceAllocator.reset();
  pendingTransactions.reset();
  // Releases every held nonce as it goes, so a lock mid-review does not strand
  // the account behind a nonce that will never be used.
  preparedTransactions.reset();
  void providerEvents.broadcastAccountsChanged();
  void updateToolbarBadge(0);
  // Nothing left to lock. A surviving alarm would fire against the NEXT
  // session, cutting it short by a deadline that belonged to this one.
  void cancelAutoLock(alarmScheduler);
}

/**
 * Auto-lock fires here. chrome.alarms rather than setTimeout because a pending
 * timeout is destroyed with the worker, which would silently disable auto-lock
 * entirely -- a fail-open bug in the one place we cannot afford one.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM_NAME) {
    lockWallet();
    return;
  }
  if (alarm.name === KEEP_ALIVE_ALARM_NAME) {
    /**
     * Deliberately does nothing.
     *
     * The alarm firing is the entire point: waking the worker resets Chrome's
     * idle timer, which keeps this process -- and therefore the pending
     * approval queue -- alive while the user is reading a transaction. Without
     * it, a user who takes two minutes over a signature can have the worker
     * collected out from under them, and the dApp's request dies with it.
     *
     * It is cleared the moment the queue empties, in handleApprovalQueueChanged.
     * A keep-alive that outlives its reason would defeat "termination ==
     * locked", which is the strongest guarantee this wallet has.
     */
  }
});

/**
 * Keep-alive and the toolbar badge, per approval-queue change.
 *
 * It also pushes the auto-lock deadline out, because someone reading a
 * transaction is present even though the popup is not the surface they are
 * using. That is a SUPPLEMENT to `refreshAutoLock`, not the main arming path --
 * see the note there for why the main path cannot live here.
 */
function handleApprovalQueueChanged(pendingCount: number): void {
  void updateToolbarBadge(pendingCount);
  if (pendingCount > 0) {
    // One minute is the shortest period chrome.alarms will accept.
    chrome.alarms.create(KEEP_ALIVE_ALARM_NAME, { periodInMinutes: 1 });
  } else {
    void alarmScheduler.clear(KEEP_ALIVE_ALARM_NAME);
  }
  if (walletService.isUnlocked()) {
    scheduleAutoLock(alarmScheduler, lockSettings.get());
  }
}

/**
 * A count on the toolbar icon, so a request that opened behind another window
 * is still discoverable. A wallet whose only notification is a window the user
 * may not have seen is a wallet that looks like it ignored the dApp.
 */
async function updateToolbarBadge(pendingCount: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: pendingCount > 0 ? String(pendingCount) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#EF4343" });
  } catch {
    // The action API is unavailable in some contexts (and during teardown).
    // A missing badge must never break a request that otherwise succeeded.
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

/**
 * A fresh worker start means in-memory secrets are already gone. The lock is
 * asserted explicitly rather than inferred from initialisation order, so the
 * invariant holds even if a bundler reorders module evaluation.
 */
chrome.runtime.onStartup.addListener(() => {
  lockWallet();
});

chrome.runtime.onInstalled.addListener((details) => {
  lockWallet();
  if (details.reason === "install") {
    // Onboarding needs real estate and a URL bar the user can verify. Never
    // collect a recovery phrase in a 380px popup that a stray click dismisses.
    void chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/onboarding/index.html") });
  }
});

function parseChainId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
