import {
  generateMnemonic,
  mnemonicToSeed,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/**
 * BIP-39 mnemonic generation and seed derivation.
 *
 * We delegate to @scure/bip39 rather than implementing BIP-39 ourselves. The
 * spec looks simple and is full of traps — checksum bit packing, NFKD
 * normalisation, the exact PBKDF2-HMAC-SHA512 salt construction. A subtle bug
 * here produces a wallet that generates valid-looking addresses which no other
 * wallet can recover. @scure/bip39 is audited and passes the official vectors.
 *
 * @scure/bip39 draws entropy from `crypto.getRandomValues` internally.
 */

export type MnemonicStrength = 128 | 256;

export const MNEMONIC_STRENGTH_BY_WORD_COUNT: Record<number, MnemonicStrength> = {
  12: 128,
  24: 256,
};

export interface CreateMnemonicPhraseParams {
  /** 128 bits -> 12 words, 256 bits -> 24 words. Defaults to 128. */
  strength?: MnemonicStrength;
}

/**
 * 128-bit entropy (12 words) is the default.
 *
 * 12 words already exceeds any feasible brute-force budget; 256-bit entropy
 * does not meaningfully improve real-world security, and longer phrases
 * measurably increase the chance a user records their backup incorrectly.
 * Users who want 24 words can select it during onboarding.
 */
export function createMnemonicPhrase({ strength = 128 }: CreateMnemonicPhraseParams = {}): string {
  return generateMnemonic(wordlist, strength);
}

/**
 * Normalises user-entered phrases before validation or derivation.
 *
 * Import fields collect leading/trailing whitespace, doubled spaces from
 * line-wrapped paper backups, mixed case, and non-breaking spaces pasted from
 * PDFs. All of those produce a different seed and therefore a silently wrong
 * wallet, so normalise before doing anything else.
 */
export function normalizeMnemonicPhrase(phrase: string): string {
  // NFKD folds compatibility forms, and the /\s+/ split below already covers
  // every Unicode space separator (non-breaking spaces from PDF backups
  // included), so no separate whitespace substitution is needed here.
  return phrase
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

export function validateMnemonicPhrase(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonicPhrase(phrase), wordlist);
}

export function getMnemonicWordCount(phrase: string): number {
  const normalized = normalizeMnemonicPhrase(phrase);
  return normalized.length === 0 ? 0 : normalized.split(" ").length;
}

/**
 * Words from the BIP-39 English wordlist matching a prefix.
 * Powers import-field autocomplete, which prevents most typo-driven
 * "my wallet is empty" support cases.
 */
export function listMnemonicWordSuggestions(prefix: string, limit = 5): string[] {
  const normalized = prefix.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const suggestions: string[] = [];
  for (const word of wordlist) {
    if (word.startsWith(normalized)) {
      suggestions.push(word);
      if (suggestions.length >= limit) break;
    }
  }
  return suggestions;
}

export function isMnemonicWord(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}

export interface MnemonicToSeedParams {
  phrase: string;
  /**
   * Optional BIP-39 passphrase, the "25th word".
   *
   * SECURITY / UX NOTE: this is mixed into the PBKDF2 salt, so a different
   * passphrase derives a completely different, valid wallet — there is no
   * "wrong passphrase" error, only silently different addresses. It is
   * unrecoverable if forgotten. Its real protection is against compromise of
   * the WRITTEN PHRASE ALONE (someone finds the paper backup); it does not
   * protect against compromise of the vault plus the vault password, since
   * both phrase and passphrase are sealed in the same vault.
   */
  passphrase?: string;
}

export function deriveSeedFromMnemonic({
  phrase,
  passphrase = "",
}: MnemonicToSeedParams): Uint8Array {
  const normalized = normalizeMnemonicPhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new InvalidMnemonicError();
  }
  return mnemonicToSeedSync(normalized, passphrase);
}

export async function deriveSeedFromMnemonicAsync({
  phrase,
  passphrase = "",
}: MnemonicToSeedParams): Promise<Uint8Array> {
  const normalized = normalizeMnemonicPhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new InvalidMnemonicError();
  }
  return mnemonicToSeed(normalized, passphrase);
}

export class InvalidMnemonicError extends Error {
  readonly code = "invalid_mnemonic";
  constructor() {
    super("The recovery phrase is not a valid BIP-39 mnemonic.");
    this.name = "InvalidMnemonicError";
  }
}
