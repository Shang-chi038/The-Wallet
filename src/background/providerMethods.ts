import { toHexChainId } from "@/core/network/chain";
import { listGrantedAddresses } from "@/core/messaging/originPermissions";
import { assessOriginRisk } from "@/core/security/originRisk";
import {
  unauthorizedError,
  unrecognizedChainError,
  unsupportedMethodError,
  userRejectedError,
} from "@/core/messaging/protocol";
import { toChainSummary } from "@/core/messaging/walletApi";
import {
  parseAddChainParams,
  parsePersonalSignParams,
  parseSendTransactionParams,
  parseSwitchChainParams,
  parseTypedDataParams,
  parseWatchAssetParams,
} from "@/core/messaging/requestParams";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import { createPersonalMessagePreview } from "@/core/signing/messageSigning";
import {
  assertDomainMatchesChain,
  assessTypedDataWarnings,
  createTypedDataPreview,
} from "@/core/signing/typedDataSigning";
import {
  signPersonalMessageRequest,
  signTypedDataRequest,
} from "@/core/signing/signingService";
import type { DraftApprovalPresentation } from "@/core/approval/approvalRequest";
import { addReviewedToken, readSingleTokenBalance, readTokenClaims } from "./tokenMethods";
import {
  prepareTransaction,
  releasePreparedNonce,
  signAndBroadcastPrepared,
} from "./transactionPreparation";
import {
  assertOriginMayUseAccount,
  listAccountsVisibleToOrigin,
  listWalletAddresses,
  originHasStandingGrantFor,
  requireUnlocked,
  resolveSelectedAddress,
  type RouterContext,
} from "./routerContext";

/**
 * The EIP-1193 surface, reachable from any website.
 *
 * ===========================================================================
 * THE SHAPE OF EVERY HANDLER HERE
 * ===========================================================================
 * Every method that can move value or produce a signature follows the same four
 * steps, in this order, and the order is the security property:
 *
 *   1. PARSE      hostile params into validated values (core/messaging/requestParams)
 *   2. AUTHORISE  against the origin's grant, not against the request's claims
 *   3. RESOLVE    everything the transaction needs -- fee, gas, nonce, balance --
 *                 and fail here if it cannot succeed, BEFORE prompting
 *   4. APPROVE    show the resolved object, then sign THAT OBJECT, re-checking
 *                 authorisation immediately before the key is lent
 *
 * Step 3 before step 4 is a user-safety decision as much as a technical one:
 * prompting for a transaction the wallet already knows will fail trains people
 * to click through warnings, and burns a real fee when it reverts on chain.
 *
 * The re-check in step 4 is not redundant with step 2. An approval can sit in
 * the queue for minutes, and in that time the user can revoke the grant, lock
 * the wallet, or reset it onto a different recovery phrase. Authorisation
 * granted at queue time is not authorisation at signing time.
 *
 * ===========================================================================
 * ORIGIN
 * ===========================================================================
 * The `origin` argument was stamped by the content script from the real
 * document and normalised by the router. It never came from the message body.
 * Everything below -- every grant, every prompt -- is anchored to it.
 */

export interface ProviderMethodParams {
  context: RouterContext;
  method: string;
  params: unknown;
  origin: string;
}

export async function handleProviderMethod({
  context,
  method,
  params,
  origin,
}: ProviderMethodParams): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return toHexChainId(context.networkService.getActiveChain().chainId);
    case "net_version":
      return String(context.networkService.getActiveChain().chainId);
    case "eth_accounts":
      return toWireAddresses(listAccountsVisibleToOrigin(context, origin));
    case "eth_requestAccounts":
      return requestAccounts(context, origin);
    case "personal_sign":
      return personalSign(context, origin, params);
    case "eth_signTypedData_v4":
      return signTypedData(context, origin, params);
    case "eth_sendTransaction":
      return sendTransaction(context, origin, params);
    case "wallet_switchEthereumChain":
      return switchEthereumChain(context, origin, params);
    case "wallet_addEthereumChain":
      return addEthereumChain(context, origin, params);
    case "wallet_watchAsset":
      return watchAsset(context, origin, params);
    default:
      throw unsupportedMethodError(method);
  }
}

/**
 * Addresses as dApps expect them: LOWERCASE.
 *
 * Not cosmetic. dApps cache the array from `eth_accounts` and compare later
 * values with `===` or `Array.includes`. Returning EIP-55 checksummed addresses
 * from one call and lowercase from another makes a connected site decide the
 * account changed when it did not, and disconnect the user mid-flow. Every
 * mainstream wallet returns lowercase on this surface, so we match it.
 *
 * Internally, and everywhere a human reads an address, we use checksummed form.
 */
function toWireAddresses(addresses: readonly string[]): string[] {
  return addresses.map((address) => address.toLowerCase());
}

/**
 * The fields every prompt carries, including what the wallet knows about the
 * origin.
 *
 * Assessed HERE, once, at the single point every approval is built from -- not
 * per handler. A per-handler call is a per-handler omission waiting to happen,
 * and the screen it would go missing from is whichever one someone adds next.
 *
 * The reference set for lookalike detection is the user's own connection list:
 * domains they have already decided to trust. `listGrants` reads the permission
 * store, which is loaded before any request is routed.
 */
function baseApproval(context: RouterContext, origin: string) {
  return {
    origin,
    originRisk: assessOriginRisk({
      origin,
      connectedOrigins: Object.keys(context.permissionStore.getState().grants),
    }),
    createdAt: context.now(),
    chain: toChainSummary(context.networkService.getActiveChain()),
  };
}

/**
 * Queues an approval and converts anything short of "yes" into 4001.
 *
 * All rejection reasons collapse to the same code on purpose. A dApp only needs
 * to know that no signature happened; whether the user declined, closed the
 * window or let it expire is the wallet's business, and reporting it back would
 * tell a hostile site how the user behaves when prompted.
 */
async function requireApproval(
  context: RouterContext,
  presentation: DraftApprovalPresentation,
  payload: unknown,
): Promise<string[]> {
  const decision = await context.approvalService.requestApproval({ presentation, payload });
  if (!decision.approved) throw userRejectedError();
  return decision.accounts;
}

// ---------------------------------------------------------------------------
// eth_requestAccounts
// ---------------------------------------------------------------------------

/**
 * Connect.
 *
 * Returns early only when the wallet is unlocked AND the origin already holds a
 * usable grant, which is what makes a page refresh on a connected dApp silent
 * rather than another prompt.
 *
 * Everything else -- locked, no grant, no wallet at all -- goes to the approval
 * window. Note what that avoids: distinguishing "no wallet set up" with its own
 * error would tell every site the user visits whether they have a wallet, which
 * is precisely the fact `eth_accounts` returning [] is careful not to leak. The
 * approval window handles setup, unlock and account selection as three states
 * of one screen, so the page cannot tell them apart.
 */
async function requestAccounts(context: RouterContext, origin: string): Promise<string[]> {
  const alreadyVisible = listAccountsVisibleToOrigin(context, origin);
  if (context.walletService.isUnlocked() && alreadyVisible.length > 0) {
    return toWireAddresses(alreadyVisible);
  }

  const selected = resolveSelectedAddress(context);
  const chosen = await requireApproval(
    context,
    {
      ...baseApproval(context, origin),
      kind: "connect",
      // The currently selected account only. Defaulting to ALL of them would
      // quietly undo the reason people keep separate accounts, on the one
      // screen where the choice is supposed to be theirs.
      defaultSelectedAddresses: selected ? [selected] : [],
      // True when the site is asking again -- either it holds a grant we cannot
      // currently satisfy (locked), or it is widening one it already has.
      isReconnect:
        alreadyVisible.length > 0 || listGrantedAddresses(
          context.permissionStore.getState(),
          origin,
        ).length > 0,
    },
    undefined,
  );

  // The approval window is a privileged page, but "privileged" is not
  // "infallible". Validate the returned addresses against the keyring anyway: a
  // bug in our own UI must not be able to grant a site an address the wallet
  // does not own, and this is the only place that can catch it.
  const owned = listWalletAddresses(context);
  const granted = chosen.filter((address) =>
    owned.some((candidate) => candidate.toLowerCase() === address.toLowerCase()),
  );
  if (granted.length === 0) throw userRejectedError();

  await context.permissionStore.grant(origin, granted);
  await context.providerEvents.broadcastAccountsChanged();
  return toWireAddresses(granted);
}

/**
 * The gate in front of every signing method.
 *
 * Prompting is allowed when the origin's grant NAMES the address, even if the
 * wallet is locked and the live account list is therefore empty -- otherwise a
 * connected dApp asking a locked wallet to sign gets a flat `unauthorized`
 * instead of an unlock prompt, and the user sees a site that says "connected"
 * next to a wallet that says "no". The real authorisation check runs again,
 * against live accounts, after the user has unlocked and approved.
 */
function assertMayPromptForAccount(
  context: RouterContext,
  origin: string,
  address: string,
): void {
  if (originHasStandingGrantFor(context, origin, address)) return;
  throw unauthorizedError("this account");
}

// ---------------------------------------------------------------------------
// personal_sign
// ---------------------------------------------------------------------------

async function personalSign(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<string> {
  const { address, payload } = parsePersonalSignParams(params);
  assertMayPromptForAccount(context, origin, address);

  const preview = createPersonalMessagePreview(payload);
  await requireApproval(
    context,
    {
      ...baseApproval(context, origin),
      kind: "personalSign",
      address,
      displayText: preview.displayText,
      isBinary: preview.isBinary,
      byteLength: preview.byteLength,
    },
    payload,
  );

  requireUnlocked(context);
  assertOriginMayUseAccount(context, origin, address);

  // The exact payload the preview was built from. Not re-read from the message,
  // not reconstructed -- the same string, closed over since parse time.
  const signature = await signPersonalMessageRequest({
    keyring: context.walletService.getKeyring(),
    address,
    payload,
  });
  return signature.hex;
}

// ---------------------------------------------------------------------------
// eth_signTypedData_v4
// ---------------------------------------------------------------------------

async function signTypedData(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<string> {
  const { address, definition } = parseTypedDataParams(params);
  assertMayPromptForAccount(context, origin, address);

  const activeChainId = context.networkService.getActiveChain().chainId;
  // Cross-chain replay check runs BEFORE the prompt. A payload whose domain
  // names another chain is refused outright rather than shown to the user --
  // there is no version of that request we are willing to sign, so asking would
  // only teach them that declining is optional.
  assertDomainMatchesChain(definition, activeChainId);

  const domain = (definition.domain ?? {}) as Record<string, unknown>;
  await requireApproval(
    context,
    {
      ...baseApproval(context, origin),
      kind: "typedData",
      address,
      primaryType: definition.primaryType,
      domainName: typeof domain["name"] === "string" ? domain["name"] : undefined,
      verifyingContract:
        typeof domain["verifyingContract"] === "string" ? domain["verifyingContract"] : undefined,
      fields: createTypedDataPreview(definition),
      // Assessed from the SAME `definition` the preview and the signature come
      // from. Re-deriving it from anything else would reintroduce exactly the
      // preview/payload split this file exists to avoid.
      warnings: assessTypedDataWarnings({ definition, now: context.now() }),
    },
    definition,
  );

  requireUnlocked(context);
  assertOriginMayUseAccount(context, origin, address);

  const signature = await signTypedDataRequest({
    keyring: context.walletService.getKeyring(),
    address,
    definition,
    activeChainId,
  });
  return signature.hex;
}

// ---------------------------------------------------------------------------
// eth_sendTransaction
// ---------------------------------------------------------------------------

async function sendTransaction(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<string> {
  const request = parseSendTransactionParams(params);
  assertMayPromptForAccount(context, origin, request.from);

  /**
   * Assembled by the SHARED preparation path -- the same one the wallet's own
   * send form uses. Two builders for one transaction is how a preview and a
   * payload drift apart, so there is exactly one, and it resolves fee, gas,
   * nonce and affordability before any prompt appears.
   */
  const prepared = await prepareTransaction({
    context,
    origin,
    from: request.from,
    to: request.to,
    value: request.value,
    data: request.data,
    gasLimit: request.gasLimit,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    gasPrice: request.gasPrice,
    nonce: request.nonce,
  });

  try {
    // The payload handed to the queue is the prepared transaction itself, so
    // what the user sees and what gets signed are one object.
    await requireApproval(context, prepared.presentation, prepared.transaction);
    return await signAndBroadcastPrepared(context, prepared, { origin });
  } catch (error) {
    // ANY exit without a broadcast returns the nonce to the pool. Skipping this
    // is what creates gaps: every later transaction from this account would
    // queue behind a nonce that will never appear on chain, and the wallet
    // would look frozen with nothing to explain it.
    releasePreparedNonce(context, prepared);
    throw error;
  }
}


// ---------------------------------------------------------------------------
// wallet_watchAsset (EIP-747)
// ---------------------------------------------------------------------------

/**
 * A site asking for a token to show up in the wallet.
 *
 * ===========================================================================
 * THE PAGE PICKS THE ADDRESS AND NOTHING ELSE
 * ===========================================================================
 * `parseWatchAssetParams` drops the `symbol` and `decimals` EIP-747 allows the
 * caller to send. Everything the user is shown, and everything that gets
 * stored, comes from reading the contract -- the same path a hand-typed
 * address takes through the settings screen. A site that could name its own
 * token would register "USDC, 6 decimals" against a contract it wrote, and the
 * result would be indistinguishable from the real thing in the list the user
 * picks from when sending.
 *
 * ===========================================================================
 * WHAT THE RESULT MEANS
 * ===========================================================================
 * EIP-747 returns a boolean, and both branches are honest here: `true` once the
 * token is in the wallet, and a 4001 rejection when the user says no. A token
 * the wallet ALREADY has returns `true` without prompting -- the site is asking
 * for a state that already holds, and re-prompting on every page load is how a
 * dApp trains its users to click through wallet dialogs.
 *
 * The token lands as an IMPORTED token, which means it is never priced. That is
 * the rule that matters most here: a site-suggested token is exactly the case
 * the never-price rule was written for.
 */
async function watchAsset(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<boolean> {
  const { address } = parseWatchAssetParams(params);
  const chain = context.networkService.getActiveChain();

  /**
   * CONNECTED SITES ONLY, and the gate is here rather than after the prompt.
   *
   * Everything below reads a contract over the network, with an address the
   * PAGE chose. Ungated, any site the user merely visits could make the wallet
   * issue RPC calls on demand -- traffic the user did not ask for, billed to
   * this wallet's rate-limit key, from their IP. Every other page-reachable
   * method either answers from memory or requires a grant first; this one was
   * the exception.
   *
   * The cost is nil in practice. A site with a token to suggest is a site the
   * user is using, and a stranger suggesting a token is not a flow worth
   * supporting. Reported as `unauthorized` because the caller genuinely lacks
   * permission for its own request -- unlike a page-blocked wallet method,
   * where the code has to avoid confirming the method exists at all.
   */
  if (listAccountsVisibleToOrigin(context, origin).length === 0) {
    throw unauthorizedError("wallet_watchAsset");
  }

  await context.tokenService.load();
  const known = context.tokenService.findToken(chain.chainId, address);
  if (known) return true;

  // Read before prompting: the prompt has nothing to say about a contract that
  // does not answer as a token, and a user cannot be asked to judge an address.
  const claims = await readTokenClaims(context, { address, chain });

  /**
   * The balance is shown when it can be, and its absence is not an error.
   *
   * It is the single most useful thing on the screen -- a site suggesting a
   * token the user already holds is a different proposition from one suggesting
   * a token they have never seen -- but a locked wallet does not know the
   * account, and the request must not turn into an unlock prompt for a token
   * suggestion.
   */
  const owner = context.walletService.isUnlocked() ? resolveSelectedAddress(context) : undefined;
  const balance = await readSingleTokenBalance(context, claims, owner);

  await requireApproval(
    context,
    {
      ...baseApproval(context, origin),
      kind: "watchAsset",
      token: {
        address: claims.address,
        symbol: claims.symbol,
        name: claims.name,
        decimals: claims.decimals,
        networkLabel: chain.name,
      },
      balanceLabel: owner ? formatTokenAmountForDisplay(balance, claims.decimals) : undefined,
      isKnown: false,
    },
    claims,
  );

  // Re-reads the contract and refuses if `decimals` moved between the prompt
  // and the answer -- the same check the settings import makes, for the same
  // reason. An approval can sit in the queue for minutes.
  await addReviewedToken(context, { address, chain, shownDecimals: claims.decimals });
  return true;
}

// ---------------------------------------------------------------------------
// wallet_switchEthereumChain / wallet_addEthereumChain
// ---------------------------------------------------------------------------

async function switchEthereumChain(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<null> {
  const chainId = parseSwitchChainParams(params);
  if (chainId === context.networkService.getActiveChain().chainId) return null;

  const target = context.networkService.findChain(chainId);
  // 4902, not a generic failure. It is the dApp's cue to call
  // wallet_addEthereumChain and retry, which is how every network-switching
  // site is written. Returning anything else strands them.
  if (!target) throw unrecognizedChainError(chainId);

  await requireApproval(
    context,
    { ...baseApproval(context, origin), kind: "switchChain", targetChain: toChainSummary(target) },
    target,
  );

  await context.networkService.setActiveChain(target.chainId);
  await context.providerEvents.broadcastChainChanged(toHexChainId(target.chainId));
  return null;
}

async function addEthereumChain(
  context: RouterContext,
  origin: string,
  params: unknown,
): Promise<null> {
  const request = parseAddChainParams(params);

  const existing = context.networkService.findChain(request.chainId);
  if (existing) {
    // Already known. Treat as a switch rather than a duplicate add, which is
    // what EIP-3085 expects and what stops a site re-prompting on every load.
    return switchEthereumChain(context, origin, [{ chainId: toHexChainId(request.chainId) }]);
  }

  /**
   * CONNECTED SITES ONLY, and the gate is here rather than after the prompt --
   * the same rule, for the same reason, as `wallet_watchAsset` above.
   *
   * Everything below this line reaches the NETWORK, at a URL the PAGE chose.
   * `prepareCustomChain` asks the proposed endpoint for its own chain id, and
   * that request happens before any approval window can open. Ungated, any
   * site the user merely visits could make the wallet connect to a host of the
   * site's choosing -- from the user's IP, with this extension's `<all_urls>`
   * access -- with no prompt ever appearing.
   *
   * Worse than the watchAsset case it mirrors, because there the page chose an
   * address the wallet looked up on ITS OWN configured RPC; here the page
   * chooses the destination. And it was unbounded: an endpoint answering with
   * a mismatched chain id throws before anything is queued, so the approval
   * queue's per-origin cap never engaged and the call could be repeated
   * without limit.
   *
   * Placed AFTER the `existing` check on purpose. A site asking to switch to a
   * network the wallet already has makes no outbound request, and EIP-3326's
   * flow -- switch, get 4902, add, retry -- should keep working for a site
   * that has not connected yet.
   */
  if (listAccountsVisibleToOrigin(context, origin).length === 0) {
    throw unauthorizedError("wallet_addEthereumChain");
  }

  // Both checks before the prompt. `prepareCustomChain` refuses to redefine a
  // built-in chain, requires https to a publicly routable host, and asks the
  // proposed endpoint for its OWN chain id -- an RPC claiming to be mainnet
  // while serving something else is the attack this exists to stop, and the
  // user cannot be expected to catch it by reading a URL.
  const definition = await context.networkService.prepareCustomChain({
    chainId: request.chainId,
    name: request.chainName,
    rpcUrl: request.rpcUrl,
    ...(request.nativeCurrency ? { nativeCurrency: request.nativeCurrency } : {}),
    ...(request.blockExplorerUrl ? { blockExplorerUrl: request.blockExplorerUrl } : {}),
  });

  await requireApproval(
    context,
    {
      ...baseApproval(context, origin),
      kind: "addChain",
      targetChain: toChainSummary(definition),
      rpcUrl: request.rpcUrl,
      isRpcVerified: true,
    },
    definition,
  );

  await context.networkService.addCustomChain(definition);
  await context.networkService.setActiveChain(definition.chainId);
  await context.providerEvents.broadcastChainChanged(toHexChainId(definition.chainId));
  return null;
}
