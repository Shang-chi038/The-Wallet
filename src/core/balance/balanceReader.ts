import type { TokenDefinition } from "../token/tokenRegistry";

/**
 * Balance access contract.
 *
 * `core` declares what it needs; `platform` supplies a viem-backed
 * implementation. That inversion keeps balance logic testable without a network
 * and makes the RPC provider a swappable detail.
 */

export interface NativeBalance {
  chainId: number;
  address: string;
  /** Base units (wei). Always bigint — never a JS number. */
  amount: bigint;
  decimals: number;
  symbol: string;
}

export interface TokenBalance {
  chainId: number;
  address: string;
  token: TokenDefinition;
  amount: bigint;
}

export interface BalanceReader {
  readNativeBalance(params: { address: string; chainId: number }): Promise<bigint>;
  readTokenBalances(params: {
    address: string;
    chainId: number;
    tokens: readonly TokenDefinition[];
  }): Promise<Map<string, bigint>>;
  readChainId(): Promise<number>;
}

export interface PortfolioEntry {
  token: TokenDefinition | "native";
  amount: bigint;
  decimals: number;
  symbol: string;
}

/**
 * Orders a portfolio for display: non-zero balances first, then by symbol.
 *
 * Zero-balance tokens are kept rather than hidden — a user who imported a token
 * expects to see it, and silently dropping it reads as the wallet having lost
 * it.
 */
export function sortPortfolioForDisplay(entries: PortfolioEntry[]): PortfolioEntry[] {
  return [...entries].sort((left, right) => {
    if (left.token === "native") return -1;
    if (right.token === "native") return 1;
    const leftHasBalance = left.amount > 0n;
    const rightHasBalance = right.amount > 0n;
    if (leftHasBalance !== rightHasBalance) return leftHasBalance ? -1 : 1;
    return left.symbol.localeCompare(right.symbol);
  });
}
