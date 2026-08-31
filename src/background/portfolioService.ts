import type { BalanceReader, PortfolioEntry } from "@/core/balance/balanceReader";
import { sortPortfolioForDisplay } from "@/core/balance/balanceReader";
import {
  computeFiatValue,
  computePortfolioChange,
  sumFiatValues,
  type PriceQuote,
  type PriceReader,
} from "@/core/price/priceReader";
import { formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import { listBuiltInTokens, type TokenDefinition } from "@/core/token/tokenRegistry";
import { toChainSummary, type PortfolioResult, type PortfolioEntryResult } from "@/core/messaging/walletApi";
import type { ChainDefinition } from "@/core/network/chain";

/**
 * Assembles the portfolio the popup renders.
 *
 * ===========================================================================
 * PARTIAL RESULTS ARE THE NORMAL CASE
 * ===========================================================================
 * Three independent things can fail here: the native balance call, the token
 * balance multicall, and the price feed. Treating any of them as fatal would
 * mean a user with a perfectly readable ETH balance sees an error screen
 * because a price API was slow.
 *
 * So each is degraded independently:
 *   native balance fails  -> the whole read fails (there is no portfolio without it)
 *   a token balance fails -> that token is omitted, the rest render
 *   prices fail           -> balances render, fiat is `undefined`, and the UI
 *                            says prices are unavailable
 *
 * The last one is the important one: `undefined`, never `0`. See the header of
 * core/price/priceReader.ts.
 *
 * ===========================================================================
 * NO CACHING HERE
 * ===========================================================================
 * Balances are read live on every request. A cached balance is a number that
 * was true at some point in the past, displayed without saying when -- and a
 * user deciding whether they can afford to send needs the current figure. The
 * price reader caches; the chain reads do not.
 *
 * ===========================================================================
 * IMPORTED TOKENS ARE NEVER PRICED
 * ===========================================================================
 * Not "priced if we happen to have a quote" -- never, and for two independent
 * reasons, either of which would be sufficient on its own.
 *
 *   SPOOFING. Quotes are keyed by SYMBOL. A contract can call itself "USDC",
 *   and anyone can deploy one and talk a user into importing it. Looking that
 *   symbol up would find the real USDC's price and render a worthless holding
 *   of a million tokens as a million dollars -- the wallet stating, in its
 *   largest type, a number that is false.
 *
 *   PRIVACY. `priceReader` queries a FIXED symbol list per chain precisely so
 *   the request looks identical whether or not the user holds anything. Adding
 *   an imported token's symbol would put the user's specific, unusual holding
 *   into an outbound request to a third party.
 *
 * So the symbol never leaves in a request AND the quote map is never consulted
 * for one. Filtering only the outbound list would leave the second half of the
 * spoof working, because the real USDC's quote is already in the map.
 *
 * The consequence is that an imported token has no fiat value, permanently and
 * by design. That is reported as `fiatStatus: "unpriced"` rather than as a
 * failed lookup, and such entries are left OUT of the portfolio total and the
 * 24h change instead of poisoning both -- an unvalued holding must not turn the
 * hero figure into "unavailable" for as long as the user keeps it.
 */

export interface PortfolioServiceOptions {
  balanceReader: BalanceReader;
  priceReader: PriceReader;
  now?: () => number;
}

export interface ReadPortfolioParams {
  address: string;
  chain: ChainDefinition;
  /** Defaults to the built-in token list for the chain. */
  tokens?: readonly TokenDefinition[];
}

export async function readPortfolio(
  { balanceReader, priceReader, now = Date.now }: PortfolioServiceOptions,
  { address, chain, tokens }: ReadPortfolioParams,
): Promise<PortfolioResult> {
  const tokenList = tokens ?? listBuiltInTokens(chain.chainId);

  // Prices are requested for a FIXED list rather than the user's actual
  // holdings, so the request looks identical whether or not they own a token.
  // Built-ins only: an imported token's symbol is the user's own business and
  // does not go into an outbound request.
  const priceSymbols = [
    chain.nativeCurrency.symbol,
    ...tokenList.filter((token) => token.isBuiltIn).map((token) => token.symbol),
  ];

  const [nativeAmount, tokenAmounts, prices] = await Promise.all([
    balanceReader.readNativeBalance({ address, chainId: chain.chainId }),
    balanceReader
      .readTokenBalances({ address, chainId: chain.chainId, tokens: tokenList })
      .catch(() => new Map<string, bigint>()),
    priceReader.readPrices(priceSymbols).catch(() => new Map<string, PriceQuote>()),
  ]);

  const entries: PortfolioEntry[] = [
    {
      token: "native",
      amount: nativeAmount,
      decimals: chain.nativeCurrency.decimals,
      symbol: chain.nativeCurrency.symbol,
    },
    ...tokenList
      // A token whose balanceOf call failed is ABSENT from the map. Omitting it
      // is honest; rendering it as 0 would claim the user holds none, which we
      // do not know.
      .filter((token) => tokenAmounts.has(token.address.toLowerCase()))
      .map((token) => ({
        token,
        amount: tokenAmounts.get(token.address.toLowerCase()) as bigint,
        decimals: token.decimals,
        symbol: token.symbol,
      })),
  ];

  const priced = sortPortfolioForDisplay(entries).map((entry) => {
    const isImported = entry.token !== "native" && !entry.token.isBuiltIn;
    // The gate that actually stops the spoof. Filtering `priceSymbols` alone
    // would not: a token calling itself "USDC" would still find the real
    // USDC's quote sitting in this map, put there by the built-in entry.
    const quote = isImported ? undefined : prices.get(entry.symbol.toUpperCase());
    const fiatValue = computeFiatValue(entry.amount, entry.decimals, quote?.price);
    return {
      entry,
      isImported,
      fiatValue,
      change24hPercent: quote?.change24hPercent,
      fiatStatus: isImported
        ? ("unpriced" as const)
        : fiatValue === undefined
          ? ("unavailable" as const)
          : ("priced" as const),
    };
  });

  // Excluded from both aggregates rather than counted as missing.
  // `sumFiatValues` and `computePortfolioChange` both refuse to answer when any
  // held entry lacks a value -- correct for a price feed that failed, wrong for
  // an asset that has no price by design.
  const aggregated = priced.filter((row) => !row.isImported);

  return {
    address,
    chain: toChainSummary(chain),
    entries: priced.map(({ entry, fiatValue, fiatStatus, isImported }) =>
      toEntryResult(entry, { fiatValue, fiatStatus, isImported }, chain),
    ),
    totalFiatValue: sumFiatValues(
      aggregated.map(({ entry, fiatValue }) => ({ amount: entry.amount, fiatValue })),
    ),
    // Weighted by holding value, not averaged across assets -- see
    // computePortfolioChange for why the obvious calculation is wrong, and why
    // "no change" carries a reason rather than being a bare undefined.
    change: computePortfolioChange(
      aggregated.map(({ entry, fiatValue, change24hPercent }) => ({
        amount: entry.amount,
        fiatValue,
        change24hPercent,
      })),
    ),
    fiatCurrency: "USD",
    fetchedAt: now(),
  };
}

function toEntryResult(
  entry: PortfolioEntry,
  fiat: {
    fiatValue: number | undefined;
    fiatStatus: PortfolioEntryResult["fiatStatus"];
    isImported: boolean;
  },
  chain: ChainDefinition,
): PortfolioEntryResult {
  const isNative = entry.token === "native";
  return {
    kind: isNative ? "native" : "token",
    symbol: entry.symbol,
    name: isNative ? chain.nativeCurrency.name : (entry.token as TokenDefinition).name,
    // Decimal string, not bigint and never a number: see walletApi.ts.
    amountBaseUnits: entry.amount.toString(),
    decimals: entry.decimals,
    // Truncated toward zero, and "<0.000001" rather than "0" for a tiny but
    // real balance -- a wallet must never round a user's holdings away.
    balanceLabel: formatTokenAmountForDisplay(entry.amount, entry.decimals),
    fiatValue: fiat.fiatValue,
    fiatStatus: fiat.fiatStatus,
    isImported: fiat.isImported,
    networkLabel: chain.name,
    tokenAddress: isNative ? undefined : (entry.token as TokenDefinition).address,
  };
}
