import type { PublicClient } from "viem";
import {
  assertChainIdMatches,
  BUILT_IN_CHAINS,
  ETHEREUM_SEPOLIA,
  findBuiltInChain,
  InvalidChainError,
  validateCustomChain,
  type AddCustomChainParams,
  type ChainDefinition,
} from "@/core/network/chain";
import { createRpcClient, resolveRpcUrls } from "@/platform/rpc/rpcClient";
import { createViemBalanceReader } from "@/platform/rpc/viemBalanceReader";
import { createViemNetworkReader, type NetworkReader } from "@/platform/rpc/viemNetworkReader";
import { createViemTokenMetadataReader } from "@/platform/rpc/viemTokenMetadataReader";
import type { TokenMetadataReader } from "@/core/token/tokenMetadataReader";
import type { BalanceReader } from "@/core/balance/balanceReader";
import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";
import {
  createUnavailableTransferReader,
  type TransferReader,
} from "@/core/activity/transactionHistory";
import {
  createAlchemyTransferReader,
  supportsAssetTransfers,
} from "@/platform/indexer/alchemyTransferReader";
import { createUnavailableEnsResolver, type EnsResolver } from "@/core/ens/ensResolver";
import { createViemEnsResolver } from "@/platform/ens/viemEnsResolver";

/**
 * Active network, custom networks, and the RPC clients bound to them.
 *
 * ===========================================================================
 * WHY ADDING A NETWORK IS AN APPROVAL, NOT A SETTING
 * ===========================================================================
 * `wallet_addEthereumChain` lets a site propose a network. A proposed network
 * is a proposed VIEW OF REALITY: its RPC is what the wallet will ask for
 * balances, gas prices and simulation results, and what it will hand a signed
 * transaction to for broadcast. An attacker-controlled RPC can inflate a
 * balance, understate a fee, fake a successful simulation, and quietly drop the
 * broadcast while telling the wallet it succeeded.
 *
 * Two checks stand between a site and that, and both are mandatory:
 *
 *   1. `validateCustomChain` refuses to redefine a built-in chain id, so no
 *      site can register "Ethereum Mainnet" pointing at its own node, and
 *      requires https so the endpoint cannot be tampered with in transit.
 *
 *   2. `verifyChainId` asks the proposed endpoint for its OWN eth_chainId and
 *      refuses if it disagrees with the claim. A node that says it is chain
 *      31337 while the site called it 137 is impersonating, and the mismatch is
 *      the only signal available before funds move.
 *
 * Only after both does the request reach the user, who gets the final say.
 *
 * ===========================================================================
 * CLIENT CACHING
 * ===========================================================================
 * viem clients hold connection state and a multicall batch queue. Building one
 * per request would defeat batching and make a portfolio read 20 round trips
 * instead of one, so they are cached per chain id and rebuilt only when a
 * chain's definition changes.
 */

export const ACTIVE_CHAIN_STORAGE_KEY = "wallet.activeChain.v1";
export const CUSTOM_CHAINS_STORAGE_KEY = "wallet.customChains.v1";

/**
 * Default network.
 *
 * Sepolia, deliberately, until the send flow has been exercised end to end on
 * real funds. A wallet that opens on mainnet by default invites a first
 * transaction to be a real one, and the first transaction is the one most
 * likely to hit a bug.
 */
export const DEFAULT_CHAIN = ETHEREUM_SEPOLIA;

export interface NetworkServiceOptions {
  area: KeyValueStorageArea;
  /**
   * Build-time RPC key. Public by construction -- it ships in the bundle and is
   * a rate-limit identifier, not a secret. See .env.local.
   */
  rpcApiKey?: string | undefined;
  defaultChainId?: number | undefined;
  /** Injectable so tests never open a socket. */
  createClient?: (chain: ChainDefinition, rpcUrls: string[]) => PublicClient;
  /**
   * Injectable for the same reason.
   *
   * Name resolution is several contract reads deep inside viem, so faking the
   * client is not enough to exercise "the name did not resolve" -- and that
   * branch, not the happy path, is where a send flow goes wrong.
   */
  createEnsResolver?: () => EnsResolver;
}

interface ChainClients {
  client: PublicClient;
  balanceReader: BalanceReader;
  networkReader: NetworkReader;
  /**
   * History needs an INDEX, which a plain node does not have. An endpoint with
   * no index gets a reader that reports nothing, so the Activity tab can say
   * "not available on this endpoint" instead of showing a failed request as an
   * outage.
   */
  transferReader: TransferReader;
  /**
   * Reads what a token contract CLAIMS about itself. Used once per import and
   * never again -- see core/token/tokenMetadataReader.ts.
   */
  tokenMetadataReader: TokenMetadataReader;
  supportsHistory: boolean;
  /** Endpoint list the cache entry was built from, so config changes rebuild it. */
  rpcUrls: string;
}

export class NetworkService {
  private activeChainId: number;
  private customChains: ChainDefinition[] = [];
  private loaded = false;
  private readonly clients = new Map<number, ChainClients>();
  private ensResolver: EnsResolver | undefined;
  private readonly area: KeyValueStorageArea;
  private readonly rpcApiKey: string | undefined;
  private readonly createClient: (chain: ChainDefinition, rpcUrls: string[]) => PublicClient;
  private readonly createEnsResolver: () => EnsResolver;

  constructor({
    area,
    rpcApiKey,
    defaultChainId,
    createClient,
    createEnsResolver,
  }: NetworkServiceOptions) {
    this.area = area;
    this.rpcApiKey = rpcApiKey;
    this.activeChainId = defaultChainId ?? DEFAULT_CHAIN.chainId;
    this.createClient =
      createClient ?? ((chain, rpcUrls) => createRpcClient({ chain, rpcUrls }));
    this.createEnsResolver =
      createEnsResolver ??
      (() =>
        createViemEnsResolver({
          getClient: (chainId) => this.resolveClients(chainId).client,
          getChain: (chainId) => this.findChain(chainId),
        }));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const storedCustom = await this.area.get(CUSTOM_CHAINS_STORAGE_KEY);
    this.customChains = Array.isArray(storedCustom)
      ? storedCustom.filter(isChainDefinition)
      : [];

    const storedActive = await this.area.get(ACTIVE_CHAIN_STORAGE_KEY);
    if (typeof storedActive === "number" && this.findChain(storedActive)) {
      this.activeChainId = storedActive;
    }
    this.loaded = true;
  }

  getActiveChain(): ChainDefinition {
    return this.findChain(this.activeChainId) ?? DEFAULT_CHAIN;
  }

  listChains(): ChainDefinition[] {
    return [...BUILT_IN_CHAINS, ...this.customChains];
  }

  findChain(chainId: number): ChainDefinition | undefined {
    return findBuiltInChain(chainId) ?? this.customChains.find((c) => c.chainId === chainId);
  }

  /**
   * Switches networks.
   *
   * Refuses an unknown chain with the EIP-3326 contract in mind: a site must
   * `wallet_addEthereumChain` first and get the user's consent for the endpoint
   * before it can switch to it. Switching to a chain we have no definition for
   * would mean picking an RPC ourselves, which is exactly the decision that
   * belongs to the user.
   */
  async setActiveChain(chainId: number): Promise<ChainDefinition> {
    await this.load();
    const chain = this.findChain(chainId);
    if (!chain) {
      throw new InvalidChainError(`Chain ${chainId} has not been added to this wallet.`);
    }
    this.activeChainId = chainId;
    await this.area.set(ACTIVE_CHAIN_STORAGE_KEY, chainId);
    return chain;
  }

  /**
   * Validates a proposed chain WITHOUT persisting it.
   *
   * Split from `addCustomChain` on purpose: everything that can be rejected is
   * rejected before the user is shown a prompt, so no one is ever asked to
   * approve a network the wallet already knows it will refuse.
   */
  async prepareCustomChain(params: AddCustomChainParams): Promise<ChainDefinition> {
    const definition = validateCustomChain(params);
    await this.verifyChainId(definition);
    return definition;
  }

  async addCustomChain(definition: ChainDefinition): Promise<ChainDefinition> {
    await this.load();
    if (this.findChain(definition.chainId)) return definition;
    this.customChains = [...this.customChains, definition];
    await this.area.set(CUSTOM_CHAINS_STORAGE_KEY, this.customChains);
    return definition;
  }

  /**
   * Asks the proposed endpoint what chain it actually serves.
   *
   * The claim in the request is the site's word. This is the node's own answer,
   * and it is the only thing that can catch an endpoint impersonating another
   * network. Uses a throwaway client so a rejected chain never enters the cache.
   */
  async verifyChainId(definition: ChainDefinition): Promise<void> {
    const client = this.createClient(definition, definition.rpcUrls);
    const actual = await client.getChainId();
    assertChainIdMatches(definition.chainId, actual);
  }

  getBalanceReader(chainId?: number): BalanceReader {
    return this.resolveClients(chainId).balanceReader;
  }

  getNetworkReader(chainId?: number): NetworkReader {
    return this.resolveClients(chainId).networkReader;
  }

  getTokenMetadataReader(chainId?: number): TokenMetadataReader {
    return this.resolveClients(chainId).tokenMetadataReader;
  }

  getTransferReader(chainId?: number): TransferReader {
    return this.resolveClients(chainId).transferReader;
  }

  supportsTransactionHistory(chainId?: number): boolean {
    return this.resolveClients(chainId).supportsHistory;
  }

  /**
   * The ENS resolver.
   *
   * One instance for the whole service, resolving the client and the trusted
   * resolver address per chain at call time. A chain with no
   * `ensUniversalResolverAddress` -- which is every chain a website talked the
   * user into adding -- resolves nothing, because a resolver contract on an
   * attacker's chain can map any name to any address.
   */
  getEnsResolver(): EnsResolver {
    if (!this.ensResolver) this.ensResolver = this.createEnsResolver();
    return this.ensResolver;
  }

  supportsEnsNames(chainId?: number): boolean {
    const chain = chainId === undefined ? this.getActiveChain() : this.findChain(chainId);
    return Boolean(chain?.ensUniversalResolverAddress);
  }

  private resolveClients(chainId?: number): ChainClients {
    const chain = chainId === undefined ? this.getActiveChain() : this.findChain(chainId);
    if (!chain) throw new InvalidChainError(`Chain ${String(chainId)} is not configured.`);

    const rpcUrls = resolveRpcUrls(chain, this.rpcApiKey);
    const cacheKey = rpcUrls.join("|");
    const cached = this.clients.get(chain.chainId);
    if (cached && cached.rpcUrls === cacheKey) return cached;

    const client = this.createClient(chain, rpcUrls);
    const supportsHistory = supportsAssetTransfers(rpcUrls);
    const entry: ChainClients = {
      client,
      balanceReader: createViemBalanceReader(client),
      networkReader: createViemNetworkReader(client),
      tokenMetadataReader: createViemTokenMetadataReader(client),
      transferReader: supportsHistory
        ? createAlchemyTransferReader({ client, chainId: chain.chainId })
        : createUnavailableTransferReader(),
      supportsHistory,
      rpcUrls: cacheKey,
    };
    this.clients.set(chain.chainId, entry);
    return entry;
  }
}

/**
 * Shape check on stored custom chains.
 *
 * A malformed entry is DROPPED rather than repaired. A half-valid chain
 * definition -- a name with no rpcUrls, say -- would produce a client pointed at
 * nothing, and the resulting errors would surface as "network problem" rather
 * than as the corrupted config it is.
 */
function isChainDefinition(value: unknown): value is ChainDefinition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChainDefinition>;
  return (
    typeof candidate.chainId === "number" &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.rpcUrls) &&
    candidate.rpcUrls.length > 0 &&
    typeof candidate.nativeCurrency === "object" &&
    candidate.nativeCurrency !== null
  );
}

/** Exported so the unavailable-resolver default is reachable from tests. */
export { createUnavailableEnsResolver };
