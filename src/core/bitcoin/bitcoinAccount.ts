import type { HDKey } from "@scure/bip32";
import { p2wpkh, Address } from "@scure/btc-signer";
import { encodeHex } from "../crypto/encoding";
import {
  createBitcoinDerivationPath,
  createBitcoinRelativePath,
} from "./derivationPath";
import type { BitcoinNetworkDefinition } from "./bitcoinNetwork";

/**
 * Bitcoin account and address derivation (BIP-84 P2WPKH).
 *
 * All operations here accept a public-only (neutered) HDKey node.
 * Deriving addresses never requires or touches private keys.
 */

export interface BitcoinAddressSummary {
  readonly address: string;
  readonly branch: 0 | 1;
  readonly addressIndex: number;
  readonly derivationPath: string;
  readonly publicKeyHex: string;
}

export interface DeriveBitcoinAddressParams {
  readonly accountNode: HDKey;
  readonly branch: 0 | 1;
  readonly addressIndex: number;
  readonly network: BitcoinNetworkDefinition;
  readonly accountIndex?: number;
}

/**
 * Derives the P2WPKH Bech32 address at (branch, addressIndex) from an account-level node.
 */
export function deriveBitcoinAddress({
  accountNode,
  branch,
  addressIndex,
  network,
}: DeriveBitcoinAddressParams): string {
  const relativePath = createBitcoinRelativePath({ branch, addressIndex });
  const childNode = accountNode.derive(relativePath);
  if (!childNode.publicKey) {
    throw new Error("Unable to derive child public key from account node.");
  }
  const payment = p2wpkh(childNode.publicKey, network.btcNetwork);
  if (!payment.address) {
    throw new Error("Failed to generate P2WPKH Bech32 address.");
  }
  return payment.address;
}

/**
 * Derives an address summary including full derivation path and public key.
 */
export function deriveBitcoinAddressSummary({
  accountNode,
  branch,
  addressIndex,
  network,
  accountIndex = 0,
}: DeriveBitcoinAddressParams): BitcoinAddressSummary {
  const relativePath = createBitcoinRelativePath({ branch, addressIndex });
  const childNode = accountNode.derive(relativePath);
  if (!childNode.publicKey) {
    throw new Error("Unable to derive child public key from account node.");
  }
  const payment = p2wpkh(childNode.publicKey, network.btcNetwork);
  if (!payment.address) {
    throw new Error("Failed to generate P2WPKH Bech32 address.");
  }
  const derivationPath = createBitcoinDerivationPath({
    coinType: network.coinType,
    accountIndex,
    branch,
    addressIndex,
  });

  return {
    address: payment.address,
    branch,
    addressIndex,
    derivationPath,
    publicKeyHex: encodeHex(childNode.publicKey),
  };
}

/**
 * Validates whether an address string is a valid Bitcoin address for the given network.
 */
export function isValidBitcoinAddress(
  address: string,
  network: BitcoinNetworkDefinition,
): boolean {
  if (typeof address !== "string" || address.trim().length === 0) {
    return false;
  }
  try {
    Address(network.btcNetwork).decode(address.trim().toLowerCase());
    return true;
  } catch {
    return false;
  }
}
