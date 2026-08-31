import { createPublicClient, http, fallback, type PublicClient } from "viem";
import type { ChainDefinition } from "@/core/network/chain";

/**
 * JSON-RPC transport.
 *
 * PRIVACY NOTE, stated plainly because users deserve to know: every balance
 * query tells the RPC provider which addresses belong to one wallet, and every
 * broadcast tells them the origin IP of a transaction. A default hosted
 * provider therefore sees a meaningful slice of the user's activity. This is
 * true of every mainstream wallet, and it is why Settings must expose a custom
 * RPC field prominently rather than burying it.
 *
 * The API key in the URL is not a secret — it ships inside the extension and is
 * extractable by anyone. It is a rate-limit identifier. Restrict it by
 * allowed-origin in the provider dashboard and rotate on abuse.
 */

export interface RpcClientOptions {
  chain: ChainDefinition;
  /** Full endpoint URLs, in priority order. */
  rpcUrls: string[];
  /** Per-request deadline. See DEFAULT_RPC_TIMEOUT_MS for the budget. */
  timeoutMs?: number;
}

/**
 * ===========================================================================
 * WHY THIS IS 20s AND NOT THE 10s IT WAS
 * ===========================================================================
 * The old value was chosen so the UI could never hang on a dead RPC, which is
 * still the right instinct and was the wrong number. Measured against the
 * configured Alchemy endpoints from a connection whose DNS is intercepted, the
 * TLS handshake completes in 0.8s and the first response arrives in 10.9s --
 * a cold connection costs about eleven seconds before anything is wrong. A
 * ten-second deadline therefore failed EVERY first request on that network,
 * with three attempts each, and reported it as an unreachable endpoint.
 *
 * A deadline shorter than the connection it is timing does not protect the UI;
 * it just guarantees the failure. 20s clears a cold connect with room, and
 * subsequent requests reuse the socket and land in the usual tens of
 * milliseconds.
 *
 * The retry count drops from two to one to pay for it. Total budget goes from
 * 3 x 10s to 2 x 20s -- 40s against 30s, a worse worst case for a genuinely
 * dead endpoint, in exchange for attempts that can actually succeed on a slow
 * one. The nothing-works case was already lost; the slow case was not.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export function createRpcClient({
  chain,
  rpcUrls,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
}: RpcClientOptions): PublicClient {
  if (rpcUrls.length === 0) {
    throw new Error(`No RPC endpoint configured for chain ${chain.chainId}.`);
  }

  const transports = rpcUrls.map((url) =>
    http(url, {
      timeout: timeoutMs,
      // One retry with backoff. Hosted RPCs return transient 429s under load,
      // and a spurious "network error" in a wallet reads as lost funds -- but
      // see the timeout note above for why this is one and not two.
      retryCount: 1,
      retryDelay: 250,
    }),
  );

  return createPublicClient({
    // `fallback` moves to the next endpoint when one fails, which is why the
    // config takes a list. A single point of RPC failure is a single point of
    // wallet failure.
    transport: transports.length === 1 ? transports[0]! : fallback(transports),
    chain: {
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: rpcUrls } },
    },
    // Batch eth_call into multicall where possible. Fetching 20 token balances
    // as 20 round trips is slow and burns rate limit; as one multicall it is a
    // single request.
    batch: { multicall: true },
  });
}

/**
 * Resolves the configured RPC URL for a chain, appending the build-time API key
 * when the URL is a key-suffixed base.
 */
export function resolveRpcUrls(chain: ChainDefinition, apiKey: string | undefined): string[] {
  return chain.rpcUrls.map((url) => (url.endsWith("/v2/") && apiKey ? `${url}${apiKey}` : url));
}
