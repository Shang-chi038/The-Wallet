import type { PriceQuote, PriceReader } from "@/core/price/priceReader";

/**
 * CoinGecko-backed price feed.
 *
 * ===========================================================================
 * SYMBOL -> ID IS A HARDCODED TABLE, ON PURPOSE
 * ===========================================================================
 * CoinGecko's search endpoint would resolve a symbol to an id at runtime. We do
 * not use it, for the same reason `tokenRegistry` hardcodes contract addresses:
 * anyone can list a coin called "USDC", and a wallet that resolves prices by
 * symbol will happily price a user's real USDC using a scam token's chart. The
 * only assets we price are ones we shipped an id for.
 *
 * A missing entry means no price, which the UI renders as "unavailable". It
 * never means zero.
 */

const COIN_GECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether",
};

/**
 * Cache lifetime.
 *
 * The popup re-reads the portfolio on every open, and without a cache that is
 * one API call per open -- rate-limited within a day of normal use, and a
 * needless disclosure of activity timing to the price provider. Thirty seconds
 * is short enough that a user watching a move sees it, long enough that opening
 * and closing the popup repeatedly costs one request.
 */
export const PRICE_CACHE_TTL_MS = 30_000;

/** Kept short: the portfolio must render on time even if prices do not arrive. */
export const PRICE_REQUEST_TIMEOUT_MS = 4_000;

export interface CoinGeckoPriceReaderOptions {
  apiUrl: string;
  /** Demo/public key. Public by construction -- it ships in the bundle. */
  apiKey?: string | undefined;
  now?: () => number;
  fetchImplementation?: typeof fetch;
}

interface CachedPrices {
  prices: Map<string, PriceQuote>;
  fetchedAt: number;
}

export function createCoinGeckoPriceReader({
  apiUrl,
  apiKey,
  now = Date.now,
  fetchImplementation = fetch,
}: CoinGeckoPriceReaderOptions): PriceReader {
  let cache: CachedPrices | undefined;
  let inFlight: Promise<Map<string, PriceQuote>> | undefined;

  return {
    async readPrices(symbols) {
      const wanted = symbols
        .map((symbol) => symbol.toUpperCase())
        .filter((symbol) => symbol in COIN_GECKO_IDS);
      if (wanted.length === 0) return new Map();

      if (cache && now() - cache.fetchedAt < PRICE_CACHE_TTL_MS) {
        return new Map(cache.prices);
      }
      // Collapse concurrent callers onto one request. The popup and a portfolio
      // refresh firing together should not cost two API calls.
      if (inFlight) return new Map(await inFlight);

      inFlight = fetchPrices({ wanted, apiUrl, apiKey, fetchImplementation })
        .then((prices) => {
          cache = { prices, fetchedAt: now() };
          return prices;
        })
        .catch(() => {
          // A price failure is not a wallet failure. Return no prices and let
          // the UI say so; never surface this as an error the user must dismiss
          // before seeing their balances.
          return new Map<string, PriceQuote>();
        })
        .finally(() => {
          inFlight = undefined;
        });

      return new Map(await inFlight);
    },
  };
}

interface FetchPricesParams {
  wanted: string[];
  apiUrl: string;
  apiKey: string | undefined;
  fetchImplementation: typeof fetch;
}

async function fetchPrices({
  wanted,
  apiUrl,
  apiKey,
  fetchImplementation,
}: FetchPricesParams): Promise<Map<string, PriceQuote>> {
  const idBySymbol = new Map(wanted.map((symbol) => [COIN_GECKO_IDS[symbol] as string, symbol]));
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/simple/price`);
  url.searchParams.set("ids", [...idBySymbol.keys()].join(","));
  url.searchParams.set("vs_currencies", "usd");
  // Asked for in the same request rather than a second call. The change figure
  // is shown directly beneath the balance, and a wallet that renders a stale or
  // invented one is lying about the only number on that screen the user cannot
  // check for themselves.
  url.searchParams.set("include_24hr_change", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(url.toString(), {
      signal: controller.signal,
      headers: apiKey ? { "x-cg-demo-api-key": apiKey } : {},
    });
    if (!response.ok) return new Map();

    const body = (await response.json()) as Record<
      string,
      { usd?: unknown; usd_24h_change?: unknown }
    >;
    const prices = new Map<string, PriceQuote>();
    for (const [id, symbol] of idBySymbol) {
      const entry = body[id];
      const usd = entry?.usd;
      // Only a finite positive number is a price. A null, a string or a zero is
      // an absent price, and must not be cached as if it were real.
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;

      const change = entry?.usd_24h_change;
      prices.set(symbol, {
        price: usd,
        change24hPercent:
          typeof change === "number" && Number.isFinite(change) ? change : undefined,
      });
    }
    return prices;
  } finally {
    clearTimeout(timeout);
  }
}
