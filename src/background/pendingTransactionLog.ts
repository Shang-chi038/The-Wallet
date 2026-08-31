import type { ActivityEntry } from "@/core/activity/transactionHistory";

/**
 * Transactions this wallet broadcast but has not yet seen in the index.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * An indexer cannot see a transaction until it is mined. That is twelve seconds
 * on a quiet chain and minutes on a busy one, and for all of it the activity
 * list looks exactly as it did before the send.
 *
 * A user who sends money and sees no evidence of it concludes the send failed.
 * The natural next action is to send again -- and the second one is real. So
 * showing the pending transaction is not a nicety; it is what stops the wallet
 * from causing double payments.
 *
 * ===========================================================================
 * MEMORY ONLY, AND THAT IS DELIBERATE
 * ===========================================================================
 * This lives in service-worker memory and dies with the worker, exactly like
 * the nonce allocator and for the same reason. Persisting it would mean writing
 * the user's transaction details to disk to solve a problem that lasts twelve
 * seconds, and a stale persisted entry would show a "pending" transaction that
 * confirmed hours ago -- which is worse than showing nothing.
 *
 * The failure mode of losing it is mild and self-correcting: the row disappears
 * for a moment and the indexer supplies the real one shortly after.
 */

/**
 * How long a pending row survives.
 *
 * Long enough for a congested chain, short enough that a dropped transaction
 * does not sit there claiming to be in flight forever. A transaction still
 * unmined after this either made it -- and the indexer will show it -- or was
 * dropped from the mempool, and continuing to display it as pending would be a
 * lie the wallet cannot detect.
 */
export const PENDING_TRANSACTION_TTL_MS = 30 * 60 * 1000;

/** Bounded so a scripted burst of sends cannot grow this without limit. */
export const MAX_PENDING_TRANSACTIONS = 50;

export interface RecordPendingTransactionParams {
  transactionHash: string;
  chainId: number;
  from: string;
  to: string | undefined;
  amount: bigint;
  symbol: string;
  decimals: number;
  tokenAddress: string | undefined;
}

interface PendingRecord extends RecordPendingTransactionParams {
  submittedAt: number;
}

export class PendingTransactionLog {
  private records: PendingRecord[] = [];
  private readonly now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.now = now;
  }

  record(params: RecordPendingTransactionParams): void {
    this.records = [
      { ...params, submittedAt: this.now() },
      ...this.records.filter(
        (existing) =>
          existing.transactionHash.toLowerCase() !== params.transactionHash.toLowerCase(),
      ),
    ].slice(0, MAX_PENDING_TRANSACTIONS);
  }

  /**
   * Pending rows for one account, as activity entries.
   *
   * Filtered by chain as well as address: a transaction pending on Sepolia must
   * not appear in the Ethereum activity list, where it would look like a
   * mainnet transfer the user did not make.
   */
  list(chainId: number, address: string): ActivityEntry[] {
    const cutoff = this.now() - PENDING_TRANSACTION_TTL_MS;
    this.records = this.records.filter((record) => record.submittedAt >= cutoff);

    const owner = address.toLowerCase();
    return this.records
      .filter(
        (record) => record.chainId === chainId && record.from.toLowerCase() === owner,
      )
      .map((record) => ({
        id: `pending:${record.transactionHash}`,
        transactionHash: record.transactionHash,
        // No block yet. `mergeActivity` sorts pending ahead of everything
        // rather than by this placeholder.
        blockNumber: 0n,
        timestamp: record.submittedAt,
        direction: record.to?.toLowerCase() === owner ? ("self" as const) : ("sent" as const),
        from: record.from,
        to: record.to,
        counterparty: record.to,
        assetKind: record.tokenAddress ? ("token" as const) : ("native" as const),
        symbol: record.symbol,
        decimals: record.decimals,
        amount: record.amount,
        tokenAddress: record.tokenAddress,
        chainId: record.chainId,
        status: "pending" as const,
      }));
  }

  /** Called on lock and on wallet reset, alongside the nonce allocator. */
  reset(): void {
    this.records = [];
  }
}
