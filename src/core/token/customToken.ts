import { isValidAddress, toChecksumAddress } from "../account/ethereumAddress";
import type { TokenDefinition } from "./tokenRegistry";
import { findBuiltInToken } from "./tokenRegistry";

/**
 * Validation for user-imported ERC-20 tokens.
 *
 * ===========================================================================
 * EVERY FIELD HERE IS ATTACKER-CONTROLLED
 * ===========================================================================
 * A token contract is code somebody else deployed. `symbol()`, `name()` and
 * `decimals()` return whatever that code decides to return, and the user is
 * usually importing it because a website told them to. So this module treats
 * the contract's answers as a CLAIM to be bounded and displayed, never as fact.
 *
 * The claim that moves money is `decimals`. A contract reporting 6 while its
 * balances are denominated in 18 turns a 1.00 send into a 1,000,000,000,000.00
 * one. It is therefore read from the chain rather than accepted from the
 * caller, bounded here, and stored once -- after which the STORED value is
 * authoritative and the contract is never asked again.
 *
 * The claims that mislead are `symbol` and `name`. They are rendered next to
 * real balances, so they are stripped of anything that can reorder or overrun
 * the text around them, and length-capped.
 */

export class InvalidTokenError extends Error {
  readonly code = "invalid_token";
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidTokenError";
  }
}

export class DuplicateTokenError extends Error {
  readonly code = "duplicate_token";
  readonly address: string;
  constructor(address: string) {
    super(`This token is already in your wallet: ${address}.`);
    this.name = "DuplicateTokenError";
    this.address = address;
  }
}

/**
 * The contract did not tell us what we must know.
 *
 * Distinct from "invalid": nothing was wrong with the address, the contract
 * simply has no readable `decimals()`. Either it is not an ERC-20 at all (an
 * EOA, a project's website contract, a paste of the wrong thing) or the node
 * could not be reached -- and in every one of those cases the honest answer is
 * that this token cannot be added, not that it can be added with a guess.
 */
export class TokenNotReadableError extends Error {
  readonly code = "token_not_readable";
  constructor(reason: string) {
    super(reason);
    this.name = "TokenNotReadableError";
  }
}

/**
 * The contract answered differently the second time it was asked.
 *
 * The import flow reads `decimals()` to show the user, then reads it again to
 * store it. A contract that returns 6 to the first call and 18 to the second
 * has arranged for the user to approve one token and the wallet to save
 * another -- the same preview/payload split that `approvalService` exists to
 * prevent, applied to the one field that rescales every amount.
 */
export class TokenMetadataChangedError extends Error {
  readonly code = "token_metadata_changed";
  constructor() {
    super(
      "This contract reported different decimals the second time it was asked. It has not been added.",
    );
    this.name = "TokenMetadataChangedError";
  }
}

/**
 * Upper bound on decimals.
 *
 * ERC-20 types it as `uint8`, so a contract may legally claim 255 -- at which
 * point every balance a user could hold renders as zero and every amount they
 * could type overflows the field. 36 is double the 18 that every real token
 * uses and leaves generous headroom, while keeping the absurd values out.
 */
export const MAX_TOKEN_DECIMALS = 36;
export const MAX_TOKEN_SYMBOL_LENGTH = 16;
export const MAX_TOKEN_NAME_LENGTH = 64;

/**
 * Characters removed from any text a contract supplies.
 *
 * Written as escapes and named by codepoint rather than contained literally --
 * see the CLAUDE.md trap about invisible characters reaching source through
 * heredocs, and the confusables tests that follow the same rule.
 *
 *   U+0000-U+001F, U+007F-U+009F   C0 and C1 controls
 *   U+200B-U+200D, U+FEFF          zero-width space, non-joiner, joiner, BOM
 *   U+200E, U+200F                 left-to-right and right-to-left marks
 *   U+202A-U+202E                  embeddings and the OVERRIDE
 *   U+2066-U+2069                  directional isolates
 *
 * The bidi overrides are the dangerous ones. U+202E reverses the rendering of
 * everything after it, so a crafted symbol can make the amount printed beside
 * it read as a different number entirely.
 */
const DISALLOWED_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeTokenText(value: string): string {
  return value.replace(DISALLOWED_TEXT, "").replace(/\s+/g, " ").trim();
}

export interface CustomTokenClaims {
  address: string;
  chainId: number;
  /** As read from the contract. Never supplied by the caller. */
  decimals: number;
  /** Optional in ERC-20; absent for a contract that implements neither. */
  symbol?: string | undefined;
  name?: string | undefined;
}

/**
 * Turns a contract's claims into a storable definition, or says why it cannot.
 *
 * Refuses rather than repairs. A token we cannot describe accurately is one the
 * user cannot send accurately, and a wallet that guesses at the missing part is
 * guessing with their money.
 */
export function validateCustomToken({
  address,
  chainId,
  decimals,
  symbol,
  name,
}: CustomTokenClaims): TokenDefinition {
  if (!isValidAddress(address)) {
    throw new InvalidTokenError("That is not a valid contract address.");
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new InvalidTokenError("That network is not valid.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new InvalidTokenError(
      `This contract reports ${String(decimals)} decimals, which no usable token has.`,
    );
  }

  const checksummed = toChecksumAddress(address);

  /**
   * A built-in address can never be re-imported.
   *
   * The wallet ships USDC's address with USDC's real decimals. Letting an
   * import overwrite that entry would let a website walk a user through
   * replacing the metadata of a token they already trust -- a far better attack
   * than getting them to import a new one.
   */
  if (findBuiltInToken(chainId, checksummed)) {
    throw new DuplicateTokenError(checksummed);
  }

  const cleanSymbol = sanitizeTokenText(symbol ?? "").slice(0, MAX_TOKEN_SYMBOL_LENGTH);
  if (cleanSymbol === "") {
    throw new InvalidTokenError("This contract does not report a usable symbol.");
  }

  // Falls back to the symbol rather than to something invented. Plenty of real
  // tokens implement `symbol()` and not `name()`.
  const cleanName = sanitizeTokenText(name ?? "").slice(0, MAX_TOKEN_NAME_LENGTH) || cleanSymbol;

  return {
    address: checksummed,
    symbol: cleanSymbol,
    name: cleanName,
    decimals,
    chainId,
    isBuiltIn: false,
  };
}

/**
 * Shape check for a token read back out of storage.
 *
 * Re-runs the full validation rather than checking field types, and DROPS what
 * fails -- the same discipline `isChainDefinition` follows in networkService.
 * A corrupted `decimals` is not a cosmetic defect here: it is the field that
 * decides how much a send actually moves.
 */
export function parseStoredCustomToken(value: unknown): TokenDefinition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<TokenDefinition>;
  if (typeof candidate.address !== "string" || typeof candidate.chainId !== "number") {
    return undefined;
  }
  if (typeof candidate.decimals !== "number") return undefined;
  try {
    return validateCustomToken({
      address: candidate.address,
      chainId: candidate.chainId,
      decimals: candidate.decimals,
      symbol: typeof candidate.symbol === "string" ? candidate.symbol : undefined,
      name: typeof candidate.name === "string" ? candidate.name : undefined,
    });
  } catch {
    return undefined;
  }
}
