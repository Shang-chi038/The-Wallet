import {
  toAccountSummary,
  toChainSummary,
  type AccountApiResult,
  type ChangePasswordRequestParams,
  type CreateWalletApiResult,
  type CreateWalletRequestParams,
  type ImportPrivateKeyRequestParams,
  type LockSettingsResult,
  type PortfolioRequestParams,
  type PortfolioResult,
  type ResolveApprovalRequestParams,
  type RevealMnemonicApiResult,
  type RevealMnemonicRequestParams,
  type UnlockApiResult,
  type UnlockRequestParams,
  type WalletAccountSummary,
  type WalletStatusResult,
} from "@/core/messaging/walletApi";
import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import { toHexChainId } from "@/core/network/chain";
import type { OriginGrant } from "@/core/messaging/originPermissions";
import type { ApprovalPresentation } from "@/core/approval/approvalRequest";
import { AUTO_LOCK_INTERVAL_CHOICES } from "./lockSettingsStore";
import { listStuckTransactions, prepareReplacement } from "./replacementMethods";
import { readPortfolio } from "./portfolioService";
import { getActivity } from "./activityMethods";
import { importToken, listTokens, lookupToken, removeToken } from "./tokenMethods";
import {
  cancelSend,
  getSendMax,
  prepareSend,
  resolveRecipient,
  submitSend,
} from "./sendMethods";
import {
  getBitcoinActivity,
  getBitcoinPortfolio,
  getBitcoinReceiveAddress,
  switchBitcoinNetwork,
} from "./bitcoinMethods";
import { toBitcoinNetworkSummary } from "./bitcoinService";
import {
  listSeedDerivedAccounts,
  listWalletAccounts,
  listWalletAddresses,
  requireUnlocked,
  resolveBitcoinAccountIndex,
  resolveSelectedAddress,
  type RouterContext,
} from "./routerContext";

/**
 * Privileged methods: the popup, the onboarding tab and the approval window.
 *
 * ===========================================================================
 * WHAT MAKES THESE SAFE TO EXPOSE
 * ===========================================================================
 * Nothing in this file checks who is calling. That check has already happened,
 * once, in `isMethodAllowedForSender` -- and it happens for every message
 * before dispatch, which is the only way a choke point is a choke point. If a
 * page could reach `wallet.unlock` or `wallet.revealMnemonic`, every site the
 * user visits could drain them, so the guard lives at the door rather than
 * being re-implemented (and eventually forgotten) in each handler.
 *
 * What these handlers DO enforce is the second half of the model: being
 * unlocked is not the same as being authorised. `revealMnemonic` and
 * `changePassword` re-derive the KDF from a freshly typed password, because an
 * unlocked wallet on an unattended laptop must not hand the seed to whoever
 * walks past.
 */

function invalidParams(message: string): ProviderError {
  return new ProviderError(PROVIDER_ERROR_CODES.invalidParams, message);
}

function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw invalidParams("Expected an object of parameters.");
  }
  return params as Record<string, unknown>;
}

function readString(params: unknown, key: string): string {
  const value = asRecord(params)[key];
  if (typeof value !== "string" || value === "") throw invalidParams(`\`${key}\` is required.`);
  return value;
}

function readOptionalString(params: unknown, key: string): string | undefined {
  const value = asRecord(params)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidParams(`\`${key}\` must be a string.`);
  return value;
}

/**
 * Numbered within their SOURCE, not within the array.
 *
 * `toAccountSummary` labels by "index", and the array index is not it: HD
 * accounts come first, so on a wallet with two of them the first imported key
 * lands at array position 2 and reads "Imported 3" -- numbering the user's
 * imports from a total they cannot see. `.map(toAccountSummary)` handed it that
 * position directly.
 */
function summarizeAccounts(context: RouterContext): WalletAccountSummary[] {
  const countsBySource = new Map<WalletAccountSummary["source"], number>();
  return listWalletAccounts(context).map((account) => {
    const index = countsBySource.get(account.source) ?? 0;
    countsBySource.set(account.source, index + 1);
    return toAccountSummary(account, index);
  });
}

export async function handleWalletMethod(
  context: RouterContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "wallet.getStatus":
      return getStatus(context);
    case "wallet.create":
      return createWallet(context, params, { requireMnemonic: false });
    case "wallet.import":
      return createWallet(context, params, { requireMnemonic: true });
    case "wallet.unlock":
      return unlock(context, params);
    case "wallet.lock":
      return lock(context);
    case "wallet.addAccount":
      return addAccount(context);
    case "wallet.importPrivateKey":
      return importPrivateKey(context, params);
    case "wallet.changePassword":
      return changePassword(context, params);
    case "wallet.revealMnemonic":
      return revealMnemonic(context, params);
    case "wallet.reset":
      return resetWallet(context);
    case "wallet.getPortfolio":
      return getPortfolio(context, params);
    case "wallet.listApprovals":
      return listApprovals(context);
    case "wallet.resolveApproval":
      return resolveApproval(context, params);
    case "wallet.selectAccount":
      return selectAccount(context, params);
    case "wallet.switchChain":
      return switchChain(context, params);
    case "wallet.listConnections":
      return listConnections(context);
    case "wallet.lookupToken":
      return lookupToken(context, params);
    case "wallet.importToken":
      return importToken(context, params);
    case "wallet.listTokens":
      return listTokens(context, params);
    case "wallet.removeToken":
      return removeToken(context, params);
    case "wallet.revokeConnection":
      return revokeConnection(context, params);
    case "wallet.getLockSettings":
      return getLockSettings(context);
    case "wallet.updateLockSettings":
      return updateLockSettings(context, params);
    case "wallet.getActivity":
      return getActivity(context, params);
    case "wallet.resolveRecipient":
      return resolveRecipient(context, params);
    case "wallet.getSendMax":
      return getSendMax(context, params);
    case "wallet.prepareSend":
      return prepareSend(context, params);
    case "wallet.submitSend":
      return submitSend(context, params);
    case "wallet.cancelSend":
      return cancelSend(context, params);
    case "wallet.listStuckTransactions":
      return listStuckTransactions(context, params);
    case "wallet.prepareReplacement":
      return prepareReplacement(context, params);
    case "wallet.getBitcoinPortfolio":
      return getBitcoinPortfolio(context, params);
    case "wallet.getBitcoinReceiveAddress":
      return getBitcoinReceiveAddress(context, params);
    case "wallet.getBitcoinActivity":
      return getBitcoinActivity(context, params);
    case "wallet.switchBitcoinNetwork":
      return switchBitcoinNetwork(context, params);
    default:
      throw new ProviderError(
        PROVIDER_ERROR_CODES.unsupportedMethod,
        `Unsupported method: ${method}.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function getStatus(context: RouterContext): Promise<WalletStatusResult> {
  const status = await context.walletService.getStatus();
  // Which Bitcoin account the popup should show, and how many exist. Both used
  // to be constants -- `accountCount: 1` and an implicit index 0 -- which is
  // how every account in the switcher came to share one receive address.
  const bitcoinAccountIndex = resolveBitcoinAccountIndex(context);
  const bitcoinFacet = context.bitcoinService
    ? {
        bitcoin: {
          network: toBitcoinNetworkSummary(
            context.bitcoinService.getActiveNetworkDefinition(),
          ),
          availableNetworks: context.bitcoinService
            .listNetworks()
            .map(toBitcoinNetworkSummary),
          accountCount: listSeedDerivedAccounts(context).length,
          // Conditional rather than `accountIndex: undefined`: the field is
          // optional under exactOptionalPropertyTypes, and "absent" is the
          // signal the popup reads.
          ...(bitcoinAccountIndex === undefined ? {} : { accountIndex: bitcoinAccountIndex }),
        },
      }
    : {};

  return {
    hasVault: status.hasVault,
    isUnlocked: status.isUnlocked,
    accounts: summarizeAccounts(context),
    selectedAddress: resolveSelectedAddress(context),
    chain: toChainSummary(context.networkService.getActiveChain()),
    availableChains: context.networkService.listChains().map(toChainSummary),
    pendingApprovalCount: context.approvalService.getPendingCount(),
    ...bitcoinFacet,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function createWallet(
  context: RouterContext,
  params: unknown,
  { requireMnemonic }: { requireMnemonic: boolean },
): Promise<CreateWalletApiResult> {
  const password = readString(params, "password");
  const mnemonic = requireMnemonic
    ? readString(params, "mnemonic")
    : readOptionalString(params, "mnemonic");
  const strength = asRecord(params)["strength"];
  if (strength !== undefined && strength !== 128 && strength !== 256) {
    throw invalidParams("`strength` must be 128 or 256.");
  }

  const request: CreateWalletRequestParams = {
    password,
    ...(mnemonic === undefined ? {} : { mnemonic }),
    ...(strength === undefined ? {} : { strength: strength as 128 | 256 }),
  };
  const result = await context.walletService.createWallet(request);

  const first = result.accounts[0];
  if (first) await context.selectedAccountStore.select(first.address);

  return { mnemonic: result.mnemonic, accounts: summarizeAccounts(context) };
}

async function unlock(context: RouterContext, params: unknown): Promise<UnlockApiResult> {
  const { password } = { password: readString(params, "password") } as UnlockRequestParams;
  await context.walletService.unlock(password);
  await context.selectedAccountStore.load();

  // Connected sites went from seeing [] to seeing their granted accounts. A
  // dApp that missed this keeps rendering a disconnected state next to a wallet
  // that is plainly unlocked, and the user has no way to reconcile the two.
  await context.providerEvents.broadcastAccountsChanged();

  return { accounts: summarizeAccounts(context) };
}

function lock(context: RouterContext): { locked: true } {
  context.walletService.lock();
  // A reviewed-but-unconfirmed send dies with the session, and its nonce goes
  // back to the pool on the way out.
  context.preparedTransactions.reset();
  context.pendingTransactions.reset();
  // In-flight approvals die with the session. Leaving a signature request
  // queued past an explicit lock would mean the user's clearest possible signal
  // -- "lock now" -- left something signable behind it.
  context.approvalService.rejectAll("wallet_locked");
  context.nonceAllocator.reset();
  void context.providerEvents.broadcastAccountsChanged();
  return { locked: true };
}

async function addAccount(context: RouterContext): Promise<AccountApiResult> {
  requireUnlocked(context);
  const account = await context.walletService.addAccount();
  const accounts = summarizeAccounts(context);
  // Taken FROM the list rather than labelled again. Two labelling paths that
  // have to agree are two labelling paths that eventually will not.
  const summary = accounts.find((candidate) => candidate.address === account.address);
  // NOT broadcast: a new account is not automatically visible to any connected
  // site. Grants name specific accounts, and widening one is a decision the
  // user makes per site, not a side effect of creating an account.
  return { account: summary ?? toAccountSummary(account, accounts.length - 1), accounts };
}

async function importPrivateKey(
  context: RouterContext,
  params: unknown,
): Promise<AccountApiResult> {
  requireUnlocked(context);
  const { privateKey } = {
    privateKey: readString(params, "privateKey"),
  } as ImportPrivateKeyRequestParams;
  const account = await context.walletService.importPrivateKey(privateKey);
  const accounts = summarizeAccounts(context);
  const summary = accounts.find((candidate) => candidate.address === account.address);
  return { account: summary ?? toAccountSummary(account, accounts.length - 1), accounts };
}

async function changePassword(context: RouterContext, params: unknown): Promise<{ changed: true }> {
  const request: ChangePasswordRequestParams = {
    currentPassword: readString(params, "currentPassword"),
    nextPassword: readString(params, "nextPassword"),
  };
  await context.walletService.changePassword(request.currentPassword, request.nextPassword);
  return { changed: true };
}

/**
 * The seed, gated on a password the user types NOW.
 *
 * Being unlocked is deliberately not sufficient, and the check is a real KDF
 * re-derivation rather than a comparison against something held in memory --
 * see WalletService.revealMnemonic.
 */
async function revealMnemonic(
  context: RouterContext,
  params: unknown,
): Promise<RevealMnemonicApiResult> {
  const { password } = {
    password: readString(params, "password"),
  } as RevealMnemonicRequestParams;
  return { mnemonic: await context.walletService.revealMnemonic(password) };
}

async function resetWallet(context: RouterContext): Promise<{ reset: true }> {
  await context.walletService.resetWallet();
  // Order matters only in that all of it must happen. A grant that survived a
  // reset would leave a site listed as connected, and would hand it the
  // accounts of a DIFFERENT recovery phrase the moment the user reconnected.
  await context.permissionStore.clear();
  await context.selectedAccountStore.clear();
  // Imported tokens are wallet state too. Leaving them would show the next
  // wallet a list of contracts the person who set it up never chose.
  await context.tokenService.clear();
  // Including the auto-lock interval: the next person to set this wallet up
  // gets the strict default rather than an hour-long window they never chose.
  await context.lockSettings.clear();
  // Including the record of what is still in flight: it names a recipient and
  // an amount, and it belongs to the wallet that was just erased.
  await context.outstandingTransactions.clear();
  context.approvalService.rejectAll("wallet_locked");
  context.preparedTransactions.reset();
  context.pendingTransactions.reset();
  context.nonceAllocator.reset();
  await context.providerEvents.broadcastAccountsChanged();
  return { reset: true };
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

async function getPortfolio(context: RouterContext, params: unknown): Promise<PortfolioResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as PortfolioRequestParams;

  const address = request.address ?? resolveSelectedAddress(context);
  if (!address) throw invalidParams("This wallet has no accounts to read.");

  const known = listWalletAddresses(context);
  // Only ever read an address this wallet owns. Not a secrecy measure -- these
  // are public -- but a proxy for arbitrary addresses would let any extension
  // page turn the wallet into an untraceable balance-lookup service against the
  // user's own RPC key and IP.
  if (!known.some((candidate) => candidate.toLowerCase() === address.toLowerCase())) {
    throw invalidParams("That address does not belong to this wallet.");
  }

  const chain =
    request.chainId === undefined
      ? context.networkService.getActiveChain()
      : context.networkService.findChain(request.chainId);
  if (!chain) throw invalidParams(`Chain ${String(request.chainId)} is not configured.`);

  // Imported tokens are read alongside the built-ins. Without this the import
  // flow would store a token the portfolio never asks about.
  await context.tokenService.load();

  return readPortfolio(
    {
      balanceReader: context.networkService.getBalanceReader(chain.chainId),
      priceReader: context.priceReader,
      now: context.now,
    },
    { address, chain, tokens: context.tokenService.listTokens(chain.chainId) },
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function listApprovals(context: RouterContext): { approvals: ApprovalPresentation[] } {
  return { approvals: context.approvalService.listPending() };
}

/**
 * Records the user's answer.
 *
 * Returns as soon as the queue entry is settled. The work the answer authorises
 * -- granting the origin, signing, broadcasting -- continues in the page
 * handler that is awaiting the decision, because only that handler holds the
 * payload the user actually approved. Re-deriving it here from the answer would
 * reintroduce exactly the preview/payload split this design exists to prevent.
 */
async function resolveApproval(
  context: RouterContext,
  params: unknown,
): Promise<{ resolved: boolean }> {
  const record = asRecord(params);
  const approvalId = readString(params, "approvalId");
  const approved = record["approved"];
  if (typeof approved !== "boolean") throw invalidParams("`approved` must be a boolean.");

  const rawAccounts = record["accounts"];
  if (rawAccounts !== undefined && !Array.isArray(rawAccounts)) {
    throw invalidParams("`accounts` must be an array of addresses.");
  }
  const accounts = (rawAccounts ?? []).filter(
    (value: unknown): value is string => typeof value === "string",
  );

  const request: ResolveApprovalRequestParams = { approvalId, approved, accounts };
  const resolved = context.approvalService.resolve(
    request.approvalId,
    approved
      ? { approved: true, accounts }
      : { approved: false, reason: "user_rejected" },
  );
  return { resolved };
}

// ---------------------------------------------------------------------------
// Account and network selection (direct user actions -- no approval window)
// ---------------------------------------------------------------------------

async function selectAccount(
  context: RouterContext,
  params: unknown,
): Promise<{ selectedAddress: string }> {
  requireUnlocked(context);
  const address = readString(params, "address");
  const match = listWalletAddresses(context).find(
    (candidate) => candidate.toLowerCase() === address.toLowerCase(),
  );
  if (!match) throw invalidParams("That address does not belong to this wallet.");

  await context.selectedAccountStore.select(match);
  // NOT broadcast. Which account the popup shows is a UI preference; what a
  // site sees is its grant. Coupling them would silently switch every connected
  // dApp's account whenever the user glanced at a different one.
  return { selectedAddress: match };
}

async function switchChain(context: RouterContext, params: unknown): Promise<{ chainId: number }> {
  const record = asRecord(params);
  const chainId = record["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
    throw invalidParams("`chainId` must be a number.");
  }
  const chain = await context.networkService.setActiveChain(chainId);
  await context.providerEvents.broadcastChainChanged(toHexChainId(chain.chainId));
  return { chainId: chain.chainId };
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

function getLockSettings(context: RouterContext): LockSettingsResult {
  return {
    autoLockAfterMinutes: context.lockSettings.get().autoLockAfterMinutes,
    choices: AUTO_LOCK_INTERVAL_CHOICES,
  };
}

/**
 * Changes the idle interval.
 *
 * Deliberately NOT gated on `requireUnlocked`. The setting is a preference
 * rather than an operation on key material, and gating it would produce the
 * dead end described in CLAUDE.md: the settings screen is exactly where a
 * worker gets collected, because the user is reading rather than clicking.
 *
 * The value is validated against the offered list rather than merely
 * normalised. `normalizeAutoLockMinutes` would happily accept 100000 and clamp
 * nothing at the top, leaving a wallet that in practice never auto-locks --
 * chosen through a UI that never offered that.
 */
async function updateLockSettings(
  context: RouterContext,
  params: unknown,
): Promise<LockSettingsResult> {
  const record = asRecord(params);
  const minutes = record["autoLockAfterMinutes"];
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes)) {
    throw invalidParams("`autoLockAfterMinutes` must be a number.");
  }
  if (!AUTO_LOCK_INTERVAL_CHOICES.includes(minutes as (typeof AUTO_LOCK_INTERVAL_CHOICES)[number])) {
    throw invalidParams(
      `\`autoLockAfterMinutes\` must be one of ${AUTO_LOCK_INTERVAL_CHOICES.join(", ")}.`,
    );
  }
  const settings = await context.lockSettings.updateAutoLockMinutes(minutes);
  return { autoLockAfterMinutes: settings.autoLockAfterMinutes, choices: AUTO_LOCK_INTERVAL_CHOICES };
}

async function listConnections(context: RouterContext): Promise<{ connections: OriginGrant[] }> {
  return { connections: await context.permissionStore.listGrants() };
}

async function revokeConnection(
  context: RouterContext,
  params: unknown,
): Promise<{ revoked: true }> {
  const origin = readString(params, "origin");
  await context.permissionStore.revoke(origin);
  // The site must be told immediately. A revoked dApp that still believes it is
  // connected will keep building transactions the wallet now refuses to sign,
  // and the user reads that as the wallet being broken rather than as the
  // disconnection they just performed.
  await context.providerEvents.broadcastAccountsChanged();
  return { revoked: true };
}
