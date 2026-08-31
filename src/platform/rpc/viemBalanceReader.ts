import { erc20Abi, type PublicClient } from "viem";
import type { BalanceReader } from "@/core/balance/balanceReader";
import type { TokenDefinition } from "@/core/token/tokenRegistry";
import { rethrowAsRpcFailure } from "@/core/network/rpcAvailability";

/**
 * viem-backed BalanceReader.
 *
 * ERC-20 `balanceOf` calls are issued together so viem's multicall batching
 * collapses them into one request.
 */
export function createViemBalanceReader(client: PublicClient): BalanceReader {
  // Named for the user, not for the transport. The client already carries it,
  // so an unreachable endpoint can say which network went quiet without this
  // reader having to be told twice.
  const chainName = client.chain?.name ?? "this network";

  return {
    async readNativeBalance({ address }) {
      /**
       * The ONE read in a portfolio that cannot degrade.
       *
       * Token balances are gathered with `allSettled` below, so a bad contract
       * costs its own row and nothing else. The native balance has no row to
       * lose -- it is the hero figure -- so a failure here has to travel, and
       * it has to travel as something the popup can tell apart from an empty
       * wallet. Before this it arrived as an unexpected throw and the hero
       * rendered `0 ETH`: a fabricated zero, on the largest number on screen,
       * because a request did not complete.
       */
      try {
        return await client.getBalance({ address: address as `0x${string}` });
      } catch (error) {
        rethrowAsRpcFailure(error, chainName);
      }
    },

    async readTokenBalances({ address, tokens }) {
      const balances = new Map<string, bigint>();
      if (tokens.length === 0) return balances;

      const results = await Promise.allSettled(
        tokens.map((token: TokenDefinition) =>
          client.readContract({
            address: token.address as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address as `0x${string}`],
          }),
        ),
      );

      results.forEach((result, index) => {
        const token = tokens[index];
        if (!token) return;
        // allSettled, not all: one unreachable or non-conforming token contract
        // must not blank out every other balance in the user's portfolio.
        if (result.status === "fulfilled") {
          balances.set(token.address.toLowerCase(), result.value as bigint);
        }
      });

      return balances;
    },

    async readChainId() {
      try {
        return await client.getChainId();
      } catch (error) {
        rethrowAsRpcFailure(error, chainName);
      }
    },
  };
}
