import type { PublicClient } from "viem";
import type { KeyDerivationParams } from "@/core/crypto/keyDerivation";
import {
  createMemoryStorageArea,
  createVaultStorage,
  type KeyValueStorageArea,
} from "@/core/vault/vaultStorage";
import { WalletService } from "@/core/wallet/walletService";
import { NonceAllocator } from "@/core/transaction/nonceAllocator";
import {
  OutstandingTransactionStore,
  OUTSTANDING_TRANSACTIONS_STORAGE_KEY,
} from "@/background/outstandingTransactionStore";
import { PendingTransactionLog } from "@/background/pendingTransactionLog";
import { PreparedTransactionStore } from "@/background/preparedTransactionStore";
import { releasePreparedNonce } from "@/background/transactionPreparation";
import type { PriceQuote, PriceReader } from "@/core/price/priceReader";
import type { SenderClassification } from "@/core/messaging/senderTrust";
import type { WalletErrorResponse, WalletResponse } from "@/core/messaging/protocol";
import { ApprovalService, type ApprovalPresenter } from "@/background/approvalService";
import { NetworkService } from "@/background/networkService";
import { LockSettingsStore } from "@/background/lockSettingsStore";
import { TokenService } from "@/background/tokenService";
import { OriginPermissionStore } from "@/background/originPermissionStore";
import { SelectedAccountStore } from "@/background/selectedAccountStore";
import {
  createProviderEventBroadcaster,
  type ProviderEventMessage,
} from "@/background/providerEvents";
import { createMessageRouter } from "@/background/messageRouter";
import { listWalletAddresses, type RouterContext } from "@/background/routerContext";
import { BitcoinService } from "@/background/bitcoinService";
import { BitcoinIndexHintStore } from "@/background/bitcoinIndexHintStore";
import { BitcoinNetworkStore } from "@/background/bitcoinNetworkStore";
import type {
  AddressIndexReader,
  AddressStats,
  BitcoinTransaction,
} from "@/core/bitcoin/addressIndexReader";

/**
 * A whole wallet engine, in memory, with no chrome.* and no network.
 *
 * This harness is the reason the router's security properties are testable at
 * all. Every dependency that would otherwise reach a browser API or a socket is
 * injected, so a test can ask "what happens when a web page calls
 * wallet.revealMnemonic" and get an answer in milliseconds -- rather than that
 * question being checked by hand, once, in a real browser, and then trusted
 * forever.
 */

export const TEST_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/** The cross-wallet vector: MetaMask, Ledger and Rainbow all derive this. */
export const TEST_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
export const TEST_PASSWORD = "a good long password";
export const TEST_ORIGIN = "https://app.example";
export const OTHER_ORIGIN = "https://evil.example";

/**
 * The cheapest configuration the engine will accept.
 *
 * Not lower: `assertValidParams` enforces a 2^14 floor, and a harness that sits
 * below it tests a config the wallet refuses to ship -- which is exactly the
 * trap CLAUDE.md records about shrinking KDF params to fit a timeout.
 */
const FAST_SCRYPT: KeyDerivationParams = {
  algorithm: "scrypt",
  costFactor: 2 ** 14,
  blockSize: 8,
  parallelism: 1,
};

export const PAGE_SENDER: SenderClassification = { kind: "page", origin: TEST_ORIGIN };
export const OTHER_PAGE_SENDER: SenderClassification = { kind: "page", origin: OTHER_ORIGIN };
export const EXTENSION_ORIGIN = "chrome-extension://test/";
export const PRIVILEGED_SENDER: SenderClassification = {
  kind: "privileged",
  origin: EXTENSION_ORIGIN,
};

/**
 * What a fake ERC-20 contract answers about itself.
 *
 * `decimals` accepts an ARRAY so a test can make the contract change its answer
 * between calls -- the attack the lookup/import split exists to catch. Each
 * read shifts one value off the front and the last one repeats forever.
 */
export interface FakeTokenContract {
  decimals: number | number[] | undefined;
  symbol?: string | undefined;
  name?: string | undefined;
}

export interface FakeChainState {
  chainId: number;
  nativeBalance: bigint;
  tokenBalances: Map<string, bigint>;
  /** ERC-20 metadata by lowercase address. Absent = not a token contract. */
  tokenContracts: Map<string, FakeTokenContract>;
  pendingNonce: number;
  /** Nonce counting mined transactions only. Never above `pendingNonce`. */
  confirmedNonce: number;
  gasEstimate: bigint | Error;
  baseFeePerGas: bigint;
  broadcasts: string[];
  nextTransactionHash: string;
  /** Raw `alchemy_getAssetTransfers` payloads, keyed by query direction. */
  transfersFrom: unknown[];
  transfersTo: unknown[];
  transfersError: Error | undefined;
  /** Name -> address, as a resolver would answer. */
  ensForward: Map<string, string>;
  /** Address -> name, already forward-verified. */
  ensReverse: Map<string, string>;
}

export interface FakeBitcoinState {
  addressStats: Map<string, Partial<AddressStats>>;
  transactions: Map<string, BitcoinTransaction[]>;
}

export interface Harness {
  context: RouterContext;
  /** The backing storage, so a test can build a cold service over it. */
  area: KeyValueStorageArea;
  route(request: unknown, sender?: SenderClassification): Promise<WalletResponse>;
  /** Approvals the fake presenter has been asked to show. */
  presenter: { openCount: number; closeCount: number };
  /** Answers the single pending approval, as the approval window would. */
  answerNextApproval(approved: boolean, accounts?: string[]): Promise<void>;
  /**
   * Waits until a request has actually reached the approval queue.
   *
   * A prompting request suspends through a variable number of awaits before it
   * queues -- `wallet_watchAsset` reads contract metadata and a balance first,
   * `eth_sendTransaction` estimates gas -- so a fixed number of
   * `await Promise.resolve()` calls is a race that passes on one method and
   * fails intermittently on the next. This drains until the queue is non-empty
   * and reports a clear failure if it never is.
   */
  waitForPendingApproval(): Promise<void>;
  chain: FakeChainState;
  bitcoin: FakeBitcoinState;
  events: { tabId: number; message: ProviderEventMessage }[];
  prices: Map<string, PriceQuote>;
  /** Intervals the auto-lock alarm was asked to re-arm with, in order. */
  rescheduledAutoLockMinutes: number[];
  /**
   * Ages every outstanding transaction by `milliseconds`.
   *
   * The harness clock is fixed, so this backdates the RECORDS rather than
   * moving time -- it is the transaction that has been waiting, and everything
   * else about the harness should stay where it is.
   */
  backdateOutstandingTransactions(milliseconds: number): Promise<void>;
  createAndUnlockWallet(): Promise<void>;
  connectOrigin(origin?: string, accounts?: string[]): Promise<void>;
}

/** One fixed clock for the whole harness -- router, stores and assertions. */
const harnessNow = () => 1_700_000_000_000;

export interface CreateHarnessOptions {
  /**
   * Build the context WITHOUT a Bitcoin service, the way an absent
   * `VITE_BITCOIN_INDEXER_URL` leaves the real service worker. This is the only
   * way to exercise the feature-off path, and the path matters: it is what
   * every user who has not configured an indexer runs.
   */
  bitcoin?: boolean;
  /**
   * Storage to build the wallet over, instead of a fresh in-memory area.
   *
   * `KeyValueStorageArea` is get/set/remove and deliberately cannot be
   * enumerated -- the production implementation is `chrome.storage.local`,
   * which nothing in the wallet has a reason to list. That leaves no way to
   * ask "what is actually on disk now", which is exactly the question
   * `tests/storageInventory.test.ts` exists to answer, so it supplies an area
   * it can see into.
   */
  area?: KeyValueStorageArea;
}

export function createHarness({
  bitcoin: bitcoinEnabled = true,
  area = createMemoryStorageArea(),
}: CreateHarnessOptions = {}): Harness {

  const chain: FakeChainState = {
    chainId: 11155111,
    nativeBalance: 10n ** 18n,
    tokenBalances: new Map(),
    tokenContracts: new Map(),
    pendingNonce: 7,
    confirmedNonce: 7,
    gasEstimate: 21_000n,
    baseFeePerGas: 20_000_000_000n,
    broadcasts: [],
    nextTransactionHash: `0x${"ab".repeat(32)}`,
    transfersFrom: [],
    transfersTo: [],
    transfersError: undefined,
    ensForward: new Map(),
    ensReverse: new Map(),
  };

  /**
   * A fake viem client rather than fake readers.
   *
   * Faking one layer lower means the real `viemBalanceReader` and
   * `viemNetworkReader` run in the test -- including the fee-history off-by-one
   * (`baseFeePerGas` has one more entry than blocks) and the
   * insufficient-funds fallback, both of which have already caused real bugs.
   */
  const fakeClient = {
    async getBalance() {
      return chain.nativeBalance;
    },
    async readContract({ address, functionName }: { address: string; functionName: string }) {
      const key = address.toLowerCase();

      if (functionName === "balanceOf") {
        const balance = chain.tokenBalances.get(key);
        if (balance === undefined) throw new Error("no such token");
        return balance;
      }

      // Metadata. A contract that is absent, or that omits the field, THROWS --
      // which is what a revert looks like to viem, and is the case the import
      // path has to refuse rather than paper over.
      const contract = chain.tokenContracts.get(key);
      if (!contract) throw new Error("not a token contract");

      if (functionName === "decimals") {
        const claimed = contract.decimals;
        if (claimed === undefined) throw new Error("no decimals()");
        if (Array.isArray(claimed)) {
          return claimed.length > 1 ? (claimed.shift() as number) : (claimed[0] as number);
        }
        return claimed;
      }
      if (functionName === "symbol") {
        if (contract.symbol === undefined) throw new Error("no symbol()");
        return contract.symbol;
      }
      if (functionName === "name") {
        if (contract.name === undefined) throw new Error("no name()");
        return contract.name;
      }
      throw new Error(`unexpected ${functionName}`);
    },
    async getChainId() {
      return chain.chainId;
    },
    async getFeeHistory() {
      return {
        baseFeePerGas: [chain.baseFeePerGas, chain.baseFeePerGas],
        reward: [[1_000_000_000n, 2_000_000_000n, 3_000_000_000n]],
      };
    },
    /**
     * "pending" and "latest" are genuinely different numbers on a real node,
     * and the replacement flow depends on the gap between them -- that gap IS
     * the set of outstanding transactions. A fake that returned one value for
     * both would make every stuck-transaction test pass by accident.
     */
    async getTransactionCount({ blockTag }: { blockTag?: string } = {}) {
      return blockTag === "latest" ? chain.confirmedNonce : chain.pendingNonce;
    },
    async estimateGas() {
      if (chain.gasEstimate instanceof Error) throw chain.gasEstimate;
      return chain.gasEstimate;
    },
    async sendRawTransaction({ serializedTransaction }: { serializedTransaction: string }) {
      chain.broadcasts.push(serializedTransaction);
      return chain.nextTransactionHash;
    },
    /**
     * Vendor JSON-RPC extensions go through `request`. Faked at this level so
     * the REAL `alchemyTransferReader` parsing runs in the test -- including
     * the trap where the convenient `value` field is a lossy double and only
     * `rawContract.value` is exact.
     */
    async request({ method, params }: { method: string; params: unknown[] }) {
      if (method !== "alchemy_getAssetTransfers") throw new Error(`unexpected ${method}`);
      if (chain.transfersError) throw chain.transfersError;
      const query = (params[0] ?? {}) as { fromAddress?: string };
      return { transfers: query.fromAddress ? chain.transfersFrom : chain.transfersTo };
    },
  } as unknown as PublicClient;

  const presenter = { openCount: 0, closeCount: 0 };
  const fakePresenter: ApprovalPresenter = {
    async open() {
      presenter.openCount += 1;
    },
    async close() {
      presenter.closeCount += 1;
    },
  };

  const prices = new Map<string, PriceQuote>();
  const priceReader: PriceReader = {
    async readPrices() {
      return new Map(prices);
    },
  };

  const events: { tabId: number; message: ProviderEventMessage }[] = [];

  const walletService = new WalletService({
    storage: createVaultStorage(area),
    keyDerivationParams: FAST_SCRYPT,
  });
  const permissionStore = new OriginPermissionStore({ area });
  const selectedAccountStore = new SelectedAccountStore({ area });
  const networkService = new NetworkService({
    area,
    defaultChainId: chain.chainId,
    createClient: () => fakeClient,
    createEnsResolver: () => ({
      async resolveName({ normalizedName }) {
        return chain.ensForward.get(normalizedName);
      },
      async lookupAddress({ address }) {
        return chain.ensReverse.get(address.toLowerCase());
      },
    }),
  });
  const approvalService = new ApprovalService({ presenter: fakePresenter });
  const tokenService = new TokenService({ area });
  /**
   * The store's clock must be the ROUTER's clock.
   *
   * Left on `Date.now` it would stamp records with the real time while the
   * router judged their age against the harness's fixed clock -- so every
   * record would read as broadcast years in the future, nothing would ever be
   * stuck, and the tests would pass by never exercising the feature.
   */
  const outstandingTransactions = new OutstandingTransactionStore({ area, now: harnessNow });
  /**
   * Real store over the fake area, and the re-arm callback recorded rather than
   * stubbed out -- `chrome.alarms` is the one part of auto-lock that cannot run
   * here, so what the harness checks is that a change ASKS to be rescheduled.
   */
  const rescheduledAutoLockMinutes: number[] = [];
  const lockSettings = new LockSettingsStore({
    area,
    onChanged: (settings) => rescheduledAutoLockMinutes.push(settings.autoLockAfterMinutes),
  });

  const bitcoin: FakeBitcoinState = {
    addressStats: new Map(),
    transactions: new Map(),
  };

  const fakeBitcoinReader: AddressIndexReader = {
    async readAddressStats({ addresses }) {
      const statsMap = new Map<string, AddressStats>();
      for (const addr of addresses) {
        const custom = bitcoin.addressStats.get(addr) ?? {};
        statsMap.set(addr, {
          address: addr,
          chainFundedSats: custom.chainFundedSats ?? 0n,
          chainSpentSats: custom.chainSpentSats ?? 0n,
          chainTxCount: custom.chainTxCount ?? 0,
          mempoolFundedSats: custom.mempoolFundedSats ?? 0n,
          mempoolSpentSats: custom.mempoolSpentSats ?? 0n,
          mempoolTxCount: custom.mempoolTxCount ?? 0,
        });
      }
      return statsMap;
    },
    async listAddressTransactions({ address }) {
      return bitcoin.transactions.get(address) ?? [];
    },
  };

  const bitcoinIndexHintStore = new BitcoinIndexHintStore({ area });
  // Real store over the fake storage area, not a stub: whether the chosen
  // network SURVIVES is the whole point of it, and a stub would pass that test
  // by never being the thing under test.
  const bitcoinNetworkStore = new BitcoinNetworkStore({ area, fallback: "signet" });
  const bitcoinService = new BitcoinService({
    reader: fakeBitcoinReader,
    priceReader,
    hintStore: bitcoinIndexHintStore,
    networkStore: bitcoinNetworkStore,
    getKeyring: () => walletService.getKeyring(),
    now: harnessNow,
  });

  const context: RouterContext = {
    walletService,
    permissionStore,
    selectedAccountStore,
    approvalService,
    networkService,
    lockSettings,
    tokenService,
    nonceAllocator: new NonceAllocator(),
    pendingTransactions: new PendingTransactionLog(),
    outstandingTransactions,
    preparedTransactions: new PreparedTransactionStore({
      onRelease: (prepared) => releasePreparedNonce(context, prepared),
    }),
    extensionOrigin: EXTENSION_ORIGIN,
    priceReader,
    providerEvents: createProviderEventBroadcaster({
      permissionStore,
      listWalletAccounts: () => listWalletAddresses(context),
      listTabs: async () => [
        { id: 1, url: `${TEST_ORIGIN}/swap` },
        { id: 2, url: `${OTHER_ORIGIN}/` },
        // A tab with no usable origin. Must be silently skipped, never treated
        // as a permission key -- see the "null" origin trap.
        { id: 3, url: "about:blank" },
      ],
      sendToTab: async (tabId, message) => {
        events.push({ tabId, message });
      },
    }),
    // Conditional spread, matching serviceWorker.ts: with
    // `exactOptionalPropertyTypes` an absent key and an explicit `undefined`
    // are different things, and only the former is what "off" looks like.
    ...(bitcoinEnabled ? { bitcoinService } : {}),
    now: harnessNow,
  };

  const router = createMessageRouter(context);
  let requestCounter = 0;

  const harness: Harness = {
    context,
    area,
    presenter,
    chain,
    bitcoin,
    events,
    prices,
    rescheduledAutoLockMinutes,

    async route(request, sender = PAGE_SENDER) {
      /**
       * Deliberately NARROWER than the worker's own gate, which also loads the
       * token service.
       *
       * These three are loaded here because their absence would silently change
       * an authorisation answer. `tokenService` is left out on purpose: handlers
       * that need the token list must load it themselves, and leaving the gate
       * out here is what makes that testable. A harness that reproduced every
       * precondition would prove only that the preconditions exist.
       */
      await Promise.all([
        permissionStore.load(),
        selectedAccountStore.load(),
        networkService.load(),
      ]);
      requestCounter += 1;
      const envelope =
        typeof request === "object" && request !== null
          ? { namespace: "wallet:inpage", id: `req_${requestCounter}`, ...request }
          : request;
      return router.route(envelope, sender);
    },

    async backdateOutstandingTransactions(milliseconds) {
      const stored = (await area.get(OUTSTANDING_TRANSACTIONS_STORAGE_KEY)) as
        | { submittedAt: number }[]
        | undefined;
      await area.set(
        OUTSTANDING_TRANSACTIONS_STORAGE_KEY,
        (stored ?? []).map((record) => ({
          ...record,
          submittedAt: record.submittedAt - milliseconds,
        })),
      );
      // The store already holds the un-backdated copy in memory, so it is
      // rebuilt from the area the same way a restarted worker would.
      context.outstandingTransactions = new OutstandingTransactionStore({ area, now: harnessNow });
    },

    async waitForPendingApproval() {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (approvalService.listPending().length > 0) return;
        await Promise.resolve();
      }
      throw new Error("No approval reached the queue.");
    },

    async answerNextApproval(approved, accounts) {
      const pending = approvalService.listPending()[0];
      if (!pending) throw new Error("No approval is pending.");
      approvalService.resolve(
        pending.approvalId,
        approved
          ? { approved: true, accounts: accounts ?? [TEST_ADDRESS] }
          : { approved: false, reason: "user_rejected" },
      );
    },

    async createAndUnlockWallet() {
      const response = await harness.route(
        { method: "wallet.create", params: { password: TEST_PASSWORD, mnemonic: TEST_PHRASE } },
        PRIVILEGED_SENDER,
      );
      // Loud on failure. A silent setup failure makes every later assertion in
      // the file fail for the wrong reason, which is how a test suite starts
      // costing more than it catches.
      if ("error" in response) {
        throw new Error(`Wallet setup failed: ${response.error.message}`);
      }
    },

    async connectOrigin(origin = TEST_ORIGIN, accounts = [TEST_ADDRESS]) {
      await permissionStore.grant(origin, accounts);
    },
  };

  return harness;
}

export function expectResult<T>(response: WalletResponse): T {
  if ("error" in response) {
    throw new Error(`Expected a result, got error ${response.error.code}: ${response.error.message}`);
  }
  return response.result as T;
}

export function expectError(response: WalletResponse): WalletErrorResponse["error"] {
  if (!("error" in response)) {
    throw new Error(`Expected an error, got result: ${JSON.stringify(response.result)}`);
  }
  return response.error;
}
