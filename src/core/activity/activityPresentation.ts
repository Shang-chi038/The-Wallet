import type {
  ActivityEntryResult,
  ActivityResult,
  ActivityStatus,
  BitcoinActivityEntryResult,
  BitcoinActivityResult,
} from "../messaging/walletApi";

/**
 * What the activity screen should show, decided here rather than in JSX.
 *
 * ===========================================================================
 * WHY THIS IS A FUNCTION AND NOT A CHAIN OF TERNARIES IN THE COMPONENT
 * ===========================================================================
 * The rule this encodes -- an empty list is AMBIGUOUS and must never be shown
 * bare -- has been lost once already, in a diff that merged Bitcoin into the
 * list and collapsed the "empty, and here is why" branch into a plain "No
 * activity yet". Nothing failed, because a ternary inside a component is not
 * reachable from a hermetic suite with no DOM.
 *
 * So the decision lives here, where a test can make it directly, and the
 * component renders the answer instead of computing it.
 */

/**
 * One row, whichever chain it came from. Deliberately NOT `ActivityEntryResult`
 * -- that type carries EVM-only fields (`decimals`, `assetKind`) a Bitcoin row
 * has no answer for, and widening it would invite the screen to read one.
 */
export interface UnifiedActivityRow {
  id: string;
  symbol: string;
  headline: string;
  timeLabel: string;
  counterparty: string | undefined;
  amountLabel: string;
  direction: "sent" | "received" | "self";
  status: "pending" | "confirmed";
  explorerUrl: string | undefined;
  timestamp: number | undefined;
}

/** A history that is incomplete, and the words needed to say so. */
export interface DegradedActivity {
  status: Exclude<ActivityStatus, "ok">;
  chainName: string;
}

export type ActivityPresentation =
  | { kind: "loading" }
  /** Rows to render. `degraded` is set when they are known to be INCOMPLETE. */
  | { kind: "rows"; rows: UnifiedActivityRow[]; degraded: DegradedActivity | undefined }
  /** Nothing to show, and a reason why. Never the "no activity" copy. */
  | { kind: "degraded"; degraded: DegradedActivity }
  /** Nothing to show, and the wallet is confident that is the whole truth. */
  | { kind: "empty" };

export function toUnifiedRow(entry: ActivityEntryResult): UnifiedActivityRow {
  return {
    id: entry.id,
    symbol: entry.symbol,
    headline: entry.headline,
    timeLabel: entry.timeLabel,
    counterparty: entry.counterparty,
    amountLabel: entry.amountLabel,
    direction: entry.direction,
    status: entry.status,
    explorerUrl: entry.explorerUrl,
    timestamp: entry.timestamp,
  };
}

export function bitcoinToUnifiedRow(
  entry: BitcoinActivityEntryResult,
): UnifiedActivityRow {
  const sign = entry.direction === "received" ? "+" : entry.direction === "sent" ? "-" : "";
  const headline =
    entry.direction === "received"
      ? "Received Bitcoin"
      : entry.direction === "sent"
        ? "Sent Bitcoin"
        : "Bitcoin transfer";

  return {
    // Prefixed so a Bitcoin txid can never collide with an EVM entry id in the
    // merged list, whatever either side's id format becomes later.
    id: `btc:${entry.id}`,
    symbol: "BTC",
    headline,
    timeLabel:
      entry.timestamp === undefined
        ? ""
        : new Date(entry.timestamp).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
    counterparty: entry.counterparty,
    amountLabel: `${sign}${entry.amountLabel}`,
    direction: entry.direction,
    status: entry.status,
    explorerUrl: entry.explorerUrl,
    timestamp: entry.timestamp,
  };
}

/**
 * Merges the two histories into one time-ordered list.
 *
 * Both sides ship a raw `timestamp` for exactly this reason: ordering two lists
 * against each other is a different question from formatting a date, and a
 * merged list ordered by anything else would put a Bitcoin payment from last
 * year above an Ethereum one from this morning.
 */
export function mergeActivityRows(
  activity: ActivityResult | undefined,
  bitcoinActivity: BitcoinActivityResult | undefined,
): UnifiedActivityRow[] {
  return [
    ...(activity?.entries ?? []).map(toUnifiedRow),
    ...(bitcoinActivity?.entries ?? []).map(bitcoinToUnifiedRow),
  ].sort((a, b) => {
    // Pending first: an unconfirmed transaction is the one the user is waiting
    // on, and it has no timestamp to sort by until it lands in a block.
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;
    // A row whose indexer returned no block metadata sorts to the top of the
    // confirmed group rather than the bottom: an unknown date is more likely
    // recent than ancient, and burying it is how a row goes unnoticed.
    const timeA = a.timestamp ?? Number.MAX_SAFE_INTEGER;
    const timeB = b.timestamp ?? Number.MAX_SAFE_INTEGER;
    return timeB - timeA;
  });
}

export interface SelectActivityPresentationParams {
  activity: ActivityResult | undefined;
  bitcoinActivity: BitcoinActivityResult | undefined;
}

export function selectActivityPresentation({
  activity,
  bitcoinActivity,
}: SelectActivityPresentationParams): ActivityPresentation {
  // Neither side has answered yet. The engine reports "no index here" and
  // "index unreachable" as a STATUS rather than an exception, so both arriving
  // undefined means the worker itself has not replied -- a retry fixes that,
  // and a loading state is the honest thing to show meanwhile.
  if (!activity && !bitcoinActivity) {
    return { kind: "loading" };
  }

  const degraded: DegradedActivity | undefined =
    activity && activity.status !== "ok"
      ? { status: activity.status, chainName: activity.chain.name }
      : undefined;

  const rows = mergeActivityRows(activity, bitcoinActivity);
  if (rows.length > 0) {
    return { kind: "rows", rows, degraded };
  }

  // THE BRANCH THIS FILE EXISTS FOR. An empty list plus a degraded status is
  // not "you have never transacted" -- it is "the wallet cannot see whether
  // you have". Saying the former to someone with a busy account is the worse
  // of the two errors and the one a wallet makes by default.
  if (degraded) {
    return { kind: "degraded", degraded };
  }

  return { kind: "empty" };
}
