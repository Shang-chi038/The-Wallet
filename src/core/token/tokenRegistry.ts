import { toChecksumAddress } from "../account/ethereumAddress";
import { ETHEREUM_MAINNET, ETHEREUM_SEPOLIA } from "../network/chain";

/**
 * Known ERC-20 tokens, keyed by chain.
 *
 * Addresses are HARDCODED and never resolved at runtime by symbol. Symbol
 * lookup is how users end up holding a worthless token that calls itself
 * "USDC" — anyone can deploy a contract with any name. The address is the only
 * identity that means anything.
 *
 * Both stablecoins use 6 decimals, not 18. See token/tokenAmount.ts.
 */

export interface TokenDefinition {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  /** True for tokens shipped with the wallet, false for user-imported ones. */
  isBuiltIn: boolean;
}

export const USDC_MAINNET: TokenDefinition = {
  address: toChecksumAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  chainId: ETHEREUM_MAINNET.chainId,
  isBuiltIn: true,
};

export const USDT_MAINNET: TokenDefinition = {
  address: toChecksumAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
  chainId: ETHEREUM_MAINNET.chainId,
  isBuiltIn: true,
};

/** Circle's official Sepolia test USDC. */
export const USDC_SEPOLIA: TokenDefinition = {
  address: toChecksumAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
  symbol: "USDC",
  name: "USD Coin (Sepolia)",
  decimals: 6,
  chainId: ETHEREUM_SEPOLIA.chainId,
  isBuiltIn: true,
};

/**
 * NOTE: Tether publishes no canonical Sepolia deployment. Any "Sepolia USDT" is
 * somebody's mock, so we ship none rather than blessing an arbitrary contract.
 * Test USDT behaviour against a locally deployed mock that reproduces the real
 * contract's quirks (see USDT_QUIRKS below).
 */
export const BUILT_IN_TOKENS: readonly TokenDefinition[] = [
  USDC_MAINNET,
  USDT_MAINNET,
  USDC_SEPOLIA,
];

export function listBuiltInTokens(chainId: number): TokenDefinition[] {
  return BUILT_IN_TOKENS.filter((token) => token.chainId === chainId);
}

export function findBuiltInToken(chainId: number, address: string): TokenDefinition | undefined {
  const normalized = address.toLowerCase();
  return BUILT_IN_TOKENS.find(
    (token) => token.chainId === chainId && token.address.toLowerCase() === normalized,
  );
}

/**
 * Non-standard behaviours of the real mainnet USDT contract, which predates the
 * finalised ERC-20 spec. Any code path that approves USDT must handle both, and
 * any mock used for testing must reproduce them — otherwise tests pass on a
 * well-behaved mock and the integration fails on mainnet.
 */
export const USDT_QUIRKS = {
  /**
   * `approve` returns nothing instead of `bool`. Strict ERC-20 bindings decode
   * the empty return as a revert.
   */
  approveReturnsVoid: true,
  /**
   * A non-zero allowance cannot be changed directly; it must be set to 0 first.
   * Skipping this makes the second approve revert.
   */
  requiresZeroAllowanceBeforeChange: true,
} as const;

/**
 * Unlimited ERC-20 approval sentinel (2^256 - 1).
 *
 * Requests for this value must be surfaced prominently in the approval UI:
 * granting it lets the spender move the user's entire balance of that token,
 * forever, with no further interaction. It is the mechanism behind most drainer
 * losses.
 */
export const UNLIMITED_ALLOWANCE = (1n << 256n) - 1n;

export function isUnlimitedAllowance(amount: bigint): boolean {
  // Drainers often request a value that is merely enormous rather than exactly
  // 2^256-1, so treat anything above 2^255 as unlimited for warning purposes.
  return amount >= 1n << 255n;
}
