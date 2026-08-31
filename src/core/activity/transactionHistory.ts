/**
 * Transaction history.
 *
 * ===========================================================================
 * WHY THIS NEEDS AN INDEXER AND NOT JUST RPC
 * ===========================================================================
 * There is no JSON-RPC method that answers "what has this address done". A node
 * can tell you the contents of a block and the receipt for a hash you already
 * know, but "every transfer touching this address" requires an index nobody
 * maintains for you. Scanning blocks client-side means thousands of round trips
 * for a single account, so every wallet with a history tab is using an indexer.
 *
 * We use one behind an interface. `TransferReader` is the contract; the Alchemy
 * implementation lives in `platform/indexer`. That inversion means the ordering,
 * classification and deduplication logic below is testable without a network,
 * and that swapping to Etherscan V2 -- or dropping the feature on a custom RPC
 * -- touches one file.
 *
 * ===========================================================================
 * WHAT AN INDEXER IS AND IS NOT TRUSTED FOR
 * ===========================================================================
 * The indexer is a CONVENIENCE, not an authority. It tells the user what
 * already happened; it never feeds a signature. A compromised indexer can hide
 * a transaction from the activity list or invent one that never occurred, which
 * is a real harm -- a user may conclude a payment did not arrive -- but it
 * cannot move funds, because nothing on this path reaches the signing layer.
 *
 * The mitigation for the harm it CAN do is that every entry links to a block
 * explorer, so the chain itself remains checkable by hand.
 */

export type ActivityDirection = "sent" | "received" | "self";

export type ActivityAssetKind = "native" | "token" | "nft";

export interface ActivityEntry {
  /**
   * Stable across refetches, and unique per transfer rather than per
   * transaction: one transaction can move several assets, and keying on the
   * hash alone would collapse a swap into a single row and hide half of it.
   */
  id: string;
  transactionHash: string;
  blockNumber: bigint;
  /** Milliseconds. Undefined when the indexer returned no metadata. */
  timestamp: number | undefined;
  direction: ActivityDirection;
  from: string;
  /** Undefined for a contract deployment. */
  to: string | undefined;
  /** The other party, from the owner's point of view. */
  counterparty: string | undefined;
  assetKind: ActivityAssetKind;
  symbol: string;
  decimals: number;
  /** Base units. bigint end to end -- see the raw-value trap in the reader. */
  amount: bigint;
  tokenAddress: string | undefined;
  chainId: number;
  /**
   * `pending` rows come from this wallet's own record of what it just
   * broadcast, not from the indexer.
   *
   * They exist because an index does not see a transaction until it is mined,
   * which is ~12 seconds on a good day and much longer on a busy one. An
   * activity list that stays empty for that long after a send looks like the
   * send failed -- and the natural response to a send that looks like it failed
   * is to send again.
   */
  status: "pending" | "confirmed";
}

export interface TransferReader {
  listTransfers(params: {
    address: string;
    chainId: number;
    limit: number;
  }): Promise<ActivityEntry[]>;
}

/** A reader for endpoints with no index behind them. */
export function createUnavailableTransferReader(): TransferReader {
  return {
    async listTransfers() {
      return [];
    },
  };
}

/**
 * Which way the value moved, from the owner's point of view.
 *
 * `self` is its own case rather than being folded into "sent". A transfer
 * between the user's own two accounts is not a payment, and labelling it "sent"
 * makes a portfolio rebalance look like money leaving -- which is exactly the
 * kind of thing that makes someone think they have been robbed.
 */
export function classifyDirection(params: {
  from: string;
  to: string | undefined;
  owner: string;
}): ActivityDirection {
  const owner = params.owner.toLowerCase();
  const isFromOwner = params.from.toLowerCase() === owner;
  const isToOwner = params.to?.toLowerCase() === owner;
  if (isFromOwner && isToOwner) return "self";
  return isFromOwner ? "sent" : "received";
}

/**
 * Drops pending entries the indexer has now caught up on.
 *
 * Matched on transaction hash rather than on the synthetic transfer id: our
 * pending record knows only the hash, while the indexer splits one transaction
 * into a transfer per asset. Keeping both would show a confirmed transfer with
 * a ghost "pending" row above it saying the same thing.
 */
export function dropSupersededPending(
  pending: readonly ActivityEntry[],
  confirmed: readonly ActivityEntry[],
): ActivityEntry[] {
  const seen = new Set(confirmed.map((entry) => entry.transactionHash.toLowerCase()));
  return pending.filter((entry) => !seen.has(entry.transactionHash.toLowerCase()));
}

/**
 * Merges transfer lists into one ordered, deduplicated history.
 *
 * Deduplication is not optional. The indexer is queried once for transfers FROM
 * the address and once for transfers TO it, because that is the only way to get
 * both directions -- and a transfer from one of the user's accounts to another
 * appears in both responses. Without a merge on `id` the activity list shows
 * every self-transfer twice, which reads as the wallet having sent something
 * the user did not authorise.
 *
 * Ordering is newest first, with `id` as the tiebreak so two transfers in the
 * same block have a stable order across refetches rather than shuffling.
 */
export function mergeActivity(
  ...lists: readonly (readonly ActivityEntry[])[]
): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const list of lists) {
    for (const entry of list) byId.set(entry.id, entry);
  }

  return [...byId.values()].sort((left, right) => {
    // Pending first, always. It has no block number yet, and sorting it by the
    // 0n placeholder would bury the transaction the user is actually waiting on
    // underneath their entire history.
    if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber > right.blockNumber ? -1 : 1;
    }
    return left.id < right.id ? 1 : -1;
  });
}

/**
 * One-line description for an activity row.
 *
 * Says what happened in the user's terms, not the protocol's. "Received" and
 * "Sent" rather than "transfer" and "transferFrom", and the counterparty
 * abbreviated because a full address in a dense list is noise nobody reads.
 */
export function describeActivity(entry: ActivityEntry): string {
  if (entry.status === "pending") return `Sending ${entry.symbol}`;
  switch (entry.direction) {
    case "received":
      return `Received ${entry.symbol}`;
    case "sent":
      return `Sent ${entry.symbol}`;
    case "self":
      return `Moved ${entry.symbol} between your accounts`;
  }
}

/**
 * Relative timestamp for an activity row.
 *
 * Relative up to a week, absolute after that. "3 days ago" is easier to place
 * than a date; "47 days ago" is harder to place than the date itself.
 */
export function describeActivityTime(
  timestamp: number | undefined,
  now: number = Date.now(),
): string {
  if (timestamp === undefined) return "";
  // Clock skew between the indexer and this machine can put a block a few
  // seconds in the future. "in 3 seconds" next to a confirmed transaction reads
  // as a bug, so the elapsed time floors at zero.
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));

  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3_600) {
    const minutes = Math.floor(elapsedSeconds / 60);
    return `${minutes}m ago`;
  }
  if (elapsedSeconds < 86_400) {
    const hours = Math.floor(elapsedSeconds / 3_600);
    return `${hours}h ago`;
  }
  if (elapsedSeconds < 7 * 86_400) {
    const days = Math.floor(elapsedSeconds / 86_400);
    return `${days}d ago`;
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Explorer link for one entry, so the chain stays checkable by hand. */
export function buildExplorerUrl(
  blockExplorerUrl: string,
  transactionHash: string,
): string | undefined {
  if (blockExplorerUrl === "") return undefined;
  return `${blockExplorerUrl.replace(/\/$/, "")}/tx/${transactionHash}`;
}
