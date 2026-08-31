import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import type { TransactionApprovalPresentation } from "@/core/approval/approvalRequest";
import type {
  PrepareReplacementRequestParams,
  PrepareSendResult,
  StuckTransactionResult,
  StuckTransactionsResult,
} from "@/core/messaging/walletApi";
import { toChainSummary } from "@/core/messaging/walletApi";
import {
  buildReplacementRequest,
  computeReplacementFeesForMarket,
  selectStuckTransactions,
  type ReplacementMode,
} from "@/core/transaction/stuckTransaction";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import { prepareTransaction, resolveFeeEstimate } from "./transactionPreparation";
import { requireUnlocked, resolveSelectedAddress, type RouterContext } from "./routerContext";

/**
 * Speeding up and cancelling a transaction the network has not picked up.
 *
 * ===========================================================================
 * THE SAME TWO-CALL SHAPE AS A SEND
 * ===========================================================================
 * `prepareReplacement` builds and shows; `wallet.submitSend` broadcasts what
 * was shown. Deliberately the SAME submit call rather than a parallel one: a
 * replacement is a transaction, the reviewed object must be the signed object,
 * and `preparedTransactions.take` already guarantees a preparation is
 * broadcast at most once. A second submit path would be a second place for
 * that guarantee to be got wrong.
 *
 * ===========================================================================
 * THE NONCE IS PINNED, NEVER ALLOCATED
 * ===========================================================================
 * `prepareTransaction` allocates a fresh nonce when it is not given one. A
 * replacement must reuse the stuck transaction's nonce -- that is the entire
 * mechanism -- so the nonce is passed in, which also sets `allocatedByUs` to
 * false and stops an abandoned review from releasing a nonce that is still
 * genuinely in flight.
 *
 * ===========================================================================
 * ACTIVE CHAIN ONLY
 * ===========================================================================
 * A replacement is built for the chain the wallet is currently on. Building
 * one for another chain would mean signing against a fee market and a nonce
 * the user is not looking at, and the activity list they are acting from shows
 * the active chain anyway.
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

// ---------------------------------------------------------------------------
// wallet.listStuckTransactions
// ---------------------------------------------------------------------------

/**
 * What is outstanding, reconciled against the chain first.
 *
 * The account's `latest` nonce is read on every call, and anything below it is
 * deleted. Without that, a stored record would outlive the transaction it
 * describes and the wallet would offer to replace something already mined --
 * a replacement that can only fail, after the user has paid to find out.
 */
export async function listStuckTransactions(
  context: RouterContext,
  params: unknown,
): Promise<StuckTransactionsResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as { address?: string };
  const address = request.address ?? resolveSelectedAddress(context);
  const chain = context.networkService.getActiveChain();

  if (!address) {
    return { address: undefined, chain: toChainSummary(chain), transactions: [] };
  }

  let latestNonce: number;
  try {
    latestNonce = await context.networkService
      .getNetworkReader(chain.chainId)
      .readConfirmedNonce(address);
  } catch {
    /**
     * The chain is unreachable, so nothing can be reconciled.
     *
     * Reporting the stored records anyway would offer to replace transactions
     * that may well have confirmed. An empty list is the honest answer: the
     * wallet does not currently know of anything stuck, which is different
     * from knowing that nothing is.
     */
    return { address, chain: toChainSummary(chain), transactions: [] };
  }

  const outstanding = await context.outstandingTransactions.reconcile({
    chainId: chain.chainId,
    address,
    latestNonce,
  });

  const stuck = selectStuckTransactions({ outstanding, now: context.now() });
  return {
    address,
    chain: toChainSummary(chain),
    transactions: stuck.map(
      (entry): StuckTransactionResult => ({
        nonce: entry.nonce,
        transactionHash: entry.transactionHash,
        description: entry.description,
        submittedAt: entry.submittedAt,
        isBlocked: entry.isBlocked,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// wallet.prepareReplacement
// ---------------------------------------------------------------------------

export async function prepareReplacement(
  context: RouterContext,
  params: unknown,
): Promise<PrepareSendResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as PrepareReplacementRequestParams;
  const record = asRecord(params);

  const nonce = record["nonce"];
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw invalidParams("`nonce` must be the nonce of the stuck transaction.");
  }
  const mode = record["mode"];
  if (mode !== "speedUp" && mode !== "cancel") {
    throw invalidParams("`mode` must be \"speedUp\" or \"cancel\".");
  }

  const address = request.address ?? resolveSelectedAddress(context);
  if (!address) throw invalidParams("This wallet has no accounts.");
  const chain = context.networkService.getActiveChain();

  const outstanding = await context.outstandingTransactions.find({
    chainId: chain.chainId,
    address,
    nonce,
  });
  if (!outstanding) {
    throw invalidParams(
      "That transaction is no longer outstanding. It may have gone through while this screen was open.",
    );
  }

  /**
   * Re-read the confirmed nonce before building anything.
   *
   * The list was reconciled when it was fetched, and the user has been reading
   * it since. A transaction that confirmed in between must not be "sped up":
   * the replacement would occupy a nonce the chain has moved past, so it can
   * never be mined, and the user would be left watching a second transaction
   * that is stuck by construction.
   */
  const networkReader = context.networkService.getNetworkReader(chain.chainId);
  const latestNonce = await networkReader.readConfirmedNonce(address);
  if (nonce < latestNonce) {
    await context.outstandingTransactions.reconcile({
      chainId: chain.chainId,
      address,
      latestNonce,
    });
    throw invalidParams("That transaction has already gone through.");
  }

  const currentFee = await resolveFeeEstimate(networkReader, {
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
    gasPrice: undefined,
  });
  const fees = computeReplacementFeesForMarket({
    previous: {
      maxFeePerGas: outstanding.maxFeePerGas,
      maxPriorityFeePerGas: outstanding.maxPriorityFeePerGas,
    },
    current: {
      maxFeePerGas: currentFee.maxFeePerGas,
      maxPriorityFeePerGas: currentFee.maxPriorityFeePerGas,
    },
  });

  const replacement = buildReplacementRequest(outstanding, mode as ReplacementMode);

  const prepared = await prepareTransaction({
    context,
    origin: context.extensionOrigin,
    from: address,
    to: replacement.to,
    value: replacement.value,
    data: replacement.data,
    gasLimit: replacement.gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    // Pinned. This is what makes it a replacement rather than one more
    // transaction queued behind the one that is already stuck.
    nonce,
  });

  return {
    preparationId: context.preparedTransactions.store(prepared),
    presentation: prepared.presentation as TransactionApprovalPresentation,
    transferLabel:
      mode === "cancel"
        ? "Nothing, to yourself"
        : `${formatTokenAmountForDisplay(
            prepared.transferSummary.amount,
            prepared.transferSummary.decimals,
          )} ${prepared.transferSummary.symbol}`,
  };
}
