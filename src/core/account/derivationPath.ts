/**
 * BIP-44 derivation paths for Ethereum.
 *
 * m / purpose' / coin_type' / account' / change / address_index
 * m /      44' /        60' /       0' /      0 /             i
 *
 * Coin type 60 is Ethereum (SLIP-44). The apostrophe marks hardened
 * derivation. We keep every account under one hardened account node and vary
 * only the final index, which is the layout MetaMask, Ledger Live, Rainbow and
 * Trust all use — so a phrase exported from here restores with the same
 * addresses, in the same order, anywhere else. Deviating from this convention
 * is how wallets end up "losing" funds that are in fact sitting at a path the
 * other wallet never scans.
 */

export const ETHEREUM_COIN_TYPE = 60;
export const ETHEREUM_ACCOUNT_BASE_PATH = "m/44'/60'/0'/0";

export interface EthereumDerivationPathParams {
  addressIndex: number;
}

export function createEthereumDerivationPath({
  addressIndex,
}: EthereumDerivationPathParams): string {
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error("addressIndex must be a non-negative integer.");
  }
  // 2^31 is the hardened boundary; a non-hardened index must stay below it.
  if (addressIndex >= 2 ** 31) {
    throw new Error("addressIndex exceeds the non-hardened range.");
  }
  return `${ETHEREUM_ACCOUNT_BASE_PATH}/${addressIndex}`;
}

const DERIVATION_PATH_PATTERN = /^m(\/\d+'?)+$/;

export function isValidDerivationPath(path: string): boolean {
  return DERIVATION_PATH_PATTERN.test(path);
}
