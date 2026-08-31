import { randomBytes } from "@/core/crypto/randomSource";
import { encodeHex } from "@/core/crypto/encoding";
import type { PreparedTransaction } from "./transactionPreparation";

/**
 * Transactions the send form has assembled but the user has not yet confirmed.
 *
 * ===========================================================================
 * THE SAME INVARIANT AS THE APPROVAL QUEUE, A DIFFERENT SURFACE
 * ===========================================================================
 * A dApp request and a wallet send both need the thing SHOWN and the thing
 * SIGNED to be one object. For a dApp the approval queue holds it; for the send
 * form this does. The consent surfaces differ -- a window versus a review step
 * -- but the property is identical, and it is the reason the send form does not
 * re-send its inputs on confirm and have the worker rebuild the transaction.
 *
 * Rebuilding would reintroduce exactly the preview/payload split this design
 * exists to prevent: the fee, the nonce and even the gas limit can all differ
 * between two assemblies seconds apart, and the user would confirm one
 * transaction and sign another.
 *
 * ===========================================================================
 * EVERY ENTRY MUST RELEASE ITS NONCE
 * ===========================================================================
 * Preparing allocates a nonce. Abandoning a preparation without releasing it
 * strands every later transaction from that account behind a nonce that will
 * never appear on chain. So expiry is not a cleanup detail -- it is the reason
 * this store has a TTL at all, and `onRelease` is called on every path out:
 * cancel, expiry, submit-failure and reset.
 */

/**
 * How long a reviewed transaction stays valid.
 *
 * Two minutes is a fee decision more than a UX one. The transaction carries a
 * fee ceiling computed from the base fee at preparation time, and a base fee
 * that has climbed for two minutes can leave it unminable. Re-preparing is
 * cheap; a stuck transaction is not.
 */
export const PREPARED_TRANSACTION_TTL_MS = 2 * 60 * 1000;

/** Bounded so a scripted caller cannot claim nonces without limit. */
export const MAX_PREPARED_TRANSACTIONS = 8;

export interface PreparedTransactionStoreOptions {
  /** Returns the nonce to the pool. Called on EVERY path that abandons one. */
  onRelease: (prepared: PreparedTransaction) => void;
  ttlMs?: number;
  now?: () => number;
}

interface StoredPreparation {
  prepared: PreparedTransaction;
  preparedAt: number;
}

export class PreparedTransactionStore {
  private readonly entries = new Map<string, StoredPreparation>();
  private readonly onRelease: (prepared: PreparedTransaction) => void;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({
    onRelease,
    ttlMs = PREPARED_TRANSACTION_TTL_MS,
    now = Date.now,
  }: PreparedTransactionStoreOptions) {
    this.onRelease = onRelease;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  store(prepared: PreparedTransaction): string {
    this.expireStale();
    if (this.entries.size >= MAX_PREPARED_TRANSACTIONS) {
      // Drop the oldest rather than refuse the newest: the user is looking at
      // the newest, and it is the one they are about to confirm.
      const oldest = [...this.entries.entries()].sort(
        (left, right) => left[1].preparedAt - right[1].preparedAt,
      )[0];
      if (oldest) this.discard(oldest[0]);
    }

    const preparationId = `prep_${encodeHex(randomBytes(12))}`;
    this.entries.set(preparationId, { prepared, preparedAt: this.now() });
    return preparationId;
  }

  /**
   * Retrieves and REMOVES a preparation.
   *
   * Single use by construction. A preparation that could be submitted twice
   * would broadcast the same nonce twice -- the second one replacing the first
   * in the mempool -- and the user would have no way to tell which of the two
   * they are waiting on.
   */
  take(preparationId: string): PreparedTransaction | undefined {
    this.expireStale();
    const entry = this.entries.get(preparationId);
    if (!entry) return undefined;
    this.entries.delete(preparationId);
    return entry.prepared;
  }

  /** Abandons a preparation and returns its nonce. */
  discard(preparationId: string): boolean {
    const entry = this.entries.get(preparationId);
    if (!entry) return false;
    this.entries.delete(preparationId);
    this.onRelease(entry.prepared);
    return true;
  }

  /** Called on lock and on wallet reset, alongside the nonce allocator. */
  reset(): void {
    for (const preparationId of [...this.entries.keys()]) this.discard(preparationId);
  }

  private expireStale(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [preparationId, entry] of [...this.entries.entries()]) {
      if (entry.preparedAt < cutoff) this.discard(preparationId);
    }
  }
}
