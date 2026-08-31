/**
 * BIP-84 derivation paths for Bitcoin (Native SegWit / P2WPKH).
 *
 * m / purpose' / coin_type' / account' / branch / address_index
 * m /      84' /         0' /       0' /      0 /             i  (Mainnet Receive)
 * m /      84' /         0' /       0' /      1 /             i  (Mainnet Change)
 * m /      84' /         1' /       0' /      0 /             i  (Testnet / Signet Receive)
 *
 * Purpose 84 is Native SegWit (BIP-84).
 * Coin type:
 *   - 0' for Bitcoin Mainnet
 *   - 1' for Bitcoin Testnet, Signet, Regtest
 * Branch:
 *   - 0 for external (receiving addresses)
 *   - 1 for internal (change addresses)
 */

export const BITCOIN_PURPOSE = 84;

export interface BitcoinAccountBasePathParams {
  coinType: number;
  accountIndex: number;
}

export function createBitcoinAccountBasePath({
  coinType,
  accountIndex,
}: BitcoinAccountBasePathParams): string {
  if (!Number.isInteger(coinType) || coinType < 0) {
    throw new Error("coinType must be a non-negative integer.");
  }
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error("accountIndex must be a non-negative integer.");
  }
  if (accountIndex >= 2 ** 31) {
    throw new Error("accountIndex exceeds the non-hardened range.");
  }
  return `m/${BITCOIN_PURPOSE}'/${coinType}'/${accountIndex}'`;
}

export interface BitcoinDerivationPathParams {
  coinType: number;
  accountIndex: number;
  branch: 0 | 1;
  addressIndex: number;
}

export function createBitcoinDerivationPath({
  coinType,
  accountIndex,
  branch,
  addressIndex,
}: BitcoinDerivationPathParams): string {
  if (branch !== 0 && branch !== 1) {
    throw new Error("branch must be 0 (external/receive) or 1 (internal/change).");
  }
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error("addressIndex must be a non-negative integer.");
  }
  if (addressIndex >= 2 ** 31) {
    throw new Error("addressIndex exceeds the non-hardened range.");
  }
  const basePath = createBitcoinAccountBasePath({ coinType, accountIndex });
  return `${basePath}/${branch}/${addressIndex}`;
}

export interface BitcoinRelativePathParams {
  branch: 0 | 1;
  addressIndex: number;
}

export function createBitcoinRelativePath({
  branch,
  addressIndex,
}: BitcoinRelativePathParams): string {
  if (branch !== 0 && branch !== 1) {
    throw new Error("branch must be 0 (external/receive) or 1 (internal/change).");
  }
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error("addressIndex must be a non-negative integer.");
  }
  if (addressIndex >= 2 ** 31) {
    throw new Error("addressIndex exceeds the non-hardened range.");
  }
  return `m/${branch}/${addressIndex}`;
}
