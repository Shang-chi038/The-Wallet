import {
  buildExplorerUrl,
  describeActivity,
  describeActivityTime,
  dropSupersededPending,
  mergeActivity,
  type ActivityEntry,
} from "@/core/activity/transactionHistory";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import {
  toChainSummary,
  type ActivityEntryResult,
  type ActivityRequestParams,
  type ActivityResult,
} from "@/core/messaging/walletApi";
import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import type { ChainDefinition } from "@/core/network/chain";
import { listWalletAddresses, requireUnlocked, resolveSelectedAddress, type RouterContext } from "./routerContext";

/**
 * `wallet.getActivity`.
 *
 * ===========================================================================
 * THREE SOURCES, ONE LIST
 * ===========================================================================
 * The list the user sees is a merge of:
 *
 *   the indexer's confirmed transfers   -- what the chain says happened
 *   this wallet's pending broadcasts    -- what we just did, not yet mined
 *
 * and the merge deduplicates, because a transaction we broadcast appears in
 * both once it confirms, and showing it twice reads as a double send.
 *
 * ===========================================================================
 * AN EMPTY LIST IS AMBIGUOUS, SO IT CARRIES A REASON
 * ===========================================================================
 * "You have no transactions" and "this RPC has no index" produce the same empty
 * array, and telling a user with a busy account that they have never transacted
 * is the worse of the two errors. `status` distinguishes them, exactly as
 * `PortfolioChange` does for prices.
 */

/** A screenful. History is paged by the user scrolling, not by prefetching. */
export const DEFAULT_ACTIVITY_LIMIT = 25;
export const MAX_ACTIVITY_LIMIT = 100;

export async function getActivity(
  context: RouterContext,
  params: unknown,
): Promise<ActivityResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as ActivityRequestParams;

  const address = request.address ?? resolveSelectedAddress(context);
  if (!address) {
    throw new ProviderError(PROVIDER_ERROR_CODES.invalidParams, "This wallet has no accounts.");
  }

  // Same rule as the portfolio: only ever read an address this wallet owns.
  // Otherwise any extension page could turn the wallet into an untraceable
  // history-lookup service against the user's own API key and IP.
  const owned = listWalletAddresses(context);
  if (!owned.some((candidate) => candidate.toLowerCase() === address.toLowerCase())) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.invalidParams,
      "That address does not belong to this wallet.",
    );
  }

  const chain =
    request.chainId === undefined
      ? context.networkService.getActiveChain()
      : context.networkService.findChain(request.chainId);
  if (!chain) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.invalidParams,
      `Chain ${String(request.chainId)} is not configured.`,
    );
  }

  const limit = clampLimit(request.limit);
  const pending = context.pendingTransactions.list(chain.chainId, address);

  if (!context.networkService.supportsTransactionHistory(chain.chainId)) {
    // A custom RPC has no index behind it. The user still gets their own
    // pending sends -- we know about those without asking anyone -- and an
    // honest label for why the rest is missing.
    return {
      address,
      chain: toChainSummary(chain),
      entries: pending.map((entry) => toEntryResult(entry, chain, context.now())),
      status: "unsupported_endpoint",
      fetchedAt: context.now(),
    };
  }

  let confirmed: ActivityEntry[];
  try {
    confirmed = await context.networkService
      .getTransferReader(chain.chainId)
      .listTransfers({ address, chainId: chain.chainId, limit });
  } catch {
    // The index is unreachable. Show what we know locally rather than an error
    // page: a user checking whether their send went out is served by the
    // pending row alone.
    return {
      address,
      chain: toChainSummary(chain),
      entries: pending.map((entry) => toEntryResult(entry, chain, context.now())),
      status: "unavailable",
      fetchedAt: context.now(),
    };
  }

  const merged = mergeActivity(dropSupersededPending(pending, confirmed), confirmed).slice(0, limit);

  return {
    address,
    chain: toChainSummary(chain),
    entries: merged.map((entry) => toEntryResult(entry, chain, context.now())),
    status: "ok",
    fetchedAt: context.now(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_ACTIVITY_LIMIT));
}

function toEntryResult(
  entry: ActivityEntry,
  chain: ChainDefinition,
  now: number,
): ActivityEntryResult {
  const magnitude = formatTokenAmountForDisplay(entry.amount, entry.decimals);
  return {
    id: entry.id,
    transactionHash: entry.transactionHash,
    direction: entry.direction,
    assetKind: entry.assetKind,
    status: entry.status,
    symbol: entry.symbol,
    amountBaseUnits: entry.amount.toString(),
    decimals: entry.decimals,
    // The sign carries direction independently of colour, the same rule the
    // change badge follows. A red "1.5 ETH" is unreadable to a colour-blind
    // user and invisible in a high-contrast theme.
    amountLabel: `${entry.direction === "received" ? "+" : entry.direction === "sent" ? "-" : ""}${magnitude} ${entry.symbol}`,
    headline: describeActivity(entry),
    timeLabel: describeActivityTime(entry.timestamp, now),
    timestamp: entry.timestamp,
    counterparty: entry.counterparty,
    explorerUrl: buildExplorerUrl(chain.blockExplorerUrl, entry.transactionHash),
  };
}
