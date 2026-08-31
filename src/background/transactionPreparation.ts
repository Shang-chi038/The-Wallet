import type { TransactionSerializable } from "viem";
import { toChainSummary } from "@/core/messaging/walletApi";
import type { DraftApprovalPresentation } from "@/core/approval/approvalRequest";
import type { ChainDefinition } from "@/core/network/chain";
import { assessOriginRisk, type OriginRisk } from "@/core/security/originRisk";
import {
  applyGasLimitMargin,
  computeExpectedTransactionFee,
  computeFeeEstimates,
  computeMaxTransactionFee,
  DEFAULT_MINIMUM_PRIORITY_FEE,
  type FeeEstimate,
  type GasLimitFallbackKind,
} from "@/core/transaction/feeEstimate";
import {
  assertSufficientBalance,
  buildTransaction,
} from "@/core/transaction/transactionBuilder";
import {
  decodeTransactionIntent,
  describeTransactionIntent,
  type TransactionIntent,
} from "@/core/transaction/calldataDecoder";

import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import type { NetworkReader } from "@/platform/rpc/viemNetworkReader";
import { signTransactionRequest } from "@/core/signing/signingService";
import { assertOriginMayUseAccount, requireUnlocked, type RouterContext } from "./routerContext";

/**
 * Transaction assembly, shared by the dApp path and the wallet's own send.
 *
 * ===========================================================================
 * WHY THERE IS EXACTLY ONE OF THESE
 * ===========================================================================
 * Two things need to turn an intent into a signable transaction: a website
 * calling `eth_sendTransaction`, and the user filling in the send form. It is
 * tempting to give the send form its own simpler path, because it does not need
 * to parse hostile params and it does not open an approval window.
 *
 * That would be a mistake, and a well-documented one: two builders for one
 * transaction is how a preview and a payload drift apart. The dApp path
 * accumulated a fee model, a gas fallback, a nonce discipline and an
 * affordability check, each for a specific reason. A second path starts without
 * them and acquires them one incident at a time.
 *
 * So both callers come here. What differs is only the CONSENT SURFACE: a dApp
 * request opens an approval window, the send form shows a review step. The
 * object being consented to is produced by the same code either way.
 *
 * ===========================================================================
 * ORDERING IS THE SECURITY PROPERTY
 * ===========================================================================
 * Everything that can be known to fail is resolved and rejected HERE, before
 * any consent surface appears. Asking someone to approve a transaction the
 * wallet already knows cannot succeed trains them to click through warnings,
 * and burns a real fee when it reverts on chain.
 */

const FALLBACK_KIND_BY_INTENT: Record<TransactionIntent["kind"], GasLimitFallbackKind> = {
  nativeTransfer: "nativeTransfer",
  tokenTransfer: "tokenTransfer",
  tokenApproval: "tokenApproval",
  nftApprovalForAll: "tokenApproval",
  contractDeployment: "contractCall",
  unknownContractCall: "contractCall",
};

export interface PrepareTransactionParams {
  context: RouterContext;
  /** Anchors the presentation. The extension's own URL for a wallet send. */
  origin: string;
  from: string;
  to: string | undefined;
  value: bigint;
  data: string | undefined;
  gasLimit?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
  gasPrice?: bigint | undefined;
  nonce?: number | undefined;
}

/**
 * What moved, in the terms the activity list needs.
 *
 * Separate from the transaction because they disagree for tokens: an ERC-20
 * transfer has a native `value` of zero and moves its amount in calldata. A
 * pending row built from `transaction.value` would say the user sent 0 ETH.
 */
export interface TransferSummary {
  amount: bigint;
  symbol: string;
  decimals: number;
  tokenAddress: string | undefined;
  recipient: string | undefined;
}

export interface PreparedTransaction {
  transaction: TransactionSerializable;
  /** The ONLY thing that should ever be shown for this transaction. */
  presentation: DraftApprovalPresentation;
  intent: TransactionIntent;
  chain: ChainDefinition;
  from: string;
  nonce: number;
  /** True when we allocated the nonce and are therefore responsible for it. */
  allocatedByUs: boolean;
  transferSummary: TransferSummary;
}

export async function prepareTransaction({
  context,
  origin,
  from,
  to,
  value,
  data,
  gasLimit: requestedGasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
  gasPrice,
  nonce: requestedNonce,
}: PrepareTransactionParams): Promise<PreparedTransaction> {
  const chain = context.networkService.getActiveChain();
  const networkReader = context.networkService.getNetworkReader(chain.chainId);
  const balanceReader = context.networkService.getBalanceReader(chain.chainId);
  // Imported tokens included, so a send of one decodes into a readable preview
  // instead of falling through to blind signing. The preview marks them -- see
  // the `imported_token` warning in calldataDecoder.
  //
  // Loaded here rather than trusting the worker's dispatch gate. A dApp asking
  // to transfer an imported token against an unloaded list would be shown "the
  // wallet cannot read this" for a transfer the wallet reads perfectly well --
  // and a blind-signing warning that fires when it should not is one that
  // people learn to click through.
  await context.tokenService.load();
  const knownTokens = context.tokenService.listTokens(chain.chainId);

  const intent = decodeTransactionIntent({ to, value, data, knownTokens });

  const fee = await resolveFeeEstimate(networkReader, {
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasPrice,
  });

  const { gasLimit, isEstimated } = await resolveGasLimit(
    networkReader,
    { from, to, value, data, gasLimit: requestedGasLimit },
    intent,
  );

  // Read the balance before any consent surface. A transaction that cannot pay
  // for itself is rejected here rather than shown and then failing on chain
  // after the fee has already been spent.
  const nativeBalance = await balanceReader.readNativeBalance({
    address: from,
    chainId: chain.chainId,
  });
  assertSufficientBalance({ nativeBalance, value, gasLimit, fee });

  const allocatedByUs = requestedNonce === undefined;
  const nonce = allocatedByUs
    ? context.nonceAllocator.allocate({
        chainId: chain.chainId,
        address: from,
        pendingNonceFromChain: await networkReader.readPendingNonce(from),
      })
    : requestedNonce;

  try {
    const transaction = buildTransaction({
      from,
      to,
      value,
      ...(data === undefined ? {} : { data }),
      chainId: chain.chainId,
      nonce,
      gasLimit,
      fee,
    });

    return {
      transaction,
      presentation: buildPresentation({
        origin,
        originRisk: assessOriginRisk({
          origin,
          connectedOrigins: Object.keys(context.permissionStore.getState().grants),
        }),
        createdAt: context.now(),
        chain,
        from,
        intent,
        transaction,
        fee,
        gasLimit,
        isEstimated,
        nonce,
      }),
      intent,
      chain,
      from,
      nonce,
      allocatedByUs,
      transferSummary: summarizeTransfer(intent, chain, value, to),
    };
  } catch (error) {
    // A nonce allocated to a transaction we then failed to build must go back.
    // Skipping this is what creates gaps: every later transaction from the
    // account queues behind a nonce that will never appear on chain.
    if (allocatedByUs) {
      context.nonceAllocator.release({ chainId: chain.chainId, address: from }, nonce);
    }
    throw error;
  }
}

/**
 * Returns a nonce to the pool.
 *
 * Every path that abandons a prepared transaction -- a declined approval, a
 * cancelled review, an expired preparation, a failed broadcast -- must route
 * through here.
 */
export function releasePreparedNonce(
  context: RouterContext,
  prepared: PreparedTransaction,
): void {
  if (!prepared.allocatedByUs) return;
  context.nonceAllocator.release(
    { chainId: prepared.chain.chainId, address: prepared.from },
    prepared.nonce,
  );
}

/**
 * Signs the prepared object and broadcasts it.
 *
 * Re-checks authorisation immediately before the key is lent, because consent
 * can be minutes old by now: the user may have locked the wallet, revoked the
 * origin's grant, or reset onto a different recovery phrase while the review
 * was on screen.
 *
 * Signs `prepared.transaction` -- the same object the presentation was derived
 * from. Nothing here rebuilds it.
 */
export async function signAndBroadcastPrepared(
  context: RouterContext,
  prepared: PreparedTransaction,
  options: { origin?: string | undefined } = {},
): Promise<string> {
  requireUnlocked(context);
  if (options.origin !== undefined) {
    assertOriginMayUseAccount(context, options.origin, prepared.from);
  }

  try {
    const signed = await signTransactionRequest({
      keyring: context.walletService.getKeyring(),
      address: prepared.from,
      transaction: prepared.transaction,
      expectedChainId: prepared.chain.chainId,
    });

    const networkReader = context.networkService.getNetworkReader(prepared.chain.chainId);
    const transactionHash = await networkReader.sendRawTransaction(signed.serialized);

    // Recorded so the activity list shows it immediately. An index cannot see a
    // transaction until it is mined, and a send with no visible result is a
    // send the user repeats.
    context.pendingTransactions.record({
      transactionHash,
      chainId: prepared.chain.chainId,
      from: prepared.from,
      to: prepared.transferSummary.recipient,
      amount: prepared.transferSummary.amount,
      symbol: prepared.transferSummary.symbol,
      decimals: prepared.transferSummary.decimals,
      tokenAddress: prepared.transferSummary.tokenAddress,
    });

    /**
     * And recorded again, persistently, as the material a replacement needs.
     *
     * Not a duplicate of the line above: that one is a row in the activity list
     * and dies with the worker, this one is what makes "Speed up" possible an
     * hour later. See the header of outstandingTransactionStore.ts for why the
     * two have different lifetimes.
     *
     * The fees come from the SIGNED transaction rather than from the fee
     * estimate, because the signed transaction is what the network was actually
     * offered -- and the node's replacement threshold is measured against that.
     *
     * A failure to persist must not fail a broadcast that already happened. The
     * transaction is on its way; the worst case is a wallet that cannot offer to
     * replace it, which is exactly where it stood before this store existed.
     */
    try {
      await context.outstandingTransactions.record({
        chainId: prepared.chain.chainId,
        from: prepared.from,
        nonce: prepared.nonce,
        transactionHash,
        // viem types a contract-deployment `to` as null; the store speaks
        // undefined, and the two mean the same thing here.
        to: prepared.transaction.to ?? undefined,
        value: prepared.transaction.value ?? 0n,
        data: prepared.transaction.data,
        gasLimit: prepared.transaction.gas ?? 0n,
        maxFeePerGas: prepared.transaction.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: prepared.transaction.maxPriorityFeePerGas ?? 0n,
        description: describeOutstanding(prepared),
      });
    } catch {
      // Intentionally silent, and intentionally not reported to the caller.
    }

    // Deliberately NOT confirmed here. `confirm` means "the chain's pending
    // count now covers this", and a node that has just accepted a transaction
    // may not report it on the very next eth_getTransactionCount. Releasing it
    // early would hand the same nonce to the next send.
    return transactionHash;
  } catch (error) {
    releasePreparedNonce(context, prepared);
    throw error;
  }
}

/**
 * A one-line description of what a transaction was for.
 *
 * Stored with the record so a "stuck" row can name the transaction it is
 * offering to fix. Rebuilding it later from calldata would mean decoding again
 * against a token list that may have changed -- and a row describing the wrong
 * transaction is worse than a row with no description.
 */
function describeOutstanding(prepared: PreparedTransaction): string {
  const { amount, decimals, symbol, recipient } = prepared.transferSummary;
  const magnitude = `${formatTokenAmountForDisplay(amount, decimals)} ${symbol}`;
  if (!recipient) return magnitude;
  return `${magnitude} to ${recipient.slice(0, 6)}...${recipient.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Fee and gas
// ---------------------------------------------------------------------------

interface FeeRequestFields {
  maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined;
  gasPrice: bigint | undefined;
}

/**
 * The fee the transaction will carry.
 *
 * Caller-supplied values win where present -- a site doing its own estimation
 * for a time-sensitive trade has a reason -- but the CURRENT BASE FEE is always
 * read, because the "expected cost" shown to the user is base fee plus tip and
 * cannot be derived from the ceiling alone. Showing the ceiling as the price is
 * the single most common way wallets make themselves look expensive and push
 * users into setting fees that get stuck.
 *
 * Legacy `gasPrice` maps onto both 1559 fields, which is how a legacy
 * transaction prices under 1559 anyway.
 */
export async function resolveFeeEstimate(
  networkReader: NetworkReader,
  request: FeeRequestFields,
): Promise<FeeEstimate> {
  if (request.gasPrice !== undefined && request.maxFeePerGas === undefined) {
    return {
      level: "medium",
      maxFeePerGas: request.gasPrice,
      maxPriorityFeePerGas: request.gasPrice,
      expectedFeePerGas: request.gasPrice,
    };
  }

  const history = await networkReader.readFeeHistory();
  const estimate = computeFeeEstimates({ history }).medium;
  if (request.maxFeePerGas === undefined && request.maxPriorityFeePerGas === undefined) {
    return estimate;
  }

  const maxPriorityFeePerGas = request.maxPriorityFeePerGas ?? estimate.maxPriorityFeePerGas;
  const maxFeePerGas = request.maxFeePerGas ?? estimate.maxFeePerGas;
  const expected = history.baseFeePerGas + maxPriorityFeePerGas;
  return {
    level: "medium",
    maxPriorityFeePerGas:
      maxPriorityFeePerGas < DEFAULT_MINIMUM_PRIORITY_FEE
        ? DEFAULT_MINIMUM_PRIORITY_FEE
        : maxPriorityFeePerGas,
    maxFeePerGas,
    // The protocol charges min(ceiling, base + tip). Reporting more than the
    // ceiling as "expected" would overstate a deliberately tight fee.
    expectedFeePerGas: expected > maxFeePerGas ? maxFeePerGas : expected,
  };
}

export async function resolveGasLimit(
  networkReader: NetworkReader,
  request: {
    from: string;
    to: string | undefined;
    value: bigint;
    data: string | undefined;
    gasLimit: bigint | undefined;
  },
  intent: TransactionIntent,
): Promise<{ gasLimit: bigint; isEstimated: boolean }> {
  // A caller-supplied limit is used as given, with no margin added. The site
  // computed it against its own contract and knows better than a blanket 20%;
  // inflating it would misreport the maximum fee on the approval screen.
  if (request.gasLimit !== undefined) return { gasLimit: request.gasLimit, isEstimated: true };

  const estimate = await networkReader.estimateGasWithFallback({
    from: request.from,
    to: request.to,
    value: request.value,
    data: request.data,
    fallbackKind: FALLBACK_KIND_BY_INTENT[intent.kind],
  });

  // Margin applies to live estimates only. The fallbacks are already
  // conservative, and padding them further would overstate the fee on the one
  // screen an unfunded user is reading to work out what to deposit.
  return estimate.isEstimated
    ? { gasLimit: applyGasLimitMargin(estimate.gasLimit), isEstimated: true }
    : estimate;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

interface BuildPresentationParams {
  origin: string;
  /** What the wallet knows about that origin. See `originRisk.ts`. */
  originRisk: OriginRisk;
  createdAt: number;
  chain: ChainDefinition;
  from: string;
  intent: TransactionIntent;
  transaction: TransactionSerializable;
  fee: FeeEstimate;
  gasLimit: bigint;
  isEstimated: boolean;
  nonce: number;
}

function buildPresentation({
  origin,
  originRisk,
  createdAt,
  chain,
  from,
  intent,
  transaction,
  fee,
  gasLimit,
  isEstimated,
  nonce,
}: BuildPresentationParams): DraftApprovalPresentation {
  const expectedFee = computeExpectedTransactionFee(fee, gasLimit);
  const maximumFee = computeMaxTransactionFee(fee, gasLimit);
  const decimals = chain.nativeCurrency.decimals;
  const value = transaction.value ?? 0n;

  return {
    kind: "transaction",
    originRisk,
    origin,
    createdAt,
    chain: toChainSummary(chain),
    address: from,
    headline: describeTransactionIntent(intent),
    // viem types `to` as nullable for deployments; the presentation says
    // "absent" with undefined so the UI has one empty case, not two.
    recipient: transaction.to ?? undefined,
    // Exact decimal strings alongside the labels: the label is for the human,
    // the base units are for anything that needs to recompute without a float.
    valueBaseUnits: value.toString(),
    expectedFeeBaseUnits: expectedFee.toString(),
    maximumFeeBaseUnits: maximumFee.toString(),
    valueLabel: `${formatTokenAmountForDisplay(value, decimals)} ${chain.nativeCurrency.symbol}`,
    expectedFeeLabel: `${formatTokenAmountForDisplay(expectedFee, decimals)} ${chain.nativeCurrency.symbol}`,
    maximumFeeLabel: `${formatTokenAmountForDisplay(maximumFee, decimals)} ${chain.nativeCurrency.symbol}`,
    isFeeEstimated: isEstimated,
    isBlindSigning: intent.isBlindSigning,
    warnings: intent.warnings,
    dataHex: transaction.data,
    nonce,
  };
}

/**
 * What actually moved, for the pending activity row.
 *
 * Reads the decoded intent rather than the transaction, because for a token
 * transfer the two disagree: the transaction's native value is zero and the
 * real amount is in the calldata.
 */
function summarizeTransfer(
  intent: TransactionIntent,
  chain: ChainDefinition,
  value: bigint,
  to: string | undefined,
): TransferSummary {
  if (intent.kind === "tokenTransfer" && intent.token) {
    return {
      amount: intent.amount,
      symbol: intent.token.symbol,
      decimals: intent.token.decimals,
      tokenAddress: intent.token.address,
      recipient: intent.recipient,
    };
  }
  return {
    amount: value,
    symbol: chain.nativeCurrency.symbol,
    decimals: chain.nativeCurrency.decimals,
    tokenAddress: undefined,
    recipient: to,
  };
}
