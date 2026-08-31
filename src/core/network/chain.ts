/**
 * Chain registry and custom-network validation.
 *
 * Adding a network is a security-relevant action, not a settings tweak. A
 * malicious dApp calling `wallet_addEthereumChain` can propose a chain that
 * CLAIMS to be Ethereum mainnet while pointing at an RPC the attacker controls.
 * That RPC can lie about balances, gas prices and simulation results, and can
 * withhold or front-run broadcasts. The validation in this file is what stops a
 * user signing a mainnet-value transaction against an attacker's view of the
 * world.
 */

export interface ChainDefinition {
  chainId: number;
  name: string;
  /** Short label for dense UI. */
  shortName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrl: string;
  /** Whether the chain supports EIP-1559 fee fields. */
  supportsEip1559: boolean;
  isTestnet: boolean;
  /**
   * ENS universal resolver, when this chain has an ENS deployment we trust.
   *
   * Carried on the chain definition rather than read from viem's chain registry
   * so that adding a network can never silently bring an ENS resolver with it.
   * A custom chain proposed by a website has no entry here, so name resolution
   * on it is simply unavailable -- which is the correct answer, because a
   * resolver contract on an attacker's chain would happily map "vitalik.eth" to
   * whatever address they liked.
   */
  ensUniversalResolverAddress?: string;
}

export const ETHEREUM_MAINNET: ChainDefinition = {
  chainId: 1,
  name: "Ethereum",
  shortName: "ETH",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://eth-mainnet.g.alchemy.com/v2/"],
  blockExplorerUrl: "https://etherscan.io",
  supportsEip1559: true,
  isTestnet: false,
  ensUniversalResolverAddress: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
};

export const ETHEREUM_SEPOLIA: ChainDefinition = {
  chainId: 11155111,
  name: "Sepolia",
  shortName: "SEP",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://eth-sepolia.g.alchemy.com/v2/"],
  blockExplorerUrl: "https://sepolia.etherscan.io",
  supportsEip1559: true,
  isTestnet: true,
  ensUniversalResolverAddress: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
};

export const BUILT_IN_CHAINS: readonly ChainDefinition[] = [ETHEREUM_MAINNET, ETHEREUM_SEPOLIA];

export function findBuiltInChain(chainId: number): ChainDefinition | undefined {
  return BUILT_IN_CHAINS.find((chain) => chain.chainId === chainId);
}

/** EIP-155 chain IDs are positive integers below 2^53 in practice. */
export function isValidChainId(chainId: unknown): chainId is number {
  return typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0;
}

/**
 * EIP-3085 sends chain IDs as 0x-prefixed hex strings, not numbers. Parsing
 * them with `parseInt` (base 10 by default) yields 1 for "0x1" by luck and
 * nonsense for anything larger, so parse explicitly as hex.
 */
export function parseHexChainId(value: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new InvalidChainError(`Chain ID "${value}" is not 0x-prefixed hex.`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!isValidChainId(parsed)) throw new InvalidChainError(`Chain ID "${value}" is out of range.`);
  return parsed;
}

export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

export class InvalidChainError extends Error {
  readonly code = "invalid_chain";
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidChainError";
  }
}

export class ChainIdMismatchError extends Error {
  readonly code = "chain_id_mismatch";
  constructor(
    readonly declaredChainId: number,
    readonly actualChainId: number,
  ) {
    super(
      `This network claims to be chain ${declaredChainId} but its RPC reports ${actualChainId}. ` +
        `It may be impersonating another network.`,
    );
    this.name = "ChainIdMismatchError";
  }
}

export interface AddCustomChainParams {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  blockExplorerUrl?: string;
}

/**
 * Validates a proposed custom chain's static properties.
 *
 * Does NOT verify the chain ID against the live RPC — that requires a network
 * call and is done by `assertChainIdMatches` at the platform layer. Both checks
 * are mandatory before a custom chain is persisted.
 */
export function validateCustomChain({
  chainId,
  name,
  rpcUrl,
  nativeCurrency,
  blockExplorerUrl,
}: AddCustomChainParams): ChainDefinition {
  if (!isValidChainId(chainId)) throw new InvalidChainError("Chain ID must be a positive integer.");
  if (name.trim() === "") throw new InvalidChainError("Network name is required.");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new InvalidChainError(`"${rpcUrl}" is not a valid URL.`);
  }

  // Require TLS. An http:// RPC exposes every address the user queries to
  // anyone on the network path, and lets them tamper with balances and gas
  // estimates in flight.
  //
  // THERE IS NO LOCALHOST EXEMPTION, and there used to be. It was written for
  // a developer pointing at a local node, but the only caller that reaches
  // here is `wallet_addEthereumChain` -- a method any WEBSITE can call. So the
  // exemption was not a developer affordance, it was a permission slip for a
  // page to make the service worker connect to the user's own machine, which
  // is a loopback port scanner running with this extension's `<all_urls>` host
  // access. There is no user-facing custom-RPC screen for it to serve (see
  // CLAUDE.md), so it only ever had the one caller and the one effect.
  if (parsedUrl.protocol !== "https:") {
    throw new InvalidChainError("Custom RPC endpoints must use https.");
  }
  assertPubliclyRoutableHost(parsedUrl);

  // A built-in chain ID must not be redefined. This is the direct defence
  // against a dApp "adding" chain 1 with its own RPC and having the user sign
  // real-value mainnet transactions against an attacker-controlled node.
  const builtIn = findBuiltInChain(chainId);
  if (builtIn) {
    throw new InvalidChainError(
      `Chain ${chainId} is already configured as ${builtIn.name} and cannot be redefined.`,
    );
  }

  return {
    chainId,
    name: name.trim(),
    shortName: name.trim().slice(0, 6).toUpperCase(),
    nativeCurrency: nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [rpcUrl],
    blockExplorerUrl: sanitizeBlockExplorerUrl(blockExplorerUrl),
    supportsEip1559: true,
    isTestnet: true,
  };
}

/**
 * Refuses an endpoint on the user's own machine or private network.
 *
 * `https` alone does not make a host safe to connect to on a page's say-so: a
 * name that resolves to 127.0.0.1 or 10.x is still the wallet reaching into a
 * network only the user can see, from a request a website initiated. The page
 * learns what is there from the timing and from `ChainIdMismatchError`, which
 * reports the endpoint's real chain id.
 *
 * Literal addresses only. Resolving a hostname to check where it points would
 * be a DNS-rebinding race we would lose -- the check and the connection are
 * two separate lookups -- so this is a cheap filter on the obvious cases, and
 * the connection gate in `addEthereumChain` is what actually bounds who can
 * reach this code at all.
 */
function assertPubliclyRoutableHost(url: URL): void {
  // IPv6 arrives bracketed from `URL.hostname`.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new InvalidChainError("Custom RPC endpoints must be publicly routable.");
  }

  // IPv6 loopback and unique-local / link-local ranges.
  if (host === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) {
    throw new InvalidChainError("Custom RPC endpoints must be publicly routable.");
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return;
  const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
  const isPrivate =
    first === 0 || // "this host"
    first === 10 ||
    first === 127 || // loopback
    (first === 169 && second === 254) || // link-local, incl. cloud metadata
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127); // carrier-grade NAT
  if (isPrivate) {
    throw new InvalidChainError("Custom RPC endpoints must be publicly routable.");
  }
}

/**
 * The explorer URL a site proposed, or "" if it is not one we will link to.
 *
 * This value ends up in an `href` in the popup (ActivityScreen, SendScreen)
 * with the transaction hash appended, so it is not a cosmetic field: it is a
 * page-chosen navigation target persisted in the user's wallet. It used to be
 * passed straight through while `rpcUrl` beside it was held to https, which
 * meant any scheme at all -- `javascript:`, `data:`, plain http.
 *
 * Nothing is thrown. The field is optional and a chain is perfectly usable
 * without it, so a bad one is DROPPED rather than made to fail an otherwise
 * valid network -- `buildExplorerUrl` already treats "" as "no link".
 */
function sanitizeBlockExplorerUrl(blockExplorerUrl: string | undefined): string {
  if (!blockExplorerUrl) return "";
  try {
    const parsed = new URL(blockExplorerUrl);
    return parsed.protocol === "https:" ? blockExplorerUrl : "";
  } catch {
    return "";
  }
}

/**
 * Confirms the RPC actually serves the chain it claims to.
 *
 * Call with the result of `eth_chainId` from the endpoint itself, before the
 * network is saved and before any transaction is signed against it.
 */
export function assertChainIdMatches(declaredChainId: number, actualChainId: number): void {
  if (declaredChainId !== actualChainId) {
    throw new ChainIdMismatchError(declaredChainId, actualChainId);
  }
}
