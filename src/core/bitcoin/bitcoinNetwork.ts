import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";

/**
 * The network-parameter shape the `@scure/btc-signer` payment builders take.
 *
 * Read off the exported constant rather than imported as `BTC_NETWORK`, which
 * is NOT exported from the package root -- it lives behind the "/utils"
 * subpath. `typeof NETWORK` needs no subpath and cannot break if that export
 * map changes.
 */
type BitcoinSignerNetwork = typeof NETWORK;

/**
 * Bitcoin network definitions and parameters.
 *
 * Ground rules:
 * - Coin type is 0' on mainnet and 1' on testnets (SLIP-44).
 * - Bech32 HRP (Human-Readable Part) is "bc" for mainnet and "tb" for testnets.
 * - Signet is the default testnet, mirroring Sepolia on the EVM side.
 */

export type BitcoinNetworkName = "mainnet" | "signet" | "testnet4";

export interface BitcoinNetworkDefinition {
  readonly network: BitcoinNetworkName;
  readonly name: string;
  readonly shortName: string;
  readonly coinType: number;
  readonly hrp: string;
  readonly isTestnet: boolean;
  readonly explorerUrl: string;
  readonly indexerUrl: string;
  readonly btcNetwork: BitcoinSignerNetwork;
}

export const BITCOIN_MAINNET: BitcoinNetworkDefinition = {
  network: "mainnet",
  name: "Bitcoin Mainnet",
  shortName: "BTC",
  coinType: 0,
  hrp: "bc",
  isTestnet: false,
  explorerUrl: "https://mempool.space",
  indexerUrl: "https://mempool.space/api",
  btcNetwork: NETWORK,
};

export const BITCOIN_SIGNET: BitcoinNetworkDefinition = {
  network: "signet",
  name: "Bitcoin Signet",
  shortName: "Signet",
  coinType: 1,
  hrp: "tb",
  isTestnet: true,
  explorerUrl: "https://mempool.space/signet",
  indexerUrl: "https://mempool.space/signet/api",
  btcNetwork: TEST_NETWORK,
};

export const BITCOIN_TESTNET4: BitcoinNetworkDefinition = {
  network: "testnet4",
  name: "Bitcoin Testnet4",
  shortName: "Testnet4",
  coinType: 1,
  hrp: "tb",
  isTestnet: true,
  explorerUrl: "https://mempool.space/testnet4",
  indexerUrl: "https://mempool.space/testnet4/api",
  btcNetwork: TEST_NETWORK,
};

export const BUILT_IN_BITCOIN_NETWORKS: readonly BitcoinNetworkDefinition[] = [
  BITCOIN_MAINNET,
  BITCOIN_SIGNET,
  BITCOIN_TESTNET4,
];

export const DEFAULT_BITCOIN_NETWORK: BitcoinNetworkName = "signet";

export function findBitcoinNetwork(
  network: BitcoinNetworkName,
): BitcoinNetworkDefinition {
  const match = BUILT_IN_BITCOIN_NETWORKS.find((entry) => entry.network === network);
  if (!match) {
    throw new Error(`Unsupported Bitcoin network: "${network}".`);
  }
  return match;
}

export function isValidBitcoinNetworkName(value: unknown): value is BitcoinNetworkName {
  return (
    typeof value === "string" &&
    BUILT_IN_BITCOIN_NETWORKS.some((entry) => entry.network === value)
  );
}
