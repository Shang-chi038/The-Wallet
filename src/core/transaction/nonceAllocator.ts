/**
 * Nonce allocation.
 *
 * ===========================================================================
 * WHY A PLAIN eth_getTransactionCount IS NOT ENOUGH
 * ===========================================================================
 * Ethereum requires each account's transactions to be mined in strict nonce
 * order with no gaps. That makes nonce assignment a concurrency problem, and
 * getting it wrong produces two distinct failures:
 *
 *   COLLISION — two transactions sent in quick succession both read the same
 *   pending count and claim the same nonce. One replaces the other in the
 *   mempool, and the user is left believing both were sent. If the second had a
 *   lower gas price it may never mine at all.
 *
 *   GAP — a nonce is allocated to a transaction that is then rejected or
 *   dropped before broadcast. Every later transaction from that account is now
 *   stuck behind a nonce that will never appear, and the wallet looks frozen
 *   with no explanation.
 *
 * So the chain's pending count is the FLOOR, not the answer. This allocator
 * tracks what it has handed out but not yet seen confirmed, hands each caller a
 * distinct value, and returns released nonces to the pool so a rejected
 * transaction does not strand the ones behind it.
 *
 * ===========================================================================
 * MV3 CAVEAT, STATED HONESTLY
 * ===========================================================================
 * This state lives in service-worker memory and is lost when Chrome tears the
 * worker down. That is acceptable and deliberate: on restart we re-read the
 * chain's pending count, which by then reflects anything that was actually
 * broadcast. The residual risk is a transaction broadcast microseconds before
 * termination whose nonce the chain has not yet observed. We accept that narrow
 * window rather than persisting nonce state to disk, because a stale persisted
 * nonce survives restarts and causes the exact gap failure above — a worse and
 * longer-lived problem than the race it would close.
 */

export interface NonceAllocationKey {
  chainId: number;
  address: string;
}

function toMapKey({ chainId, address }: NonceAllocationKey): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export interface AllocateNonceParams extends NonceAllocationKey {
  /**
   * Result of eth_getTransactionCount(address, "pending").
   *
   * Must be the PENDING count, not "latest". "latest" ignores transactions
   * already in the mempool, so every send while one is unconfirmed would
   * collide.
   */
  pendingNonceFromChain: number;
}

export class NonceAllocator {
  /** Nonces handed out and not yet confirmed or released, per account. */
  private readonly inFlight = new Map<string, Set<number>>();

  allocate({ chainId, address, pendingNonceFromChain }: AllocateNonceParams): number {
    if (!Number.isInteger(pendingNonceFromChain) || pendingNonceFromChain < 0) {
      throw new Error("pendingNonceFromChain must be a non-negative integer.");
    }
    const key = toMapKey({ chainId, address });
    const claimed = this.inFlight.get(key) ?? new Set<number>();

    // Walk up from the chain's pending count to the first value we have not
    // already handed out. Starting from the chain each time means a confirmed
    // transaction naturally advances the floor without bookkeeping.
    let candidate = pendingNonceFromChain;
    while (claimed.has(candidate)) candidate += 1;

    claimed.add(candidate);
    this.inFlight.set(key, claimed);
    return candidate;
  }

  /**
   * Returns a nonce to the pool after a transaction failed to broadcast or was
   * rejected at the approval screen.
   *
   * Failing to call this is what creates gaps, so every path that abandons a
   * transaction after allocating must route through here.
   */
  release({ chainId, address }: NonceAllocationKey, nonce: number): void {
    this.inFlight.get(toMapKey({ chainId, address }))?.delete(nonce);
  }

  /**
   * Marks a nonce as observed on chain. The chain's pending count now covers
   * it, so local tracking can forget it.
   */
  confirm({ chainId, address }: NonceAllocationKey, nonce: number): void {
    this.release({ chainId, address }, nonce);
  }

  listInFlight({ chainId, address }: NonceAllocationKey): number[] {
    return [...(this.inFlight.get(toMapKey({ chainId, address })) ?? [])].sort(
      (left, right) => left - right,
    );
  }

  /** Called on lock and on wallet reset. */
  reset(): void {
    this.inFlight.clear();
  }
}

/**
 * Builds a replacement for a stuck transaction (speed-up or cancel).
 *
 * A replacement MUST reuse the original nonce — that is what makes it a
 * replacement rather than an additional transaction. Nodes also require a
 * meaningfully higher fee before they will evict the original from the mempool;
 * geth's threshold is +10%, so we use +15% to leave margin for rounding and for
 * nodes with a stricter rule. Bidding the same or marginally more is the most
 * common reason a "speed up" button appears to do nothing.
 */
export const REPLACEMENT_FEE_BUMP_PERCENT = 15n;

export function computeReplacementFees(previous: {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const bump = (value: bigint): bigint => value + (value * REPLACEMENT_FEE_BUMP_PERCENT) / 100n;
  return {
    maxFeePerGas: bump(previous.maxFeePerGas),
    maxPriorityFeePerGas: bump(previous.maxPriorityFeePerGas),
  };
}
