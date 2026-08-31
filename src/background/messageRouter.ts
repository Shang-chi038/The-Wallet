import {
  BRIDGE_NAMESPACE,
  isMethodAllowedForSender,
  isWalletRequest,
  normalizeOrigin,
  PROVIDER_ERROR_CODES,
  ProviderError,
  unsupportedMethodError,
  type WalletErrorResponse,
  type WalletRequest,
  type WalletResponse,
} from "@/core/messaging/protocol";
import type { SenderClassification } from "@/core/messaging/senderTrust";
import { ApprovalQueueFullError } from "./approvalService";
import { handleProviderMethod } from "./providerMethods";
import { handleWalletMethod } from "./walletMethods";
import type { RouterContext } from "./routerContext";

/**
 * The dispatcher.
 *
 * ===========================================================================
 * ONE ENTRY POINT, ONE AUTHORISATION DECISION
 * ===========================================================================
 * Every message the service worker receives passes through `route` exactly
 * once, and `route` consults `isMethodAllowedForSender` exactly once, before
 * anything else happens. No handler re-checks the sender, and no handler is
 * reachable except through here.
 *
 * That is the whole point of a choke point. A codebase where each handler
 * checks its own caller is a codebase where one handler eventually does not,
 * and the one that does not will be the one that unlocks the wallet.
 *
 * ===========================================================================
 * WHY THIS FILE TOUCHES NO chrome.* API
 * ===========================================================================
 * `route` takes a plain request and a plain sender classification and returns a
 * plain response. Everything Chrome-shaped lives in `chromeMessageBridge.ts`.
 *
 * That split is what lets the trust boundary be tested at all: the suite can
 * hand this a page-classified sender asking for `wallet.revealMnemonic` and
 * assert on the refusal, in plain Node, in milliseconds. A router that could
 * only be exercised inside a real browser would be a router whose security
 * properties are verified by hand, once, and then trusted forever.
 */

export interface MessageRouter {
  route(request: unknown, sender: SenderClassification): Promise<WalletResponse>;
}

export function createMessageRouter(context: RouterContext): MessageRouter {
  return {
    async route(rawRequest, sender) {
      if (!isWalletRequest(rawRequest)) {
        return errorResponse("unknown", {
          code: PROVIDER_ERROR_CODES.invalidParams,
          message: "Malformed wallet request.",
        });
      }
      const request: WalletRequest = rawRequest;
      const isPrivileged = sender.kind === "privileged";

      try {
        const result = await dispatch(context, request, sender);
        return { namespace: BRIDGE_NAMESPACE, id: request.id, result };
      } catch (error) {
        reportUnexpectedError(request.method, error);
        return errorResponse(request.id, toErrorPayload(error, isPrivileged));
      }
    },
  };
}

async function dispatch(
  context: RouterContext,
  request: WalletRequest,
  sender: SenderClassification,
): Promise<unknown> {
  /**
   * THE CHOKE POINT.
   *
   * A method a page may not call is reported as UNSUPPORTED, not as
   * unauthorised. "You are not allowed to call wallet.revealMnemonic" confirms
   * that the method exists and is worth attacking; "unsupported method" tells a
   * probing site nothing it did not already know. The wallet's internal surface
   * is not a page's business either way.
   */
  if (!isMethodAllowedForSender(request.method, sender.kind)) {
    throw unsupportedMethodError(request.method);
  }

  if (sender.kind === "privileged") {
    // Extension pages may use both sets -- the popup has to be able to read the
    // chain id. Page methods from a privileged sender run against the
    // extension's own origin, which holds no grant, so `eth_accounts` returns []
    // and anything requiring a grant is refused. The popup uses `wallet.*` for
    // everything that matters.
    return request.method.startsWith("wallet.")
      ? handleWalletMethod(context, request.method, request.params)
      : handleProviderMethod({
          context,
          method: request.method,
          params: request.params,
          origin: sender.origin ?? "",
        });
  }

  /**
   * A page request with no usable origin is refused rather than defaulted.
   *
   * `senderTrust` already collapses opaque origins to undefined -- about:blank,
   * sandboxed iframes and data: URLs all report the literal string "null", and
   * every one of them would share a single permission key if it were used as
   * one. A grant to any of them would be a grant to all of them, on every site.
   */
  const origin = normalizeOrigin(request.origin ?? sender.origin);
  if (!origin) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.unauthorized,
      "Wallet requests must come from a page with an http(s) origin.",
    );
  }

  /**
   * The origin the CONTENT SCRIPT stamped must match the one Chrome reports for
   * the sender. They are derived independently -- one from `location.origin` in
   * the isolated world, one from `chrome.runtime.MessageSender` -- so a
   * mismatch means something is wrong with the bridge, and the safe reading of
   * "wrong with the bridge" is "someone is trying to get a grant for the wrong
   * origin". Chrome's version wins, and a disagreement is refused outright.
   */
  const senderOrigin = normalizeOrigin(sender.origin);
  if (senderOrigin && senderOrigin !== origin) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.unauthorized,
      "Request origin did not match the sending frame.",
    );
  }

  return handleProviderMethod({
    context,
    method: request.method,
    params: request.params,
    origin: senderOrigin ?? origin,
  });
}

function errorResponse(id: string, error: WalletErrorResponse["error"]): WalletErrorResponse {
  return { namespace: BRIDGE_NAMESPACE, id, error };
}

/**
 * Diagnostics for a throw we did not model, without printing anything a secret
 * could hide in.
 *
 * The default logs the METHOD and the ERROR CLASS only -- never the message,
 * never the stack. Exception text routinely quotes the arguments that caused
 * it, and the arguments in this codebase include mnemonics, passwords and
 * private keys; a wallet that logs raw exceptions is one dependency bug away
 * from writing a seed phrase into a console the user may later screenshot.
 *
 * The full error is logged only in a development build, where the developer is
 * the user and the wallet holds test funds. `import.meta.env` is absent in some
 * runtimes, hence the guarded read.
 */
function reportUnexpectedError(method: string, error: unknown): void {
  if (error instanceof ProviderError) return;
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return;
  }

  const isDevelopment = Boolean(
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV,
  );
  if (isDevelopment) {
    console.error(`[wallet] ${method} threw:`, error);
    return;
  }
  console.error(
    `[wallet] ${method} threw an unhandled ${error instanceof Error ? error.name : typeof error}.`,
  );
}

/**
 * Domain errors whose MESSAGE is safe to hand a website.
 *
 * These describe the transaction the site itself asked for -- it cannot afford
 * the fee, the recipient is malformed, the typed data names another chain. A
 * dApp needs to know, and none of it says anything about the wallet's state
 * that the site did not already supply.
 *
 * Everything absent from this list gets a generic sentence. `vault_not_found`
 * or `incorrect_password` leaking to a page would tell any site whether the
 * user has a wallet and how their unlock attempts are going -- exactly what
 * `eth_accounts` returning [] is careful not to reveal.
 */
const PAGE_SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  "insufficient_funds",
  "invalid_recipient",
  "invalid_chain",
  "chain_id_mismatch",
  "unsignable_transaction",
  "typed_data_domain_mismatch",
  "invalid_token_amount",
  "unknown_account",
]);

interface DomainError extends Error {
  code: string;
}

function isDomainError(error: unknown): error is DomainError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

export function toErrorPayload(
  error: unknown,
  isPrivileged: boolean,
): WalletErrorResponse["error"] {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof ApprovalQueueFullError) {
    return { code: PROVIDER_ERROR_CODES.limitExceeded, message: error.message };
  }

  if (isDomainError(error)) {
    const shareMessage = isPrivileged || PAGE_SAFE_ERROR_CODES.has(error.code);
    return {
      code: PROVIDER_ERROR_CODES.internalError,
      message: shareMessage ? error.message : "The wallet could not complete this request.",
      // The machine-readable cause goes to our own pages only, so the popup can
      // show "wrong password" under the password field instead of parsing a
      // sentence that a future edit will reword.
      ...(isPrivileged ? { data: { reason: error.code } } : {}),
    };
  }

  /**
   * An unexpected throw. The message is NOT forwarded, to either audience.
   *
   * Stack traces and library internals routinely quote the arguments that
   * caused them, and the arguments here can include a mnemonic, a password or a
   * private key. A wallet that echoes raw exception text is one dependency bug
   * away from printing a seed phrase into a dApp's console.
   */
  return {
    code: PROVIDER_ERROR_CODES.internalError,
    message: "The wallet could not complete this request.",
    ...(isPrivileged ? { data: { reason: "internal_error" } } : {}),
  };
}
