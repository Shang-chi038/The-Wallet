/**
 * The message protocol between the wallet engine and its clients.
 *
 * ===========================================================================
 * THE TRUST BOUNDARY THIS FILE EXISTS TO ENFORCE
 * ===========================================================================
 * The service worker has exactly two kinds of caller, and they are NOT equally
 * trusted:
 *
 *   PRIVILEGED — the popup and the onboarding page. These are extension pages
 *     we shipped, running on our own origin behind the MV3 CSP. They may unlock
 *     the wallet, create it, add accounts, and (with a fresh password) reveal
 *     the recovery phrase.
 *
 *   PAGE — anything reaching us through a content script, i.e. an arbitrary
 *     website. Hostile by default. It may ask for the account list and request
 *     signatures, and every one of those either requires a prior per-origin
 *     grant or opens an approval window. It may NEVER touch wallet lifecycle.
 *
 * The catastrophic failure mode is a page-originated message invoking a
 * privileged method. If `wallet.unlock` or `wallet.revealMnemonic` were
 * reachable from a web page, any site the user visits could drain them. So the
 * two method sets are separate types, the privileged set is enumerated
 * explicitly, and `isMethodAllowedForSender` is the single choke point.
 *
 * Method names are namespaced (`wallet.*` vs the EIP-1193 names) so the two
 * sets cannot collide even by accident.
 */

export const BRIDGE_NAMESPACE = "wallet:inpage";

/** Who sent a message. Derived from the chrome sender, never from its content. */
export type SenderKind = "privileged" | "page";

// ---------------------------------------------------------------------------
// Privileged methods — popup and onboarding only
// ---------------------------------------------------------------------------

export const PRIVILEGED_METHODS = [
  "wallet.getStatus",
  "wallet.create",
  "wallet.import",
  "wallet.unlock",
  "wallet.lock",
  "wallet.addAccount",
  "wallet.importPrivateKey",
  "wallet.changePassword",
  "wallet.revealMnemonic",
  "wallet.reset",
  "wallet.getPortfolio",
  "wallet.listApprovals",
  "wallet.resolveApproval",
  /**
   * Added with the router. Each is an action the user takes DIRECTLY in our own
   * UI, which is why none of them opens an approval window: the click is the
   * consent. The page-facing equivalents (`wallet_switchEthereumChain`,
   * `eth_requestAccounts`) still prompt, because there the request comes from a
   * website rather than from the person.
   *
   * They are enumerated here rather than pattern-matched on the `wallet.`
   * prefix on purpose. An allowlist that grows by prefix is a denylist wearing
   * a costume: it would silently admit every future `wallet.*` method,
   * including ones added without thinking about the page boundary.
   */
  "wallet.selectAccount",
  "wallet.switchChain",
  "wallet.listConnections",
  "wallet.lookupToken",
  "wallet.importToken",
  "wallet.listTokens",
  "wallet.removeToken",
  "wallet.revokeConnection",
  /**
   * Auto-lock interval. Read and write, both privileged: how long the wallet
   * stays unlocked is a fact about the user's machine, and a page that could
   * read it would learn when the wallet is likeliest to be unlocked.
   */
  "wallet.getLockSettings",
  "wallet.updateLockSettings",
  /**
   * History, names, and the wallet's own send flow.
   *
   * `prepareSend` / `submitSend` are two calls rather than one for the same
   * reason a dApp transaction is queued rather than signed inline: the object
   * the user reviews must be the object that gets signed. One call that took
   * the form's inputs and signed immediately would have nothing to review, and
   * one that re-sent the inputs on confirm would rebuild -- and a rebuild
   * seconds later can differ in fee, gas and nonce from what was on screen.
   */
  "wallet.getActivity",
  "wallet.resolveRecipient",
  "wallet.getSendMax",
  "wallet.prepareSend",
  "wallet.submitSend",
  "wallet.cancelSend",
  /**
   * Unsticking a transaction. `prepareReplacement` builds it; the existing
   * `submitSend` broadcasts it, because a replacement IS a send and the
   * one-shot guarantee on a preparation should have exactly one implementation.
   */
  "wallet.listStuckTransactions",
  "wallet.prepareReplacement",
  /**
   * Bitcoin methods (Privileged only).
   */
  "wallet.getBitcoinPortfolio",
  "wallet.getBitcoinReceiveAddress",
  "wallet.getBitcoinActivity",
  "wallet.switchBitcoinNetwork",
] as const;

export type PrivilegedMethod = (typeof PRIVILEGED_METHODS)[number];

// ---------------------------------------------------------------------------
// Page methods — the EIP-1193 surface, reachable from any website
// ---------------------------------------------------------------------------

/**
 * Read-only and safe to answer without a prompt, but still gated on the origin
 * having been connected: `eth_accounts` returns [] for a stranger rather than
 * leaking which addresses the user owns to every site they visit.
 */
export const PAGE_READ_METHODS = [
  "eth_accounts",
  "eth_chainId",
  "net_version",
] as const;

/**
 * Every one of these either creates a connection or produces a signature, so
 * every one opens an approval window.
 */
export const PAGE_APPROVAL_METHODS = [
  "eth_requestAccounts",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  /**
   * EIP-747. It creates no connection and produces no signature, but it does
   * add a row to the user's holdings that a site chose -- and a token row is a
   * thing people tap and then send from. So it prompts, like everything else a
   * website can start.
   */
  "wallet_watchAsset",
] as const;

export const PAGE_METHODS = [...PAGE_READ_METHODS, ...PAGE_APPROVAL_METHODS] as const;

export type PageReadMethod = (typeof PAGE_READ_METHODS)[number];
export type PageApprovalMethod = (typeof PAGE_APPROVAL_METHODS)[number];
export type PageMethod = (typeof PAGE_METHODS)[number];

export type WalletMethod = PrivilegedMethod | PageMethod;

// ---------------------------------------------------------------------------
// The choke point
// ---------------------------------------------------------------------------

const PRIVILEGED_SET: ReadonlySet<string> = new Set(PRIVILEGED_METHODS);
const PAGE_SET: ReadonlySet<string> = new Set(PAGE_METHODS);

/**
 * The single authorisation decision in the messaging layer.
 *
 * Deliberately an ALLOWLIST in both directions. A denylist would fail open the
 * moment someone adds a method and forgets to list it — and the thing it would
 * fail open on is wallet lifecycle.
 */
export function isMethodAllowedForSender(method: string, sender: SenderKind): boolean {
  if (sender === "privileged") {
    // Extension pages may use both sets: the popup itself has to be able to
    // read the chain id and the account list.
    return PRIVILEGED_SET.has(method) || PAGE_SET.has(method);
  }
  return PAGE_SET.has(method);
}

export function requiresApproval(method: string): boolean {
  return (PAGE_APPROVAL_METHODS as readonly string[]).includes(method);
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface WalletRequest {
  namespace: typeof BRIDGE_NAMESPACE;
  id: string;
  method: string;
  params?: unknown;
  /**
   * Stamped by the content script from the real document, never read from the
   * message body. A page-supplied origin would be trivially spoofable, and it
   * is what every approval prompt and per-origin grant is keyed to.
   */
  origin?: string;
}

export interface WalletSuccessResponse {
  namespace: string;
  id: string;
  result: unknown;
}

export interface WalletErrorResponse {
  namespace: string;
  id: string;
  error: {
    code: number;
    message: string;
    /**
     * EIP-1193's optional error payload. We use it to carry the wallet's own
     * error code (`incorrect_password`, `insufficient_funds`, ...) so extension
     * pages can branch on the cause rather than string-matching a message.
     *
     * ONLY POPULATED FOR PRIVILEGED SENDERS. A web page gets the numeric code
     * and a sentence, and nothing that describes the wallet's internal state --
     * "vault_not_found" would tell any site whether the user has a wallet at
     * all, which is exactly what `eth_accounts` returning [] avoids leaking.
     */
    data?: { reason: string };
  };
}

export type WalletResponse = WalletSuccessResponse | WalletErrorResponse;

/**
 * EIP-1193 / JSON-RPC error codes. dApps branch on these numerically, so the
 * exact values matter — 4001 in particular is how a dApp tells "user said no"
 * apart from "something broke", and getting it wrong makes dApps show an error
 * dialog when the user simply cancelled.
 */
export const PROVIDER_ERROR_CODES = {
  userRejectedRequest: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  /**
   * EIP-3326. Not an error in the usual sense but a protocol step: it tells a
   * dApp "I do not know this chain", which is its cue to call
   * `wallet_addEthereumChain` and try again. Returning a generic failure here
   * strands every dApp that supports network switching.
   */
  unrecognizedChain: 4902,
  invalidParams: -32602,
  internalError: -32603,
  /**
   * JSON-RPC "limit exceeded". Not part of EIP-1193, but it is what hosted RPC
   * providers return under rate limiting, so dApp error handling already knows
   * it means "back off", not "this failed permanently". Used when a site has
   * more approval prompts queued than it is allowed.
   */
  limitExceeded: -32005,
} as const;

export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function userRejectedError(): ProviderError {
  return new ProviderError(PROVIDER_ERROR_CODES.userRejectedRequest, "User rejected the request.");
}

export function unauthorizedError(method: string): ProviderError {
  return new ProviderError(
    PROVIDER_ERROR_CODES.unauthorized,
    `This site is not authorised to call ${method}.`,
  );
}

export function unrecognizedChainError(chainId: number): ProviderError {
  return new ProviderError(
    PROVIDER_ERROR_CODES.unrecognizedChain,
    `Chain ${chainId} has not been added to this wallet.`,
  );
}

export function unsupportedMethodError(method: string): ProviderError {
  return new ProviderError(
    PROVIDER_ERROR_CODES.unsupportedMethod,
    `Unsupported method: ${method}.`,
  );
}

export function isWalletRequest(value: unknown): value is WalletRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WalletRequest>;
  return (
    candidate.namespace === BRIDGE_NAMESPACE &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.method === "string" &&
    candidate.method.length > 0
  );
}

/**
 * Normalises an origin for use as a permission key.
 *
 * Grants are per-ORIGIN, not per-URL: scheme + host + port, with path, query
 * and fragment discarded. Keying on the full URL would mean a grant to
 * `https://app.example/swap` did not cover `https://app.example/pool`, and
 * users would be prompted endlessly until they stopped reading the prompts.
 *
 * Returns undefined for anything that is not a parseable http(s) origin, which
 * the router treats as "no origin" and refuses rather than guessing.
 */
export function normalizeOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
