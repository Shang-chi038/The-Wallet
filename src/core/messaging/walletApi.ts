import type { ChainDefinition } from "../network/chain";
import type { PortfolioChange } from "../price/priceReader";
import type { TransactionApprovalPresentation } from "../approval/approvalRequest";
import type { KeyringAccount } from "../keyring/keyring";

/**
 * The wire contract between the wallet engine and its clients.
 *
 * ===========================================================================
 * WHY EVERY AMOUNT HERE IS A STRING
 * ===========================================================================
 * Balances are `bigint` end to end inside the engine and must stay that way.
 * But this contract crosses two different transports: `chrome.runtime`
 * messaging (structured clone) for extension pages, and `window.postMessage`
 * for the page bridge. Rather than depend on bigint surviving both hops
 * identically in every Chromium version, amounts cross as EXACT DECIMAL
 * STRINGS and are parsed back to bigint on arrival.
 *
 * The rule this preserves: no `Number()` ever touches a balance. A string is a
 * lossless carrier for a 256-bit integer; a double is not.
 *
 * Fiat values are the one exception and are plain numbers, because they are
 * display-only conversions of an already-exact on-chain figure and are never an
 * input to a transaction. Same reasoning as `fiatDisplay.formatFiatForHero`.
 */

// ---------------------------------------------------------------------------
// Shared summaries
// ---------------------------------------------------------------------------

/**
 * An account as the UI sees it. Deliberately NOT `KeyringAccount`: that type is
 * the engine's internal shape and gains fields over time, and a serialiser that
 * forwards whatever it is handed is how key material eventually leaks into a
 * message. This is an explicit projection instead.
 */
export interface WalletAccountSummary {
  id: string;
  address: string;
  label: string;
  /**
   * Imported keys are NOT recoverable from the recovery phrase. The UI has to
   * mark them, so the distinction crosses the wire.
   */
  source: "hd" | "privateKey";
}

export interface ChainSummary {
  chainId: number;
  name: string;
  shortName: string;
  isTestnet: boolean;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
  blockExplorerUrl: string;
}

export function toChainSummary(chain: ChainDefinition): ChainSummary {
  return {
    chainId: chain.chainId,
    name: chain.name,
    shortName: chain.shortName,
    isTestnet: chain.isTestnet,
    nativeCurrencySymbol: chain.nativeCurrency.symbol,
    nativeCurrencyDecimals: chain.nativeCurrency.decimals,
    blockExplorerUrl: chain.blockExplorerUrl,
  };
}

/**
 * Accounts are labelled by index within their source, matching what every other
 * wallet shows. HD accounts read "Account 1"; imported ones say so, because a
 * user who backs up their phrase and assumes an imported key is covered will
 * lose it.
 */
export function toAccountSummary(account: KeyringAccount, index: number): WalletAccountSummary {
  return {
    id: account.id,
    address: account.address,
    label: account.source === "hd" ? `Account ${index + 1}` : `Imported ${index + 1}`,
    source: account.source,
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenLookupRequestParams {
  address: string;
  /** Defaults to the active chain. */
  chainId?: number;
}

/**
 * What a contract SAYS about itself, plus what this wallet already knows.
 *
 * Named "claims" throughout rather than "details": every field below except
 * `chainId` and the balance came out of a contract somebody else deployed, and
 * the import screen's whole job is to show the user what it claims before they
 * agree to store it.
 */
export interface TokenClaimsResult {
  address: string;
  chainId: number;
  decimals: number;
  symbol: string;
  name: string;
  /** The selected account's balance, base units as an exact decimal string. */
  balanceBaseUnits: string;
  /** Pre-truncated for display, in the decimals the contract claims. */
  balanceLabel: string;
  /** Already in the wallet — built in or previously imported. */
  isKnown: boolean;
  isBuiltIn: boolean;
  networkLabel: string;
}

export interface ImportTokenRequestParams {
  address: string;
  chainId?: number;
  /**
   * The decimals the user was SHOWN.
   *
   * Required, and compared against a fresh read before anything is stored. A
   * caller that has not looked the token up cannot supply this, which is the
   * point: nothing gets imported that was never displayed.
   */
  decimals: number;
}

export interface ImportedTokenSummary {
  address: string;
  chainId: number;
  symbol: string;
  name: string;
  decimals: number;
  networkLabel: string;
}

export interface TokenListResult {
  tokens: ImportedTokenSummary[];
}

// ---------------------------------------------------------------------------
// wallet.getStatus
// ---------------------------------------------------------------------------

export interface BitcoinNetworkSummary {
  network: "mainnet" | "signet" | "testnet4";
  name: string;
  shortName: string;
  isTestnet: boolean;
  explorerUrl: string;
}

export interface WalletStatusResult {
  hasVault: boolean;
  isUnlocked: boolean;
  /** Empty while locked: the engine genuinely does not know them. */
  accounts: WalletAccountSummary[];
  selectedAddress: string | undefined;
  chain: ChainSummary;
  availableChains: ChainSummary[];
  /** Drives the popup's "1 request waiting" affordance. */
  pendingApprovalCount: number;
  /** Present when Bitcoin feature is active. */
  bitcoin?: {
    network: BitcoinNetworkSummary;
    /**
     * What the Bitcoin network picker offers.
     *
     * Sent rather than hardcoded in the popup for the reason `availableChains`
     * is: the engine validates a switch against this exact list, and a UI
     * offering a network the engine would refuse is a control that does
     * nothing when clicked.
     */
    availableNetworks: BitcoinNetworkSummary[];
    /** BIP-84 accounts that exist: one per recovery-phrase account. */
    accountCount: number;
    /**
     * The BIP-84 account matching the account the popup is showing.
     *
     * Absent when the selected account was imported as a private key, which
     * has no position in the phrase's tree. The popup drops the Bitcoin card
     * on absence rather than falling back to account 0 -- see
     * `resolveBitcoinAccountIndex`.
     */
    accountIndex?: number;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateWalletRequestParams {
  password: string;
  /** Omit for a fresh phrase; supply to import one. */
  mnemonic?: string;
  strength?: 128 | 256;
}

export interface CreateWalletApiResult {
  /**
   * Returned exactly once, at creation, so onboarding can display it for
   * backup. Never returned again without a fresh password check.
   */
  mnemonic: string;
  accounts: WalletAccountSummary[];
}

export interface UnlockRequestParams {
  password: string;
}

export interface UnlockApiResult {
  accounts: WalletAccountSummary[];
}

export interface ChangePasswordRequestParams {
  currentPassword: string;
  nextPassword: string;
}

export interface RevealMnemonicRequestParams {
  password: string;
}

export interface RevealMnemonicApiResult {
  mnemonic: string;
}

export interface ImportPrivateKeyRequestParams {
  privateKey: string;
}

export interface AccountApiResult {
  account: WalletAccountSummary;
  accounts: WalletAccountSummary[];
}

// ---------------------------------------------------------------------------
// wallet.getPortfolio
// ---------------------------------------------------------------------------

export interface PortfolioEntryResult {
  kind: "native" | "token";
  symbol: string;
  name: string;
  /** Base units as an exact decimal string. Parse with BigInt(), never Number(). */
  amountBaseUnits: string;
  decimals: number;
  /** Pre-truncated for display. "<0.000001" for a tiny non-zero balance. */
  balanceLabel: string;
  /** Undefined when no price was available — NOT zero. See below. */
  fiatValue: number | undefined;
  /**
   * WHY there is no fiat figure, when there is none.
   *
   *   "priced"      — `fiatValue` is present
   *   "unavailable" — the feed did not answer. Transient; a retry may fix it.
   *   "unpriced"    — permanent and by design. Imported tokens are never
   *                   priced, so this is not an outage and must not be
   *                   rendered as one.
   *
   * Same discipline as `PortfolioChange`: an absent value carries its reason,
   * because "we could not reach the price feed" and "this asset has no price
   * and never will" lead the user to different actions.
   */
  fiatStatus: "priced" | "unavailable" | "unpriced";
  /**
   * True for a token the user imported by address.
   *
   * Marked for the same reason `WalletAccountSummary.source` marks an imported
   * key: the wallet vouches for what it shipped and not for what a contract
   * told it, and the user is entitled to see which is which.
   */
  isImported: boolean;
  networkLabel: string;
  tokenAddress: string | undefined;
}

export interface PortfolioRequestParams {
  address?: string;
  chainId?: number;
}

export type { PortfolioChange } from "../price/priceReader";

export interface PortfolioResult {
  address: string;
  chain: ChainSummary;
  entries: PortfolioEntryResult[];
  /**
   * Undefined when the price feed was unreachable.
   *
   * Deliberately not 0. A wallet that renders "$0.00" because a price API timed
   * out is telling the user their funds are gone. The UI must show the token
   * balances and say prices are unavailable, which it can only do if this
   * distinction survives the wire.
   */
  totalFiatValue: number | undefined;
  /**
   * 24-hour change for the portfolio as a whole, WITH the reason when there is
   * none. Never 0.00% as a stand-in: that reads as "nothing moved" when the
   * truth is "we do not know", and the two lead to different decisions.
   *
   * The reason matters because an empty wallet and an unpriced wallet both
   * produce no percentage, and the popup must not describe the first as the
   * second. See `PortfolioChange`.
   */
  change: PortfolioChange;
  fiatCurrency: "USD";
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// wallet.getActivity
// ---------------------------------------------------------------------------

export interface ActivityEntryResult {
  id: string;
  transactionHash: string;
  direction: "sent" | "received" | "self";
  assetKind: "native" | "token" | "nft";
  status: "pending" | "confirmed";
  symbol: string;
  /** Base units as an exact decimal string. Parse with BigInt(), never Number(). */
  amountBaseUnits: string;
  decimals: number;
  /** Pre-truncated for display, with a leading + or - for direction. */
  amountLabel: string;
  headline: string;
  timeLabel: string;
  /**
   * Milliseconds, undefined when the indexer returned no block metadata.
   *
   * Shipped ALONGSIDE the pre-formatted `timeLabel` rather than instead of it:
   * the label is the engine's wording and stays the engine's job, but a
   * screen that merges this list with another (Bitcoin) needs the raw value to
   * order the two against each other. Formatting a date is not the same
   * question as comparing two.
   */
  timestamp: number | undefined;
  counterparty: string | undefined;
  /** Present only when a block explorer is configured for the chain. */
  explorerUrl: string | undefined;
}

/**
 * Why a history might be empty, so the UI never has to guess.
 *
 * Same reasoning as `PortfolioChange`: "no transactions" and "this endpoint has
 * no index" look identical in an empty array, and telling a user with a busy
 * account that they have never transacted is a worse failure than saying the
 * feature is unavailable here.
 */
export type ActivityStatus = "ok" | "unsupported_endpoint" | "unavailable";

export interface ActivityResult {
  address: string;
  chain: ChainSummary;
  entries: ActivityEntryResult[];
  status: ActivityStatus;
  fetchedAt: number;
}

export interface ActivityRequestParams {
  address?: string;
  chainId?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// wallet.resolveRecipient
// ---------------------------------------------------------------------------

/**
 * What the send form's recipient field turned out to be.
 *
 * A discriminated union rather than an address-or-undefined, because the four
 * outcomes need four different things said to the user, and an empty result
 * cannot distinguish "still typing" from "that name does not exist".
 */
export type RecipientResolution =
  | { kind: "address"; address: string }
  | {
      kind: "name";
      address: string;
      /** The ENSIP-15 normalised name -- the one that was actually resolved. */
      normalizedName: string;
      /**
       * True when normalising changed what the user typed. Usually innocent
       * (case folding), but it is also what a homograph attack looks like, so
       * the UI shows the resolved form rather than the typed one.
       */
      wasNormalized: boolean;
    }
  | { kind: "unresolved"; reason: "no_address_record" | "names_unavailable" }
  | { kind: "invalid"; message: string };

export interface ResolveRecipientRequestParams {
  value: string;
  chainId?: number;
}

// ---------------------------------------------------------------------------
// The send flow
// ---------------------------------------------------------------------------

export interface SendMaxRequestParams {
  from?: string;
  /** Omit for the native currency. */
  tokenAddress?: string;
}

export interface SendMaxResult {
  /** Base units, exact decimal string. */
  amountBaseUnits: string;
  amountLabel: string;
  symbol: string;
  decimals: number;
  /**
   * For the native currency this is the balance MINUS the reserved worst-case
   * fee, not the balance. Sending the full balance produces a transaction that
   * cannot pay for itself and is rejected outright.
   */
  reservedForFeeBaseUnits: string;
}

export interface PrepareSendRequestParams {
  from?: string;
  /** An address, or a name the caller has already resolved. */
  recipient: string;
  tokenAddress?: string;
  amountBaseUnits: string;
}

export interface PrepareSendResult {
  preparationId: string;
  /**
   * The review screen's content, produced by the SAME code that builds a dApp
   * approval prompt. One presentation type, two consent surfaces.
   */
  presentation: TransactionApprovalPresentation;
  /** What is actually moving, which for a token is not the transaction value. */
  transferLabel: string;
}

export interface SubmitSendRequestParams {
  preparationId: string;
}

export interface SubmitSendResult {
  transactionHash: string;
  explorerUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// Approvals (privileged: the approval window is an extension page)
// ---------------------------------------------------------------------------

export interface ResolveApprovalRequestParams {
  approvalId: string;
  approved: boolean;
  /** Accounts the user chose to share. Connect approvals only. */
  accounts?: string[];
}

// ---------------------------------------------------------------------------
// wallet.listStuckTransactions / wallet.prepareReplacement
// ---------------------------------------------------------------------------

export interface StuckTransactionResult {
  /** The nonce it occupies. The handle a replacement is built against. */
  nonce: number;
  transactionHash: string;
  /** What it was -- "0.25 ETH to 0x1234...abcd". */
  description: string;
  submittedAt: number;
  /**
   * True when an OLDER transaction is also outstanding.
   *
   * Nonces are sequential, so nothing behind the oldest stuck transaction can
   * be mined until that one is. The UI shows these rows but does not offer to
   * replace them: paying more for a transaction that is queued behind another
   * buys nothing, and leaves the user reading the unchanged queue as a broken
   * button.
   */
  isBlocked: boolean;
}

export interface StuckTransactionsResult {
  address: string | undefined;
  chain: ChainSummary;
  transactions: StuckTransactionResult[];
}

export interface PrepareReplacementRequestParams {
  nonce: number;
  mode: "speedUp" | "cancel";
  address?: string;
}

// ---------------------------------------------------------------------------
// wallet.getLockSettings / wallet.updateLockSettings
// ---------------------------------------------------------------------------

export interface LockSettingsResult {
  autoLockAfterMinutes: number;
  /**
   * The intervals the UI may offer, from the engine rather than hardcoded in
   * the popup. The floor is a platform constraint (`chrome.alarms` will not
   * schedule below a minute), and a UI that invented its own list could offer
   * a 30-second option that silently became 60.
   */
  choices: readonly number[];
}

export interface UpdateLockSettingsRequestParams {
  autoLockAfterMinutes: number;
}

// ---------------------------------------------------------------------------
// Bitcoin (Privileged Sibling Subsystem)
// ---------------------------------------------------------------------------

export interface BitcoinPortfolioRequestParams {
  accountIndex?: number;
}

export interface BitcoinPortfolioResult {
  accountIndex: number;
  network: BitcoinNetworkSummary;
  /** Satoshis as exact decimal strings. */
  confirmedSats: string;
  unconfirmedSats: string;
  totalSats: string;
  balanceLabel: string;
  fiatValue: number | undefined;
  fiatStatus: "priced" | "unavailable";
  usedAddressCount: number;
  fetchedAt: number;
}

export interface BitcoinReceiveAddressRequestParams {
  accountIndex?: number;
}

export interface BitcoinReceiveAddressResult {
  address: string;
  addressIndex: number;
  derivationPath: string;
  network: BitcoinNetworkSummary;
}

export interface BitcoinActivityEntryResult {
  id: string;
  transactionHash: string;
  direction: "sent" | "received" | "self";
  status: "pending" | "confirmed";
  amountSats: string;
  amountLabel: string;
  feeSats: string;
  blockNumber: number | undefined;
  timestamp: number | undefined;
  counterparty: string | undefined;
  explorerUrl: string;
}

export interface BitcoinActivityResult {
  accountIndex: number;
  network: BitcoinNetworkSummary;
  entries: BitcoinActivityEntryResult[];
  status: ActivityStatus;
  fetchedAt: number;
}

export interface BitcoinActivityRequestParams {
  accountIndex?: number;
  limit?: number;
}

