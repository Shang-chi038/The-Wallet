import type { TransactionWarning } from "../transaction/calldataDecoder";
import type {
  TypedDataPreviewField,
  TypedDataWarning,
} from "../signing/typedDataSigning";
import type { ChainSummary } from "../messaging/walletApi";
import type { OriginRisk } from "../security/originRisk";

/**
 * What the user is being asked to approve.
 *
 * ===========================================================================
 * THE PROPERTY THIS FILE EXISTS TO PROTECT
 * ===========================================================================
 * The bytes shown to the user and the bytes signed must be THE SAME OBJECT.
 *
 * The classic wallet exploit is a preview built from one copy of the request
 * and a signature produced from another: the dApp is asked to re-send params
 * after approval, or the router re-parses the original message, and in between
 * the payload changes. The user approved "send 0.1 ETH to Alice" and signed
 * "approve unlimited USDC to attacker".
 *
 * So an approval record is created ONCE, at request time, holding both:
 *
 *   presentation  - a serialisable projection, the only part that ever reaches
 *                   the approval window
 *   payload       - the resolved, ready-to-execute object, which stays in the
 *                   service worker and is what actually gets signed
 *
 * Nothing re-derives the payload after the user says yes. Approval is a lookup
 * by id, not a re-parse.
 *
 * `presentation` is deliberately a separate type rather than a subset of
 * `payload`, so adding a field to the payload cannot silently widen what
 * crosses to the UI.
 */

export type ApprovalKind =
  | "connect"
  | "personalSign"
  | "typedData"
  | "transaction"
  | "switchChain"
  | "addChain"
  | "watchAsset";

export interface ApprovalPresentationBase {
  approvalId: string;
  kind: ApprovalKind;
  /**
   * Stamped by the content script from the real document. Every prompt is
   * anchored to this, and it is the one field a page must never influence.
   */
  origin: string;
  /**
   * What the wallet can say about that origin -- see `originRisk.ts`.
   *
   * On the BASE type, so every prompt carries it. A warning that appears on
   * transactions but not on signature requests would leave the cheapest and
   * commonest drain -- an off-chain signature -- as the one screen with no
   * warning on it.
   */
  originRisk: OriginRisk;
  createdAt: number;
  chain: ChainSummary;
}

/**
 * Connect. The account list is a CHOICE, not a confirmation: the user picks
 * which accounts this origin may see, and the default is the currently selected
 * one only. Defaulting to "all" would quietly undo the reason people keep
 * separate accounts.
 */
export interface ConnectApprovalPresentation extends ApprovalPresentationBase {
  kind: "connect";
  /**
   * Pre-ticked accounts -- the currently selected one, not all of them.
   *
   * The selectable LIST is deliberately absent from this record. The approval
   * window is a privileged page and reads the live account list from
   * `wallet.getStatus`, so there is exactly one source of truth for which
   * accounts exist. A snapshot frozen here would go stale the moment the user
   * unlocks or adds an account mid-approval -- and a stale list in a consent
   * screen means consenting to something other than what is shown.
   */
  defaultSelectedAddresses: string[];
  /** True when this origin already holds a grant and is asking to widen it. */
  isReconnect: boolean;
}

export interface PersonalSignApprovalPresentation extends ApprovalPresentationBase {
  kind: "personalSign";
  address: string;
  displayText: string;
  /** Payload was not printable text: the user is approving opaque bytes. */
  isBinary: boolean;
  byteLength: number;
}

export interface TypedDataApprovalPresentation extends ApprovalPresentationBase {
  kind: "typedData";
  address: string;
  primaryType: string;
  domainName: string | undefined;
  verifyingContract: string | undefined;
  fields: TypedDataPreviewField[];
  /**
   * What signing this authorises, above and beyond the field list.
   *
   * Required, not optional, and for the same reason `originRisk` is required
   * on the base: an approval kind that can carry a warning and does not is a
   * screen someone will ship without one. The transaction presentation has had
   * `warnings` since the calldata decoder; this one had no such field at all,
   * so an unlimited permit -- a grant needing no transaction and therefore
   * catchable nowhere else -- rendered as five unannotated rows.
   */
  warnings: TypedDataWarning[];
}

export interface TransactionApprovalPresentation extends ApprovalPresentationBase {
  kind: "transaction";
  address: string;
  /** One-line summary from `describeTransactionIntent`. */
  headline: string;
  recipient: string | undefined;
  /** Decimal strings: these are bigint in the engine and must not become floats. */
  valueBaseUnits: string;
  expectedFeeBaseUnits: string;
  maximumFeeBaseUnits: string;
  valueLabel: string;
  expectedFeeLabel: string;
  maximumFeeLabel: string;
  /**
   * False when the gas limit is a static fallback rather than a live estimate
   * (an unfunded account cannot be estimated for). The UI must say so instead
   * of presenting a guess as a measurement.
   */
  isFeeEstimated: boolean;
  /** True when the calldata could not be decoded. Must be surfaced loudly. */
  isBlindSigning: boolean;
  warnings: TransactionWarning[];
  dataHex: string | undefined;
  nonce: number;
}

export interface SwitchChainApprovalPresentation extends ApprovalPresentationBase {
  kind: "switchChain";
  targetChain: ChainSummary;
}

export interface AddChainApprovalPresentation extends ApprovalPresentationBase {
  kind: "addChain";
  targetChain: ChainSummary;
  rpcUrl: string;
  /**
   * Whether the endpoint's own `eth_chainId` matched what the site claimed.
   * A false here means the site tried to register an impostor network and the
   * request is refused before it is ever shown; the field exists so the UI can
   * explain a refusal rather than fail silently.
   */
  isRpcVerified: boolean;
}

/**
 * EIP-747: a site asking for a token to appear in the wallet.
 *
 * EVERY FIELD HERE WAS READ FROM THE CONTRACT, not taken from the request.
 * EIP-747 lets the page supply `symbol` and `decimals`, and honouring them
 * would let any site register "USDC, 6 decimals" pointing at a contract it
 * controls -- a row that looks exactly like the real thing in a list where
 * the user picks what to send. The page chooses the ADDRESS; the wallet
 * decides what that address is called.
 *
 * `isKnown` distinguishes "this would be new" from "you already have this",
 * because the second is not really a request to add anything.
 */
export interface WatchAssetApprovalPresentation extends ApprovalPresentationBase {
  kind: "watchAsset";
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    networkLabel: string;
  };
  /** The user's holding of it, when the wallet is unlocked. */
  balanceLabel: string | undefined;
  isKnown: boolean;
}

/**
 * A presentation before the queue assigns it an id.
 *
 * Written as a DISTRIBUTIVE conditional rather than
 * `Omit<ApprovalPresentation, "approvalId">`, because a plain Omit over a union
 * collapses it to the fields all members share -- which here is the base type
 * alone. That would silently make every kind-specific field (the address being
 * signed for, the chain being added) invisible to the type checker at exactly
 * the call sites that construct them.
 */
export type DraftApprovalPresentation =
  ApprovalPresentation extends infer TPresentation
    ? TPresentation extends ApprovalPresentation
      ? Omit<TPresentation, "approvalId">
      : never
    : never;

export type ApprovalPresentation =
  | ConnectApprovalPresentation
  | PersonalSignApprovalPresentation
  | TypedDataApprovalPresentation
  | TransactionApprovalPresentation
  | SwitchChainApprovalPresentation
  | AddChainApprovalPresentation
  | WatchAssetApprovalPresentation;

/**
 * Why an approval ended without a yes.
 *
 * All of these become code 4001 for the dApp, because a dApp only needs to know
 * "no signature happened". The distinction is kept for the wallet's own logging
 * and for the message the user sees, where "you closed the window" and "the
 * request expired" are genuinely different events.
 */
export type ApprovalRejectionReason =
  | "user_rejected"
  | "window_closed"
  | "timed_out"
  | "wallet_locked"
  | "shutdown";

export type ApprovalDecision =
  | { approved: true; accounts: string[] }
  | { approved: false; reason: ApprovalRejectionReason };

export function isApproved(
  decision: ApprovalDecision,
): decision is { approved: true; accounts: string[] } {
  return decision.approved;
}

/** Message shown to the user for a rejection. Never shown to the dApp. */
export function describeRejection(reason: ApprovalRejectionReason): string {
  switch (reason) {
    case "user_rejected":
      return "You declined this request.";
    case "window_closed":
      return "The approval window was closed, so the request was declined.";
    case "timed_out":
      return "The request expired before it was answered.";
    case "wallet_locked":
      return "The wallet locked before the request was answered.";
    case "shutdown":
      return "The wallet restarted before the request was answered.";
  }
}
