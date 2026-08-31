import {
  TokenMetadataChangedError,
  TokenNotReadableError,
  validateCustomToken,
} from "@/core/token/customToken";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import type { TokenDefinition } from "@/core/token/tokenRegistry";
import { isValidAddress, toChecksumAddress } from "@/core/account/ethereumAddress";
import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import type {
  ImportedTokenSummary,
  ImportTokenRequestParams,
  TokenClaimsResult,
  TokenListResult,
  TokenLookupRequestParams,
} from "@/core/messaging/walletApi";
import type { ChainDefinition } from "@/core/network/chain";
import { requireUnlocked, resolveSelectedAddress, type RouterContext } from "./routerContext";

/**
 * Adding, listing and removing user-imported ERC-20 tokens.
 *
 * ===========================================================================
 * TWO CALLS, AND THE SECOND ONE RE-READS
 * ===========================================================================
 * `lookupToken` shows the user what a contract claims. `importToken` stores it.
 * They are separate for the same reason `prepareSend` and `submitSend` are
 * separate: what the user agreed to must be what gets kept.
 *
 * The difference is what makes the split cheap here. A send needs a stored
 * preparation because fees and nonces drift with the clock. A token's decimals
 * do not drift -- they are either what the contract said or they are a lie --
 * so instead of holding a draft, `importToken` reads the contract AGAIN and
 * refuses if the answer changed. A contract that returns 6 to the preview and
 * 18 to the import is caught, and no state has to survive between the calls.
 *
 * ===========================================================================
 * THE CALLER NEVER SUPPLIES METADATA
 * ===========================================================================
 * `decimals` in the import request is not an input; it is the value the user
 * was shown, echoed back so it can be checked. Symbol, name and the stored
 * decimals all come from the fresh read. A caller that could hand over its own
 * metadata could register "USDC, 6 decimals" pointing at anything it liked.
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

function resolveChain(context: RouterContext, chainId: unknown): ChainDefinition {
  if (chainId === undefined || chainId === null) return context.networkService.getActiveChain();
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
    throw invalidParams("`chainId` must be a number.");
  }
  const chain = context.networkService.findChain(chainId);
  if (!chain) throw invalidParams(`Chain ${chainId} is not configured.`);
  return chain;
}

function readAddress(params: unknown): string {
  const value = asRecord(params)["address"];
  if (typeof value !== "string" || !isValidAddress(value)) {
    throw invalidParams("That is not a valid contract address.");
  }
  return toChecksumAddress(value);
}

function toSummary(token: TokenDefinition, networkLabel: string): ImportedTokenSummary {
  return {
    address: token.address,
    chainId: token.chainId,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    networkLabel,
  };
}

/**
 * Reads the user's balance of one token, tolerating a contract that refuses.
 *
 * A failed `balanceOf` is reported as zero rather than as an error: the import
 * screen's job is to show what the contract claims, and a balance that could
 * not be read must not stop the user seeing the decimals -- which is the field
 * the whole screen exists for.
 */
async function readSingleTokenBalance(
  context: RouterContext,
  token: TokenDefinition,
  address: string | undefined,
): Promise<bigint> {
  if (!address) return 0n;
  try {
    const balances = await context.networkService
      .getBalanceReader(token.chainId)
      .readTokenBalances({ address, chainId: token.chainId, tokens: [token] });
    return balances.get(token.address.toLowerCase()) ?? 0n;
  } catch {
    return 0n;
  }
}

/**
 * What a contract says it is, bounded and sanitised.
 *
 * Shared by the settings import screen and by EIP-747, so a site-initiated add
 * goes through exactly the checks a hand-typed address does. `symbol` and
 * `name` are attacker-controlled strings that end up rendered next to a
 * balance, which is why `validateCustomToken` runs before any of it reaches a
 * screen rather than after.
 */
export async function readTokenClaims(
  context: RouterContext,
  { address, chain }: { address: string; chain: ChainDefinition },
): Promise<TokenDefinition> {
  const claims = await context.networkService
    .getTokenMetadataReader(chain.chainId)
    .readTokenMetadata({ address, chainId: chain.chainId });

  if (claims.decimals === undefined) {
    throw new TokenNotReadableError(
      "This address did not answer as a token contract. Check it is the token's contract address on this network, not a wallet address or a website.",
    );
  }

  return validateCustomToken({
    address,
    chainId: chain.chainId,
    decimals: claims.decimals,
    symbol: claims.symbol,
    name: claims.name,
  });
}

/**
 * Stores a token the user has just reviewed, re-reading the contract first.
 *
 * The re-read is the check the two-call split exists for: a contract that
 * answers 6 to the preview and 18 to the import is caught here rather than
 * silently changing what every future amount means. `shownDecimals` is not an
 * input to what gets stored -- it is what the user was shown, echoed back so
 * the two can be compared.
 */
export async function addReviewedToken(
  context: RouterContext,
  { address, chain, shownDecimals }: { address: string; chain: ChainDefinition; shownDecimals: number },
): Promise<TokenDefinition> {
  const claims = await readTokenClaims(context, { address, chain });
  if (claims.decimals !== shownDecimals) throw new TokenMetadataChangedError();

  await context.tokenService.load();
  return context.tokenService.addToken({
    address,
    chainId: chain.chainId,
    decimals: claims.decimals,
    symbol: claims.symbol,
    name: claims.name,
  });
}

/** Public form of a stored token, for callers outside this module. */
export function toImportedTokenSummary(
  token: TokenDefinition,
  networkLabel: string,
): ImportedTokenSummary {
  return toSummary(token, networkLabel);
}

export { readSingleTokenBalance };

// ---------------------------------------------------------------------------
// wallet.lookupToken
// ---------------------------------------------------------------------------

export async function lookupToken(
  context: RouterContext,
  params: unknown,
): Promise<TokenClaimsResult> {
  requireUnlocked(context);
  const request = (params ?? {}) as TokenLookupRequestParams;
  const address = readAddress(params);
  const chain = resolveChain(context, request.chainId);
  const owner = resolveSelectedAddress(context);

  await context.tokenService.load();

  /**
   * A token the wallet already has is REPORTED, not refused.
   *
   * Pasting an address the wallet already knows is the commonest thing a
   * confused user does -- and answering "you already have this" is far more
   * useful than an error. The stored definition is returned as-is; the contract
   * is not consulted, because the stored metadata is the authoritative one.
   */
  const known = context.tokenService.findToken(chain.chainId, address);
  if (known) {
    const balance = await readSingleTokenBalance(context, known, owner);
    return {
      address: known.address,
      chainId: known.chainId,
      decimals: known.decimals,
      symbol: known.symbol,
      name: known.name,
      balanceBaseUnits: balance.toString(),
      balanceLabel: formatTokenAmountForDisplay(balance, known.decimals),
      isKnown: true,
      isBuiltIn: known.isBuiltIn,
      networkLabel: chain.name,
    };
  }

  const definition = await readTokenClaims(context, { address, chain });
  const balance = await readSingleTokenBalance(context, definition, owner);
  return {
    address: definition.address,
    chainId: definition.chainId,
    decimals: definition.decimals,
    symbol: definition.symbol,
    name: definition.name,
    balanceBaseUnits: balance.toString(),
    balanceLabel: formatTokenAmountForDisplay(balance, definition.decimals),
    isKnown: false,
    isBuiltIn: false,
    networkLabel: chain.name,
  };
}

// ---------------------------------------------------------------------------
// wallet.importToken
// ---------------------------------------------------------------------------

export async function importToken(
  context: RouterContext,
  params: unknown,
): Promise<{ token: ImportedTokenSummary }> {
  requireUnlocked(context);
  const request = (params ?? {}) as ImportTokenRequestParams;
  const address = readAddress(params);
  const chain = resolveChain(context, request.chainId);

  const shownDecimals = asRecord(params)["decimals"];
  if (typeof shownDecimals !== "number" || !Number.isInteger(shownDecimals)) {
    throw invalidParams("`decimals` must be the whole number the token was shown with.");
  }

  const token = await addReviewedToken(context, { address, chain, shownDecimals });
  return { token: toSummary(token, chain.name) };
}

// ---------------------------------------------------------------------------
// wallet.listTokens / wallet.removeToken
// ---------------------------------------------------------------------------

/** Imported tokens only. The built-ins are not a list the user manages. */
export async function listTokens(
  context: RouterContext,
  params: unknown,
): Promise<TokenListResult> {
  await context.tokenService.load();
  const record = params === undefined || params === null ? {} : asRecord(params);
  const scope = record["chainId"];

  const tokens = (
    scope === undefined || scope === null
      ? context.tokenService.listImportedTokens()
      : context.tokenService.listImportedTokens(resolveChain(context, scope).chainId)
  ).map((token) =>
    toSummary(token, context.networkService.findChain(token.chainId)?.name ?? "Unknown network"),
  );

  return { tokens };
}

export async function removeToken(
  context: RouterContext,
  params: unknown,
): Promise<{ removed: boolean }> {
  requireUnlocked(context);
  const address = readAddress(params);
  const chain = resolveChain(context, (params as { chainId?: unknown }).chainId);
  return { removed: await context.tokenService.removeToken(chain.chainId, address) };
}
