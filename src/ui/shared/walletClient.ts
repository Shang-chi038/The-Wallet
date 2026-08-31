import { BRIDGE_NAMESPACE } from "@/core/messaging/protocol";
import type { OriginGrant } from "@/core/messaging/originPermissions";
import type { ApprovalPresentation } from "@/core/approval/approvalRequest";
import type {
  AccountApiResult,
  ActivityResult,
  CreateWalletApiResult,
  PortfolioResult,
  PrepareReplacementRequestParams,
  PrepareSendResult,
  RecipientResolution,
  ImportedTokenSummary,
  LockSettingsResult,
  RevealMnemonicApiResult,
  SendMaxResult,
  StuckTransactionsResult,
  SubmitSendResult,
  TokenClaimsResult,
  TokenListResult,
  UnlockApiResult,
  UpdateLockSettingsRequestParams,
  WalletStatusResult,
  BitcoinPortfolioResult,
  BitcoinReceiveAddressResult,
  BitcoinActivityResult,
} from "@/core/messaging/walletApi";

/**
 * The typed client every extension page uses to reach the wallet engine.
 *
 * ===========================================================================
 * THE POPUP IS A THIN CLIENT AND THIS FILE IS WHY
 * ===========================================================================
 * No UI file imports `WalletService`, the keyring, or anything under
 * `core/crypto`. They import this. That is not a layering preference -- it is
 * the reason a bug in a React component cannot leak a private key: the
 * component has no reference to one, and no code path from here can return one.
 *
 * Everything crosses as a plain message and comes back as a plain object. The
 * one exception is the recovery phrase, which `wallet.create` and
 * `wallet.revealMnemonic` return precisely because showing it to the user is
 * the entire point of those calls -- and both are gated behind a password the
 * user just typed.
 */

export class WalletRequestError extends Error {
  /** EIP-1193 / JSON-RPC numeric code. */
  readonly code: number;
  /**
   * The engine's own error code (`incorrect_password`, `weak_password`, ...)
   * when one was supplied. Branch on THIS, never on the message text: messages
   * get reworded and a UI that string-matches them silently stops recognising
   * the case it was written for.
   */
  readonly reason: string | undefined;

  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.name = "WalletRequestError";
    this.code = code;
    this.reason = reason;
  }
}

let requestCounter = 0;

/**
 * Sends one request to the service worker.
 *
 * A closed port is surfaced as an error rather than a hang, for the same reason
 * the content script does it for pages: an extension page waiting forever on a
 * dead worker shows a spinner with no explanation, and the user's only recourse
 * is to guess that closing and reopening the popup might help.
 */
export async function callWallet<TResult>(method: string, params?: unknown): Promise<TResult> {
  requestCounter += 1;
  const id = `ui_${Date.now().toString(36)}_${requestCounter}`;

  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      namespace: BRIDGE_NAMESPACE,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
  } catch (error) {
    throw new WalletRequestError(
      4900,
      error instanceof Error ? error.message : "The wallet is not responding.",
      "disconnected",
    );
  }

  if (response === undefined || response === null) {
    throw new WalletRequestError(4900, "The wallet is not responding.", "disconnected");
  }

  const message = response as {
    result?: unknown;
    error?: { code: number; message: string; data?: { reason?: string } };
  };
  if (message.error) {
    throw new WalletRequestError(
      message.error.code,
      message.error.message,
      message.error.data?.reason,
    );
  }
  return message.result as TResult;
}

// ---------------------------------------------------------------------------
// Named calls
//
// Thin, but named: `walletClient.unlock(password)` at a call site is checkable
// against the engine's signature, whereas a bare string method name is a typo
// away from a runtime-only failure in a security flow.
// ---------------------------------------------------------------------------

export const walletClient = {
  getStatus: () => callWallet<WalletStatusResult>("wallet.getStatus"),

  create: (params: { password: string; strength?: 128 | 256 }) =>
    callWallet<CreateWalletApiResult>("wallet.create", params),

  import: (params: { password: string; mnemonic: string }) =>
    callWallet<CreateWalletApiResult>("wallet.import", params),

  unlock: (password: string) => callWallet<UnlockApiResult>("wallet.unlock", { password }),

  lock: () => callWallet<{ locked: true }>("wallet.lock"),

  addAccount: () => callWallet<AccountApiResult>("wallet.addAccount"),

  importPrivateKey: (privateKey: string) =>
    callWallet<AccountApiResult>("wallet.importPrivateKey", { privateKey }),

  changePassword: (params: { currentPassword: string; nextPassword: string }) =>
    callWallet<{ changed: true }>("wallet.changePassword", params),

  revealMnemonic: (password: string) =>
    callWallet<RevealMnemonicApiResult>("wallet.revealMnemonic", { password }),

  reset: () => callWallet<{ reset: true }>("wallet.reset"),

  getPortfolio: (params?: { address?: string; chainId?: number }) =>
    callWallet<PortfolioResult>("wallet.getPortfolio", params ?? {}),

  selectAccount: (address: string) =>
    callWallet<{ selectedAddress: string }>("wallet.selectAccount", { address }),

  switchChain: (chainId: number) =>
    callWallet<{ chainId: number }>("wallet.switchChain", { chainId }),

  listApprovals: () =>
    callWallet<{ approvals: ApprovalPresentation[] }>("wallet.listApprovals"),

  resolveApproval: (params: { approvalId: string; approved: boolean; accounts?: string[] }) =>
    callWallet<{ resolved: boolean }>("wallet.resolveApproval", params),

  getActivity: (params?: { address?: string; chainId?: number; limit?: number }) =>
    callWallet<ActivityResult>("wallet.getActivity", params ?? {}),

  resolveRecipient: (value: string) =>
    callWallet<RecipientResolution>("wallet.resolveRecipient", { value }),

  getSendMax: (params?: { from?: string; tokenAddress?: string }) =>
    callWallet<SendMaxResult>("wallet.getSendMax", params ?? {}),

  /**
   * Assembles the transaction and returns what the user will review.
   *
   * Paired with `submitSend`, never collapsed into one call: the object shown
   * must be the object signed, and a single call would either have nothing to
   * review or would rebuild on confirm -- and a rebuild seconds later can carry
   * a different fee, gas limit and nonce than the one on screen.
   */
  prepareSend: (params: {
    from?: string;
    recipient: string;
    tokenAddress?: string;
    amountBaseUnits: string;
  }) => callWallet<PrepareSendResult>("wallet.prepareSend", params),

  submitSend: (preparationId: string) =>
    callWallet<SubmitSendResult>("wallet.submitSend", { preparationId }),

  /** Releases the nonce. Must be called on every path that abandons a review. */
  cancelSend: (preparationId: string) =>
    callWallet<{ cancelled: boolean }>("wallet.cancelSend", { preparationId }),

  /**
   * What a token contract says about itself, before anything is stored.
   *
   * Paired with `importToken`, never collapsed into one call -- the same
   * discipline as prepareSend/submitSend. The user has to SEE the decimals the
   * contract claims, because that number decides what "1.00" means for every
   * amount they will ever type for this token.
   */
  lookupToken: (params: { address: string; chainId?: number }) =>
    callWallet<TokenClaimsResult>("wallet.lookupToken", params),

  /**
   * `decimals` is the value that was displayed, echoed back.
   *
   * Not an input the caller gets to choose: the engine re-reads the contract
   * and refuses if the two disagree. A contract that answers differently the
   * second time is trying to have the user approve one token and the wallet
   * store another.
   */
  importToken: (params: { address: string; decimals: number; chainId?: number }) =>
    callWallet<{ token: ImportedTokenSummary }>("wallet.importToken", params),

  listTokens: (params?: { chainId?: number }) =>
    callWallet<TokenListResult>("wallet.listTokens", params ?? {}),

  removeToken: (params: { address: string; chainId?: number }) =>
    callWallet<{ removed: boolean }>("wallet.removeToken", params),

  listConnections: () => callWallet<{ connections: OriginGrant[] }>("wallet.listConnections"),

  revokeConnection: (origin: string) =>
    callWallet<{ revoked: true }>("wallet.revokeConnection", { origin }),

  listStuckTransactions: () =>
    callWallet<StuckTransactionsResult>("wallet.listStuckTransactions"),

  prepareReplacement: (params: PrepareReplacementRequestParams) =>
    callWallet<PrepareSendResult>("wallet.prepareReplacement", params),

  getLockSettings: () => callWallet<LockSettingsResult>("wallet.getLockSettings"),

  updateLockSettings: (params: UpdateLockSettingsRequestParams) =>
    callWallet<LockSettingsResult>("wallet.updateLockSettings", params),

  getBitcoinPortfolio: (params?: { accountIndex?: number }) =>
    callWallet<BitcoinPortfolioResult>("wallet.getBitcoinPortfolio", params ?? {}),

  getBitcoinReceiveAddress: (params?: { accountIndex?: number }) =>
    callWallet<BitcoinReceiveAddressResult>("wallet.getBitcoinReceiveAddress", params ?? {}),

  getBitcoinActivity: (params?: { accountIndex?: number; limit?: number }) =>
    callWallet<BitcoinActivityResult>("wallet.getBitcoinActivity", params ?? {}),

  switchBitcoinNetwork: (params: { network: string }) =>
    callWallet<{ network: string }>("wallet.switchBitcoinNetwork", params),
};
