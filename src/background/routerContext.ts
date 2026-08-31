import { isUnlocked, type KeyringAccount } from "@/core/keyring/keyring";
import {
  canOriginUseAccount,
  listAccountsForOrigin,
  listGrantedAddresses,
} from "@/core/messaging/originPermissions";
import { unauthorizedError, ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import { VaultLockedError } from "@/core/vault/vaultErrors";
import type { PriceReader } from "@/core/price/priceReader";
import type { NonceAllocator } from "@/core/transaction/nonceAllocator";
import type { OutstandingTransactionStore } from "./outstandingTransactionStore";
import type { PendingTransactionLog } from "./pendingTransactionLog";
import type { PreparedTransactionStore } from "./preparedTransactionStore";
import type { WalletService } from "@/core/wallet/walletService";
import type { ApprovalService } from "./approvalService";
import type { LockSettingsStore } from "./lockSettingsStore";
import type { NetworkService } from "./networkService";
import type { TokenService } from "./tokenService";
import type { OriginPermissionStore } from "./originPermissionStore";
import type { ProviderEventBroadcaster } from "./providerEvents";
import type { SelectedAccountStore } from "./selectedAccountStore";

import type { BitcoinService } from "./bitcoinService";

/**
 * The service-worker singletons every handler needs, and the authorisation
 * helpers they must go through.
 *
 * Bundled as an injected object rather than imported as module singletons, so
 * the whole router runs under vitest against fakes -- no chrome.*, no network.
 * The hermetic-suite rule in CLAUDE.md is what makes the trust-boundary tests
 * worth anything: a router that can only be exercised in a real browser is a
 * router whose security properties are checked by hand, once.
 */
export interface RouterContext {
  walletService: WalletService;
  permissionStore: OriginPermissionStore;
  selectedAccountStore: SelectedAccountStore;
  approvalService: ApprovalService;
  networkService: NetworkService;
  /** The user's auto-lock interval. A preference, never a permission. */
  lockSettings: LockSettingsStore;
  /** Built-in plus user-imported ERC-20s. See tokenService.ts. */
  tokenService: TokenService;
  nonceAllocator: NonceAllocator;
  /** Transactions broadcast but not yet visible to the indexer. */
  pendingTransactions: PendingTransactionLog;
  /** Transactions the send form assembled and the user has not yet confirmed. */
  preparedTransactions: PreparedTransactionStore;
  /**
   * Broadcast, unconfirmed, and PERSISTED -- the material a speed-up or cancel
   * needs. Distinct from `pendingTransactions` on purpose; see the header of
   * outstandingTransactionStore.ts.
   */
  outstandingTransactions: OutstandingTransactionStore;
  /**
   * This extension's own origin, `chrome-extension://<id>/`.
   *
   * Used to anchor a wallet-initiated transaction's presentation. Deliberately
   * NOT a grantable origin -- `normalizeOrigin` rejects the scheme -- so it can
   * never accumulate permissions the way a website's origin does.
   */
  extensionOrigin: string;
  priceReader: PriceReader;
  providerEvents: ProviderEventBroadcaster;
  bitcoinService?: BitcoinService;
  now: () => number;
}

/**
 * Accounts the keyring currently holds. Empty while locked, because a locked
 * wallet genuinely does not know them -- this is not a placeholder for a value
 * we are withholding.
 */
export function listWalletAccounts(context: RouterContext): readonly KeyringAccount[] {
  const keyring = context.walletService.getKeyring();
  return isUnlocked(keyring) ? keyring.accounts : [];
}

export function listWalletAddresses(context: RouterContext): string[] {
  return listWalletAccounts(context).map((account) => account.address);
}

export function requireUnlocked(context: RouterContext): void {
  if (!context.walletService.isUnlocked()) throw new VaultLockedError();
}

/**
 * Accounts a given origin may see. `[]` for a stranger, which is what EIP-1193
 * specifies and also what stops every site the user visits from learning which
 * addresses they own.
 */
export function listAccountsVisibleToOrigin(
  context: RouterContext,
  origin: string | undefined,
): string[] {
  return listAccountsForOrigin(
    context.permissionStore.getState(),
    origin,
    listWalletAddresses(context),
  );
}

/**
 * Whether a request from this origin is worth prompting for at all.
 *
 * Answers the LOCKED case, which is the whole reason this is separate from the
 * authorisation check below: a connected dApp asking a locked wallet to sign
 * should get an unlock prompt, not a flat refusal. So the decision to prompt
 * consults the grant as written, while the decision to SIGN re-checks against
 * live accounts after the unlock -- see `assertOriginMayUseAccount`.
 */
export function originHasStandingGrantFor(
  context: RouterContext,
  origin: string | undefined,
  address: string,
): boolean {
  return listGrantedAddresses(context.permissionStore.getState(), origin).some(
    (granted) => granted.toLowerCase() === address.toLowerCase(),
  );
}

/**
 * THE AUTHORISATION CHECK FOR EVERY SIGNATURE.
 *
 * Runs against live accounts, immediately before signing -- never once at the
 * start of a flow and then trusted afterwards. Two distinct attacks make the
 * timing matter:
 *
 *   A dApp granted account A naming account B in the params. The grant is the
 *   authority, not the request, so naming another address must not work.
 *
 *   A grant revoked, or the wallet reset onto a different recovery phrase,
 *   while an approval sat in the queue. Checking only at queue time would sign
 *   with an account whose permission no longer exists.
 */
export function assertOriginMayUseAccount(
  context: RouterContext,
  origin: string | undefined,
  address: string,
): void {
  const permitted = canOriginUseAccount(
    context.permissionStore.getState(),
    origin,
    address,
    listWalletAddresses(context),
  );
  if (!permitted) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.unauthorized,
      `This site is not authorised to use ${address}.`,
    );
  }
}

export function assertOriginConnected(context: RouterContext, origin: string | undefined): void {
  if (listAccountsVisibleToOrigin(context, origin).length === 0) {
    throw unauthorizedError("this method");
  }
}

/**
 * The account the popup is showing, validated against what exists.
 * Undefined only when the wallet is locked or has no accounts at all.
 */
export function resolveSelectedAddress(context: RouterContext): string | undefined {
  return context.selectedAccountStore.resolve(listWalletAddresses(context));
}

/**
 * The accounts that exist inside the recovery phrase's tree.
 *
 * Bitcoin numbers its accounts to MATCH these: the wallet's "Account 2" is
 * BIP-84 account 1'. Imported private keys are deliberately absent -- they are
 * standalone secrets with no position in the seed's tree, so there is no
 * account number to match them to.
 */
export function listSeedDerivedAccounts(context: RouterContext): readonly KeyringAccount[] {
  return listWalletAccounts(context).filter((account) => account.source === "hd");
}

/**
 * The BIP-84 account index for the account the popup is showing.
 *
 * This is the whole reason a Bitcoin address differs between accounts. The
 * index defaulted to 0 for every caller, so every account in the switcher --
 * and every imported key -- showed ONE address: the first HD account's. A user
 * who funded "Account 2" was funding Account 1 and had no way to see it.
 *
 * `undefined` for an imported private key, and that is not a gap to fill with
 * 0. Account 0's address under an imported account would invite a deposit into
 * a key the user believes they are not looking at, and it would render the
 * same balance under every imported account at once. The status facet carries
 * the absence so the popup can drop the Bitcoin card instead of showing
 * someone else's money.
 */
export function resolveBitcoinAccountIndex(context: RouterContext): number | undefined {
  const selectedAddress = resolveSelectedAddress(context);
  if (!selectedAddress) return undefined;

  const selected = listWalletAccounts(context).find(
    (account) => account.address.toLowerCase() === selectedAddress.toLowerCase(),
  );
  if (!selected || selected.source !== "hd") return undefined;
  return selected.addressIndex;
}
