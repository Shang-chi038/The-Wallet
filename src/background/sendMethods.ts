import { encodeFunctionData, erc20Abi } from "viem";
import { isValidAddress, toChecksumAddress } from "@/core/account/ethereumAddress";
import {
  InvalidEnsNameError,
  isEnsNameCandidate,
  normalizeEnsName,
} from "@/core/ens/ensName";
import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import {
  buildExplorerUrl,
} from "@/core/activity/transactionHistory";
import type {
  PrepareSendRequestParams,
  PrepareSendResult,
  RecipientResolution,
  ResolveRecipientRequestParams,
  SendMaxRequestParams,
  SendMaxResult,
  SubmitSendRequestParams,
  SubmitSendResult,
} from "@/core/messaging/walletApi";
import type { TransactionApprovalPresentation } from "@/core/approval/approvalRequest";
import type { TokenDefinition } from "@/core/token/tokenRegistry";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import { computeSendMaxAmount } from "@/core/transaction/transactionBuilder";
import { FALLBACK_GAS_LIMITS } from "@/core/transaction/feeEstimate";
import {
  prepareTransaction,
  resolveFeeEstimate,
  signAndBroadcastPrepared,
} from "./transactionPreparation";
import {
  listWalletAddresses,
  requireUnlocked,
  resolveSelectedAddress,
  type RouterContext,
} from "./routerContext";

/**
 * The wallet's own send flow.
 *
 * ===========================================================================
 * WHY THIS IS FOUR CALLS AND NOT ONE
 * ===========================================================================
 *   resolveRecipient  turns what was typed into an address, or explains why not
 *   getSendMax        the largest amount that can actually be sent
 *   prepareSend       assembles and returns what the user will review
 *   submitSend        signs the object that was reviewed, and nothing else
 *
 * The split between the last two is the important one. A single call that took
 * the form's inputs and signed immediately would give the user nothing to
 * review; one that re-sent the inputs on confirm would REBUILD, and a rebuild
 * seconds later can differ in fee, gas and nonce from what was on screen. The
 * user would confirm one transaction and sign another.
 *
 * `cancelSend` exists for the same reason the approval queue settles rejected
 * requests: preparing allocates a nonce, and a nonce that is never released
 * strands every later transaction from that account.
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

/** The account to send from, defaulting to the one the popup is showing. */
function resolveSender(context: RouterContext, requested: string | undefined): string {
  const address = requested ?? resolveSelectedAddress(context);
  if (!address) throw invalidParams("This wallet has no accounts.");

  const owned = listWalletAddresses(context);
  const match = owned.find((candidate) => candidate.toLowerCase() === address.toLowerCase());
  // The wallet can only sign for accounts it holds. Checked here rather than
  // relying on the keyring to fail later, so the error names the real problem.
  if (!match) throw invalidParams("That address does not belong to this wallet.");
  return match;
}

function resolveToken(
  context: RouterContext,
  tokenAddress: string | undefined,
): TokenDefinition | undefined {
  if (tokenAddress === undefined) return undefined;
  const chainId = context.networkService.getActiveChain().chainId;
  const token = context.tokenService.findToken(chainId, tokenAddress);
  /**
   * Only tokens this wallet KNOWS -- shipped, or imported by the user.
   *
   * Never an arbitrary address handed in with the request. Sending to one would
   * mean trusting whatever `decimals()` it reports at that moment, and a
   * contract can report anything: 6 while holding 18 turns a 1.00 send into a
   * 1,000,000,000,000.00 one. An imported token is safe here precisely because
   * its decimals were read once, shown to the user, and stored -- this path
   * uses the stored value and never asks the contract again.
   */
  if (!token) throw invalidParams("That token is not available on this network.");
  return token;
}

function parseAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw invalidParams("`amountBaseUnits` must be a decimal string of base units.");
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw invalidParams("Enter an amount greater than zero.");
  return amount;
}

// ---------------------------------------------------------------------------
// resolveRecipient
// ---------------------------------------------------------------------------

/**
 * Turns the recipient field into an address, or says why it could not.
 *
 * Runs on every keystroke's worth of settled input, so it must be cheap for the
 * common case: a pasted address never touches the network. Only something that
 * looks like a name goes to a resolver.
 */
export async function resolveRecipient(
  context: RouterContext,
  params: unknown,
): Promise<RecipientResolution> {
  const request = (params ?? {}) as ResolveRecipientRequestParams;
  const value = typeof request.value === "string" ? request.value.trim() : "";
  if (value === "") throw invalidParams("Enter a recipient.");

  if (isValidAddress(value)) {
    // Checksummed on the way out. The user may have pasted lowercase; showing
    // the checksummed form back is what makes a later visual comparison against
    // an explorer meaningful.
    return { kind: "address", address: toChecksumAddress(value) };
  }

  if (!isEnsNameCandidate(value)) {
    return {
      kind: "invalid",
      message: "That is not a valid Ethereum address or ENS name.",
    };
  }

  const chainId = request.chainId ?? context.networkService.getActiveChain().chainId;
  if (!context.networkService.supportsEnsNames(chainId)) {
    return { kind: "unresolved", reason: "names_unavailable" };
  }

  let normalized;
  try {
    normalized = normalizeEnsName(value);
  } catch (error) {
    // A name that fails ENSIP-15 has no correct interpretation. Refusing is the
    // only safe option -- resolving it anyway would resolve a name no registrar
    // legitimately issued, which is what a homograph attack needs.
    return {
      kind: "invalid",
      message:
        error instanceof InvalidEnsNameError
          ? error.message
          : "That name cannot be used with ENS.",
    };
  }

  const address = await context.networkService
    .getEnsResolver()
    .resolveName({ normalizedName: normalized.normalized, chainId });

  if (!address) return { kind: "unresolved", reason: "no_address_record" };

  return {
    kind: "name",
    address,
    normalizedName: normalized.normalized,
    wasNormalized: normalized.wasChanged,
  };
}

/** Address -> name, forward-verified. Used to label an address the user owns. */
export async function lookupName(
  context: RouterContext,
  params: unknown,
): Promise<{ name: string | undefined }> {
  const record = asRecord(params);
  const address = record["address"];
  if (typeof address !== "string" || !isValidAddress(address)) {
    throw invalidParams("`address` must be a valid Ethereum address.");
  }
  const chainId = context.networkService.getActiveChain().chainId;
  if (!context.networkService.supportsEnsNames(chainId)) return { name: undefined };

  return {
    name: await context.networkService
      .getEnsResolver()
      .lookupAddress({ address: toChecksumAddress(address), chainId }),
  };
}

// ---------------------------------------------------------------------------
// getSendMax
// ---------------------------------------------------------------------------

/**
 * The largest amount that can actually be sent.
 *
 * For a token this is simply the balance: the fee is paid in the native
 * currency, so the whole token balance is sendable.
 *
 * For the native currency it is the balance MINUS the reserved worst-case fee.
 * Putting the full balance in the value field produces a transaction that
 * cannot pay for itself and is rejected outright -- which is one of the easiest
 * things in a wallet to get wrong, and reads to the user as the wallet refusing
 * to send their own money. The CEILING is reserved rather than the expected
 * fee, so the transaction stays valid even if the base fee climbs before
 * inclusion; any unspent difference is refunded.
 */
export async function getSendMax(
  context: RouterContext,
  params: unknown,
): Promise<SendMaxResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as SendMaxRequestParams;
  const from = resolveSender(context, request.from);
  const chain = context.networkService.getActiveChain();
  // `resolveToken` reads an in-memory list. The worker's dispatch gate loads it
  // before any request runs, but this path must not depend on a guarantee made
  // three files away: an unloaded list makes an imported token look like an
  // unknown contract, and the user is told they cannot send something they can.
  await context.tokenService.load();
  const token = resolveToken(context, request.tokenAddress);
  const balanceReader = context.networkService.getBalanceReader(chain.chainId);

  if (token) {
    const balances = await balanceReader.readTokenBalances({
      address: from,
      chainId: chain.chainId,
      tokens: [token],
    });
    const amount = balances.get(token.address.toLowerCase()) ?? 0n;
    return {
      amountBaseUnits: amount.toString(),
      amountLabel: formatTokenAmountForDisplay(amount, token.decimals),
      symbol: token.symbol,
      decimals: token.decimals,
      reservedForFeeBaseUnits: "0",
    };
  }

  const [nativeBalance, fee] = await Promise.all([
    balanceReader.readNativeBalance({ address: from, chainId: chain.chainId }),
    resolveFeeEstimate(context.networkService.getNetworkReader(chain.chainId), {
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      gasPrice: undefined,
    }),
  ]);

  // 21000 exactly: a value transfer with empty calldata costs that by protocol
  // definition, so no estimate is needed and none is requested.
  const gasLimit = FALLBACK_GAS_LIMITS.nativeTransfer;
  const amount = computeSendMaxAmount({ nativeBalance, gasLimit, fee });
  const reserved = nativeBalance - amount;

  return {
    amountBaseUnits: amount.toString(),
    amountLabel: formatTokenAmountForDisplay(amount, chain.nativeCurrency.decimals),
    symbol: chain.nativeCurrency.symbol,
    decimals: chain.nativeCurrency.decimals,
    reservedForFeeBaseUnits: reserved.toString(),
  };
}

// ---------------------------------------------------------------------------
// prepareSend / submitSend / cancelSend
// ---------------------------------------------------------------------------

export async function prepareSend(
  context: RouterContext,
  params: unknown,
): Promise<PrepareSendResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as PrepareSendRequestParams;

  const from = resolveSender(context, request.from);
  const recipient = typeof request.recipient === "string" ? request.recipient.trim() : "";
  // Names are resolved by `resolveRecipient` before this point. Accepting one
  // here would mean resolving at confirm time, which is a different resolver
  // call than the one whose answer the user actually looked at.
  if (!isValidAddress(recipient)) {
    throw invalidParams("The recipient must be a resolved Ethereum address.");
  }

  await context.tokenService.load();
  const token = resolveToken(context, request.tokenAddress);
  const amount = parseAmount(request.amountBaseUnits);

  const prepared = await prepareTransaction({
    context,
    // The extension's own origin. Not a grantable origin, and the review screen
    // renders its own layout rather than a "this site is asking" header.
    origin: context.extensionOrigin,
    from,
    to: token ? token.address : recipient,
    // A token transfer moves nothing natively; the amount is in the calldata.
    value: token ? 0n : amount,
    data: token
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient as `0x${string}`, amount],
        })
      : undefined,
  });

  const presentation = prepared.presentation as TransactionApprovalPresentation;
  return {
    preparationId: context.preparedTransactions.store(prepared),
    presentation,
    transferLabel: `${formatTokenAmountForDisplay(
      prepared.transferSummary.amount,
      prepared.transferSummary.decimals,
    )} ${prepared.transferSummary.symbol}`,
  };
}

export async function submitSend(
  context: RouterContext,
  params: unknown,
): Promise<SubmitSendResult> {
  const request = (params ?? {}) as SubmitSendRequestParams;
  const preparationId =
    typeof request.preparationId === "string" ? request.preparationId : "";
  if (preparationId === "") throw invalidParams("`preparationId` is required.");

  // `take` REMOVES it. A preparation that could be submitted twice would
  // broadcast the same nonce twice, and the user would have no way to tell
  // which of the two they are waiting on.
  const prepared = context.preparedTransactions.take(preparationId);
  if (!prepared) {
    throw invalidParams(
      "This transaction is no longer valid. Fees move, so a review left open too long has to be rebuilt.",
    );
  }

  const transactionHash = await signAndBroadcastPrepared(context, prepared);
  return {
    transactionHash,
    explorerUrl: buildExplorerUrl(prepared.chain.blockExplorerUrl, transactionHash),
  };
}

export function cancelSend(context: RouterContext, params: unknown): { cancelled: boolean } {
  const record = asRecord(params);
  const preparationId = record["preparationId"];
  if (typeof preparationId !== "string") throw invalidParams("`preparationId` is required.");
  // Releases the nonce. Every path that abandons a preparation must reach here,
  // or the account is left with a gap nothing will ever fill.
  return { cancelled: context.preparedTransactions.discard(preparationId) };
}
