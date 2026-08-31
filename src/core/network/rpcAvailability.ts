/**
 * "The endpoint did not answer", told apart from every other RPC failure.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT A GENERAL RPC ERROR WRAPPER
 * ===========================================================================
 * A wallet has two completely different bad days on the RPC. One is the node
 * answering something the user needs to hear -- a revert, insufficient funds, a
 * nonce that is too low -- and those already have their own coded errors and
 * their own wording, all of it load-bearing on the send and approval screens.
 * The other is not reaching the node at all, which says nothing about the
 * user's money and everything about their connection.
 *
 * Only the second kind is classified here. Everything else keeps the handling
 * it has, because widening this would quietly relabel a revert as a network
 * problem, and the two need opposite reactions from the person reading them.
 *
 * The distinction had no representation before, so an unreachable endpoint
 * arrived at `messageRouter.toErrorPayload` as an unexpected throw: message
 * withheld from both audiences, only the error CLASS logged. What the popup did
 * with that is the reason this file exists -- see `PortfolioScreen`'s hero.
 */

/**
 * The viem error names that mean "no answer from the endpoint".
 *
 * `HttpRequestError` is what viem raises when `fetch` itself rejects, which in
 * a service worker covers DNS failure, a refused or blackholed connection, and
 * a response the network cut short. `TimeoutError` is the deadline expiring.
 *
 * Deliberately NOT here: `RpcRequestError` and the `*RpcError` family. Those
 * mean the node answered and the answer was an error, which is a different
 * fact -- reachable, and refusing.
 */
const TRANSPORT_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "HttpRequestError",
  "TimeoutError",
]);

/**
 * Walks the `cause` chain, because viem nests.
 *
 * A failed `getBalance` surfaces as a viem action error whose cause is the
 * transport error; checking only the outermost name would classify every one of
 * those as "something else" and defeat the whole exercise. The walk is bounded:
 * a malformed or self-referential chain must not hang the wallet.
 */
export function findTransportFailureName(error: unknown, maxDepth = 8): string | undefined {
  let current = error;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    if (TRANSPORT_FAILURE_NAMES.has(current.name)) return current.name;
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null || next === current) return undefined;
    current = next;
  }
  return undefined;
}

/**
 * An RPC endpoint that could not be reached.
 *
 * The two strings are split by audience for the same reason
 * `IndexerUnavailableError` splits its own. `message` is rendered under a
 * balance, so it names the CHAIN -- the thing the user chose and can change --
 * and nothing about hosts, deadlines or viem class names. `detail` keeps the
 * cause for whoever is debugging, on the error and off the screen.
 *
 * Neither string interpolates a caught exception's text. viem's messages quote
 * request bodies, and a request body on this path contains addresses.
 */
export class RpcUnavailableError extends Error {
  readonly code = "rpc_unavailable";
  readonly detail: string;

  constructor({
    chainName,
    reason,
  }: {
    chainName: string;
    reason: string;
  }) {
    super(`Can't reach ${chainName}`);
    this.name = "RpcUnavailableError";
    this.detail = `${chainName}: ${reason}`;
  }
}

/**
 * Rethrows an unreachable endpoint as `RpcUnavailableError`, and everything
 * else exactly as it was.
 *
 * Pass-through is the important half: a revert reaching the send screen as
 * "Can't reach Sepolia" would send someone to check their wifi over a
 * transaction the chain refused.
 */
export function rethrowAsRpcFailure(error: unknown, chainName: string): never {
  const failureName = findTransportFailureName(error);
  if (failureName === undefined) throw error;
  throw new RpcUnavailableError({
    chainName,
    reason:
      failureName === "TimeoutError" ? "the request timed out" : "the request did not complete",
  });
}
