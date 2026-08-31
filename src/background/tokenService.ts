import {
  DuplicateTokenError,
  parseStoredCustomToken,
  validateCustomToken,
  type CustomTokenClaims,
} from "@/core/token/customToken";
import { listBuiltInTokens, type TokenDefinition } from "@/core/token/tokenRegistry";
import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";

/**
 * The tokens this wallet knows about: the ones we ship, plus the ones the user
 * imported.
 *
 * ===========================================================================
 * WHAT "IMPORTED" MEANS, AND WHY IT TRAVELS WITH THE TOKEN
 * ===========================================================================
 * A built-in token's address, symbol and decimals were checked by us, once,
 * against the issuer. An imported one's were read from a contract the user was
 * probably pointed at by a website. Both end up in the same list because the
 * portfolio and the send flow need one list -- but `isBuiltIn` travels with
 * every entry so that no downstream surface has to guess which kind it is
 * holding. The portfolio uses it to decide what to price; the approval preview
 * uses it to decide what to warn about.
 *
 * ===========================================================================
 * STORED ONCE, TRUSTED THEREAFTER
 * ===========================================================================
 * `decimals` is read from the chain at import and written here. It is never
 * refreshed. A contract that returns 6 today and 18 tomorrow would otherwise
 * change the meaning of every balance and every amount the user has typed since
 * -- so the value the user was shown at import is the value the wallet keeps
 * using, and the only way to change it is to remove the token and import it
 * again.
 *
 * ===========================================================================
 * NOT ENCRYPTED, AND THAT IS DELIBERATE
 * ===========================================================================
 * These are public contract addresses, not secrets, and they must be readable
 * while the wallet is locked so the popup can render a portfolio skeleton.
 * They live in the same plain storage area as the custom-chain list, for the
 * same reason.
 */

export const CUSTOM_TOKENS_STORAGE_KEY = "wallet.customTokens.v1";

/**
 * Cap on imported tokens.
 *
 * Every token in the list is a `balanceOf` call on every portfolio read, so an
 * unbounded list turns one multicall into a slow one and hands the RPC provider
 * a longer and longer profile of what this user holds. High enough that no real
 * user meets it.
 */
export const MAX_CUSTOM_TOKENS = 200;

export class TooManyTokensError extends Error {
  readonly code = "too_many_tokens";
  constructor() {
    super(`This wallet can hold at most ${MAX_CUSTOM_TOKENS} imported tokens.`);
    this.name = "TooManyTokensError";
  }
}

export interface TokenServiceOptions {
  area: KeyValueStorageArea;
}

export class TokenService {
  private customTokens: TokenDefinition[] = [];
  private loaded = false;
  private readonly area: KeyValueStorageArea;

  constructor({ area }: TokenServiceOptions) {
    this.area = area;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(CUSTOM_TOKENS_STORAGE_KEY);
    this.customTokens = Array.isArray(stored)
      ? stored
          // Re-validated, not shape-checked, and a failure is DROPPED rather
          // than repaired. A corrupted `decimals` read back out of storage
          // would silently rescale every amount for that token.
          .map(parseStoredCustomToken)
          .filter((token): token is TokenDefinition => token !== undefined)
      : [];
    this.loaded = true;
  }

  /** Built-ins first, then imports, so the trusted entries lead the list. */
  listTokens(chainId: number): TokenDefinition[] {
    return [
      ...listBuiltInTokens(chainId),
      ...this.customTokens.filter((token) => token.chainId === chainId),
    ];
  }

  listImportedTokens(chainId?: number): TokenDefinition[] {
    return chainId === undefined
      ? [...this.customTokens]
      : this.customTokens.filter((token) => token.chainId === chainId);
  }

  findToken(chainId: number, address: string): TokenDefinition | undefined {
    const normalized = address.toLowerCase();
    return this.listTokens(chainId).find(
      (token) => token.address.toLowerCase() === normalized,
    );
  }

  /**
   * Persists a token from the claims a contract made.
   *
   * The same address on a DIFFERENT chain is a different token and is allowed:
   * addresses are not unique across chains, and a project deploying to two
   * networks routinely lands on the same one.
   */
  async addToken(claims: CustomTokenClaims): Promise<TokenDefinition> {
    await this.load();
    const definition = validateCustomToken(claims);

    if (this.findToken(definition.chainId, definition.address)) {
      throw new DuplicateTokenError(definition.address);
    }
    if (this.customTokens.length >= MAX_CUSTOM_TOKENS) throw new TooManyTokensError();

    this.customTokens = [...this.customTokens, definition];
    await this.area.set(CUSTOM_TOKENS_STORAGE_KEY, this.customTokens);
    return definition;
  }

  /**
   * Removes an imported token.
   *
   * Safe in a way that removing an account is not: there is no key here, only a
   * public address the user can paste again. A bad import with no way out is
   * why people reset wallets they did not need to reset.
   *
   * Built-ins are not removable -- there is nothing stored to remove, and
   * pretending otherwise would report success for a list that did not change.
   */
  async removeToken(chainId: number, address: string): Promise<boolean> {
    await this.load();
    const normalized = address.toLowerCase();
    const remaining = this.customTokens.filter(
      (token) => !(token.chainId === chainId && token.address.toLowerCase() === normalized),
    );
    if (remaining.length === this.customTokens.length) return false;

    this.customTokens = remaining;
    await this.area.set(CUSTOM_TOKENS_STORAGE_KEY, this.customTokens);
    return true;
  }

  /** Called by `wallet.reset`: an imported list is wallet state like any other. */
  async clear(): Promise<void> {
    this.customTokens = [];
    this.loaded = true;
    await this.area.set(CUSTOM_TOKENS_STORAGE_KEY, []);
  }
}
