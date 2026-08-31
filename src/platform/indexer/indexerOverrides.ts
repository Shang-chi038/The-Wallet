import {
  BUILT_IN_BITCOIN_NETWORKS,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";

/**
 * Which Esplora host each Bitcoin network talks to.
 *
 * ===========================================================================
 * WHY THIS IS PER-NETWORK AND NOT ONE URL
 * ===========================================================================
 * The network picker made every built-in network reachable; the configuration
 * did not follow. `VITE_BITCOIN_INDEXER_URL` names ONE host, and Esplora hosts
 * serve one chain each, so it could only ever override the network it was
 * configured for. Every other network fell back to its built-in host -- and
 * the built-in mainnet host is `mempool.space`, which a given machine may
 * simply be unable to reach. The symptom was a wallet that read signet
 * perfectly and could not read mainnet at all, with no configuration that
 * could fix it short of editing the network table.
 *
 * So each network gets its own optional override, and the generic variable
 * keeps its old meaning for the network it was always about.
 *
 * ===========================================================================
 * THE GENERIC VARIABLE IS STILL THE OFF SWITCH
 * ===========================================================================
 * Unset it and Bitcoin is off, whatever the per-network variables say. That
 * promise is not a tidy-looking one: a Bitcoin balance is a gap scan against a
 * third party that learns the user's addresses and their IP, and someone who
 * does not want that has to be able to have it not happen. Splitting the
 * switch across four variables would mean three ways to leave it half on, so
 * the switch stayed where it was and only the routing became plural. The
 * caller enforces this; the resolver below only maps hosts.
 */

export interface ResolveBitcoinIndexerOverridesParams {
  /** The network the build starts on -- what the generic URL is about. */
  readonly startingNetwork: BitcoinNetworkName;
  /** `VITE_BITCOIN_INDEXER_URL`: the starting network's host, and the switch. */
  readonly defaultIndexerUrl?: string | undefined;
  /** `VITE_BITCOIN_INDEXER_URL_<NETWORK>`, each overriding exactly its own. */
  readonly perNetworkIndexerUrls?:
    | Partial<Record<BitcoinNetworkName, string | undefined>>
    | undefined;
}

export interface RejectedIndexerOverride {
  readonly network: BitcoinNetworkName;
  /** Host only. A configured URL is not a secret, but it is not needed either. */
  readonly host: string;
  readonly reason: string;
}

export interface BitcoinIndexerOverrideResolution {
  readonly overrides: Partial<Record<BitcoinNetworkName, string>>;
  /**
   * Configured values that were NOT applied, and why.
   *
   * Reported rather than dropped. An ignored override leaves the network on its
   * built-in host, which looks exactly like a build that was never configured
   * -- and the person who typed the value has no reason to suspect it did
   * nothing. The service worker warns with these in development.
   */
  readonly rejected: readonly RejectedIndexerOverride[];
}

/**
 * A mainnet indexer does not live under a testnet path.
 *
 * This catches one specific mistake, and it is the mistake this configuration
 * shape invites: copying the signet URL into the mainnet slot and changing
 * nothing. There is no loud failure for it. Every derived mainnet address comes
 * back unused from a signet host, and the wallet reports a confident zero on
 * the screen where somebody is looking for their real money.
 *
 * Deliberately one-directional. A testnet override with no marker in its path
 * (`https://my-signet-node.internal/api`) is perfectly ordinary, so there is
 * nothing to check in that direction and guessing would reject valid config.
 */
const TESTNET_PATH_MARKER = /(^|\/)(signet|testnet\d*)(\/|$)/i;

function describeHost(url: URL): string {
  return url.host;
}

/**
 * Parses one configured value, or explains why it cannot be used.
 *
 * https only, with an exception for loopback: a developer running Esplora on
 * their own machine has no certificate and no third party to hide from, which
 * is the entire reason the rule exists. Everything else is a plaintext request
 * carrying the user's addresses across their network.
 */
function parseIndexerUrl(
  network: BitcoinNetworkName,
  value: string,
): { url: string } | { rejection: RejectedIndexerOverride } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      rejection: { network, host: "(unparseable)", reason: "not a valid URL" },
    };
  }

  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return {
      rejection: {
        network,
        host: describeHost(parsed),
        reason: "indexer URLs must use https (http is allowed on localhost only)",
      },
    };
  }

  if (network === "mainnet" && TESTNET_PATH_MARKER.test(parsed.pathname)) {
    return {
      rejection: {
        network,
        host: describeHost(parsed),
        reason: "a mainnet indexer cannot live under a testnet path",
      },
    };
  }

  // Trailing slashes are stripped by the reader, which builds paths onto this.
  return { url: value };
}

export function resolveBitcoinIndexerOverrides({
  startingNetwork,
  defaultIndexerUrl,
  perNetworkIndexerUrls,
}: ResolveBitcoinIndexerOverridesParams): BitcoinIndexerOverrideResolution {
  const overrides: Partial<Record<BitcoinNetworkName, string>> = {};
  const rejected: RejectedIndexerOverride[] = [];

  function apply(network: BitcoinNetworkName, value: string | undefined): void {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const outcome = parseIndexerUrl(network, trimmed);
    if ("rejection" in outcome) {
      rejected.push(outcome.rejection);
      return;
    }
    overrides[network] = outcome.url;
  }

  // The generic value first, so a per-network one for the same network wins.
  // That ordering is the whole migration story: an existing `.env.local` keeps
  // working untouched, and adding `..._MAINNET` changes mainnet and nothing else.
  apply(startingNetwork, defaultIndexerUrl);

  for (const network of BUILT_IN_BITCOIN_NETWORKS) {
    apply(network.network, perNetworkIndexerUrls?.[network.network]);
  }

  return { overrides, rejected };
}
