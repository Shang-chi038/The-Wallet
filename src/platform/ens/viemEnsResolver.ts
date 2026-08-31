import type { PublicClient } from "viem";
import { getEnsAddress, getEnsName } from "viem/ens";
import type { EnsResolver } from "@/core/ens/ensResolver";
import { toChecksumAddress } from "@/core/account/ethereumAddress";
import type { ChainDefinition } from "@/core/network/chain";

/**
 * viem-backed ENS resolver.
 *
 * ===========================================================================
 * THE UNIVERSAL RESOLVER ADDRESS IS PASSED EXPLICITLY, ON PURPOSE
 * ===========================================================================
 * viem will happily read the resolver address out of its own chain registry if
 * we let it. We do not let it. The address comes from OUR `ChainDefinition`,
 * which means a chain a website talked the user into adding has no resolver and
 * therefore no name resolution at all.
 *
 * That matters because a resolver is a contract that decides what a name means.
 * On an attacker-controlled chain, a resolver contract can map any name to any
 * address -- and a send screen that displayed "vitalik.eth -> 0xAttacker" with
 * a green tick would be doing the attacker's work for them.
 *
 * ===========================================================================
 * REVERSE RESOLUTION IS FORWARD-VERIFIED BY CONSTRUCTION
 * ===========================================================================
 * `getEnsName` goes through the universal resolver's reverse method, which
 * resolves the reverse record AND checks the name's forward record points back
 * at the same address, on chain, in one call. An implementation that read the
 * reverse registrar directly would skip that check, and any address could then
 * claim any name in our UI.
 */

export interface ViemEnsResolverOptions {
  /** Resolves the client for a chain, so a lookup uses that chain's endpoint. */
  getClient: (chainId: number) => PublicClient;
  /** Resolves our own chain definition, which carries the resolver address. */
  getChain: (chainId: number) => ChainDefinition | undefined;
}

export function createViemEnsResolver({
  getClient,
  getChain,
}: ViemEnsResolverOptions): EnsResolver {
  function resolverAddressFor(chainId: number): `0x${string}` | undefined {
    const address = getChain(chainId)?.ensUniversalResolverAddress;
    return address ? (address as `0x${string}`) : undefined;
  }

  return {
    async resolveName({ normalizedName, chainId }) {
      const universalResolverAddress = resolverAddressFor(chainId);
      if (!universalResolverAddress) return undefined;

      try {
        const address = await getEnsAddress(getClient(chainId), {
          // Already ENSIP-15 normalised by `core/ens/ensName`. viem would
          // namehash whatever it is given, so passing raw input here would
          // resolve a homograph exactly as happily as the real name.
          name: normalizedName,
          universalResolverAddress,
        });
        // The zero address is what a name with no address record returns. It is
        // "no answer", not an answer -- and sending to it burns the funds.
        if (!address || address === ZERO_ADDRESS) return undefined;
        return toChecksumAddress(address);
      } catch {
        // Unresolvable, offline, or a resolver that reverted. All of them mean
        // the same thing to the caller: no address for this name.
        return undefined;
      }
    },

    async lookupAddress({ address, chainId }) {
      const universalResolverAddress = resolverAddressFor(chainId);
      if (!universalResolverAddress) return undefined;

      try {
        return (
          (await getEnsName(getClient(chainId), {
            address: address as `0x${string}`,
            universalResolverAddress,
          })) ?? undefined
        );
      } catch {
        return undefined;
      }
    },
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
