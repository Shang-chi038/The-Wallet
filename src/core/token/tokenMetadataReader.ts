/**
 * ERC-20 metadata access contract.
 *
 * Separate from `BalanceReader` deliberately. A balance is a number this wallet
 * asks for constantly and treats as current; metadata is a claim it reads ONCE,
 * at import, and never asks about again. Bolting the two together would put a
 * per-request path next to a once-per-lifetime one and invite the second to be
 * called on the schedule of the first -- which is how a stored `decimals`
 * quietly becomes a value re-fetched from an attacker on every render.
 *
 * Every field is optional in ERC-20 and every one of them can revert, so each
 * comes back as "what it said, or nothing". Deciding what an absent field means
 * is the caller's job: see `validateCustomToken`, which refuses rather than
 * defaults.
 */

export interface TokenMetadataClaims {
  /**
   * Undefined when the contract has no `decimals()`, or it reverted.
   *
   * There is no sensible default. Assuming 18 is the single most expensive
   * guess this codebase could make -- the difference between sending 1.00 and
   * sending 1,000,000,000,000.00 -- so an absent value must refuse the import
   * rather than fill itself in.
   */
  decimals: number | undefined;
  symbol: string | undefined;
  name: string | undefined;
}

export interface TokenMetadataReader {
  readTokenMetadata(params: { address: string; chainId: number }): Promise<TokenMetadataClaims>;
}

/**
 * For chains with no configured client.
 *
 * Every field absent, so every import against such a chain refuses. Silence is
 * the correct answer where there is nothing to ask.
 */
export function createUnavailableTokenMetadataReader(): TokenMetadataReader {
  return {
    async readTokenMetadata() {
      return { decimals: undefined, symbol: undefined, name: undefined };
    },
  };
}
