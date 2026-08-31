/**
 * Injected EIP-1193 provider (MAIN world).
 *
 * Runs in the page's own JavaScript context, so it is fully visible and
 * modifiable by the page. It therefore contains no secrets and no trust: it is
 * a transport that forwards requests to the content script and resolves what
 * the service worker sends back.
 *
 * Anything here can be monkey-patched by the site. That is fine, and it is why
 * nothing here is allowed to matter: a page rewriting its own provider can only
 * lie to itself. Every decision that protects the user -- what a site may see,
 * what gets signed, which origin is asking -- is made on the other side of the
 * content script, from Chrome's own sender fields.
 */

const BRIDGE_NAMESPACE = "wallet:inpage";
const RESPONSE_NAMESPACE = `${BRIDGE_NAMESPACE}:response`;
const EVENT_NAMESPACE = `${BRIDGE_NAMESPACE}:event`;

interface RequestArguments {
  method: string;
  params?: unknown[] | object;
}

/**
 * EIP-1193 error shape.
 *
 * A real Error subclass with a numeric `code`, because dApps do
 * `catch (error) { if (error.code === 4001) ... }` and also routinely log
 * `error.message` or call `error.stack`. Rejecting with a plain object breaks
 * the second half and makes a user cancellation look like a crash.
 */
class ProviderRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    this.data = data;
  }
}

const pendingRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>();

/**
 * No request timeout, deliberately.
 *
 * An approval can legitimately take minutes -- the user is reading a
 * transaction, or went to find their password. A timeout here would cancel
 * requests the wallet is still perfectly capable of answering, and the dApp
 * would report a failure for something the user is about to approve.
 *
 * Not hanging is guaranteed on the other side instead: the content script
 * answers if the service worker's port closes, and the approval queue settles
 * everything else. The only way an entry here outlives its request is if the
 * content script disappears, which happens only when this page is being torn
 * down anyway.
 */

type ProviderEventName = "connect" | "disconnect" | "accountsChanged" | "chainChanged" | "message";

const listeners = new Map<string, Set<(payload: unknown) => void>>();

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) {
    try {
      listener(payload);
    } catch {
      // A throwing dApp listener must not prevent the remaining listeners from
      // running, and must never surface as a wallet error.
    }
  }
}

/**
 * Legacy mirrors of the current state.
 *
 * `window.ethereum.chainId` and `.selectedAddress` are not in EIP-1193, but a
 * large amount of deployed dApp code reads them synchronously at load, before
 * it has awaited anything. Leaving them undefined makes those sites render a
 * disconnected state next to a wallet that is plainly connected.
 */
let currentChainId: string | undefined;
let currentAccounts: string[] = [];

function createProvider() {
  const provider = {
    isWallet: true,

    get chainId(): string | undefined {
      return currentChainId;
    },
    get selectedAddress(): string | undefined {
      return currentAccounts[0];
    },

    /**
     * `isConnected` means "connected to a chain", NOT "the user connected this
     * site". EIP-1193 is explicit about that and the two get confused
     * constantly. We are always able to reach the wallet, so this is always
     * true; whether the site may see accounts is answered by `eth_accounts`.
     */
    isConnected(): boolean {
      return true;
    },

    async request({ method, params }: RequestArguments): Promise<unknown> {
      if (typeof method !== "string" || method === "") {
        throw new ProviderRpcError(-32602, "A method name is required.");
      }

      const id = crypto.randomUUID();
      const response = new Promise<unknown>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
      });

      window.postMessage(
        { namespace: BRIDGE_NAMESPACE, id, method, params },
        window.location.origin,
      );

      const result = await response;
      trackStateFromResult(method, result);
      return result;
    },

    on(event: ProviderEventName, listener: (payload: unknown) => void) {
      const existing = listeners.get(event) ?? new Set();
      existing.add(listener);
      listeners.set(event, existing);
      return provider;
    },

    removeListener(event: ProviderEventName, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener);
      return provider;
    },

    /** Legacy alias some dApps still call instead of eth_requestAccounts. */
    async enable(): Promise<unknown> {
      return provider.request({ method: "eth_requestAccounts" });
    },

    /**
     * Pre-EIP-1193 callback API, still present in older web3.js integrations.
     * Bridged rather than dropped: a wallet that refuses to talk to them simply
     * appears broken on those sites, with nothing to tell the user why.
     */
    sendAsync(
      payload: { id?: string | number; method: string; params?: unknown[] },
      callback: (error: unknown, response?: unknown) => void,
    ): void {
      provider
        .request({ method: payload.method, params: payload.params ?? [] })
        .then((result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }))
        .catch((error: unknown) => callback(error));
    },

    send(
      payload: string | { method: string; params?: unknown[] },
      callbackOrParams?: unknown,
    ): unknown {
      if (typeof payload === "string") {
        return provider.request({ method: payload, params: (callbackOrParams as unknown[]) ?? [] });
      }
      if (typeof callbackOrParams === "function") {
        provider.sendAsync(payload, callbackOrParams as (error: unknown, response?: unknown) => void);
        return undefined;
      }
      return provider.request(payload);
    },
  };

  return provider;
}

/**
 * Keeps the legacy mirrors in step with results the page just received.
 *
 * Without this, a dApp that calls `eth_requestAccounts` and then immediately
 * reads `selectedAddress` sees undefined, because the corresponding event has
 * not been broadcast yet -- the grant only just happened.
 */
function trackStateFromResult(method: string, result: unknown): void {
  if (method === "eth_chainId" && typeof result === "string") {
    currentChainId = result;
    return;
  }
  if ((method === "eth_accounts" || method === "eth_requestAccounts") && Array.isArray(result)) {
    currentAccounts = result.filter((value): value is string => typeof value === "string");
  }
}

const provider = createProvider();

/**
 * EIP-6963 multi-wallet discovery.
 *
 * The legacy pattern was to assign `window.ethereum` and hope you won the race.
 * That is why a user with two wallets installed gets whichever one loaded
 * later, with no way to choose. EIP-6963 replaces the race with an announcement
 * protocol: each wallet broadcasts itself, and the dApp shows the user every
 * wallet that responded.
 */
const providerInfo = {
  uuid: crypto.randomUUID(),
  name: "Wallet",
  // Must be a data URI: the page's CSP would block an external image, and we do
  // not want a remote fetch fingerprinting the user on every dApp visit.
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
  rdns: "xyz.wallet.extension",
};

function announceProvider(): void {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: providerInfo, provider }),
    }),
  );
}

window.addEventListener("eip6963:requestProvider", announceProvider);
announceProvider();

/**
 * Legacy compatibility, done NON-DESTRUCTIVELY.
 *
 * dApps that predate EIP-6963 only know `window.ethereum`. We set it if it is
 * free, and leave it alone if another wallet got there first -- clobbering a
 * competitor's provider breaks the user's other wallet and is the exact
 * behaviour EIP-6963 exists to end. Users who prefer this wallet select it
 * through the dApp's EIP-6963 picker.
 */
if (!("ethereum" in window)) {
  Object.defineProperty(window, "ethereum", {
    value: provider,
    writable: false,
    configurable: false,
  });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as {
    namespace?: string;
    id?: string;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
    event?: string;
    params?: unknown;
  };

  if (data?.namespace === RESPONSE_NAMESPACE && typeof data.id === "string") {
    const pending = pendingRequests.get(data.id);
    if (!pending) return;
    pendingRequests.delete(data.id);
    if (data.error) {
      pending.reject(
        new ProviderRpcError(
          typeof data.error.code === "number" ? data.error.code : -32603,
          data.error.message ?? "The wallet could not complete this request.",
          data.error.data,
        ),
      );
    } else {
      pending.resolve(data.result);
    }
    return;
  }

  if (data?.namespace === EVENT_NAMESPACE && typeof data.event === "string") {
    // Mirror into the legacy properties BEFORE notifying listeners, so a
    // handler that reads `window.ethereum.selectedAddress` sees the value the
    // event is announcing rather than the previous one.
    if (data.event === "accountsChanged" && Array.isArray(data.params)) {
      currentAccounts = data.params.filter((value): value is string => typeof value === "string");
    }
    if (data.event === "chainChanged" && typeof data.params === "string") {
      currentChainId = data.params;
    }
    emit(data.event, data.params);
  }
});

/**
 * `connect`, announced once the chain id is known.
 *
 * EIP-1193 says a provider emits `connect` when it becomes able to serve
 * requests. dApps commonly wait for it before doing anything, so a provider
 * that never emits it looks permanently unavailable to them.
 */
void provider
  .request({ method: "eth_chainId" })
  .then((chainId) => {
    if (typeof chainId === "string") emit("connect", { chainId });
  })
  .catch(() => {
    // The wallet is unreachable (worker gone, extension reloading). Staying
    // quiet is correct: a `disconnect` here would tell every site the user has
    // no wallet, when the truth is the worker is asleep and will wake on the
    // next request.
  });

export {};
