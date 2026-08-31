import { randomBytes } from "../crypto/randomSource";
import { normalizeMnemonicPhrase } from "./mnemonicPhrase";

/**
 * Seed-backup verification challenge.
 *
 * A user who has not actually written the phrase down has an unrecoverable
 * wallet and does not know it yet. Onboarding therefore asks them to reproduce
 * a random subset of words in position before the wallet becomes usable.
 *
 * We check a SUBSET rather than the whole phrase deliberately: re-typing all 12
 * words trains users to copy-paste from a screenshot, which is the exact habit
 * we are trying to prevent.
 */

export const DEFAULT_BACKUP_CHALLENGE_WORD_COUNT = 3;

export interface BackupChallenge {
  /** Zero-based positions in the phrase the user must supply, ascending. */
  wordPositions: number[];
}

export interface CreateBackupChallengeParams {
  phrase: string;
  wordCount?: number;
}

/**
 * Positions are chosen with the CSPRNG, not Math.random.
 *
 * Not because the challenge is a secret, but because a predictable sequence
 * would let a malicious onboarding clone precompute which words it needs to
 * phish. Uniformity also matters: modulo-biased selection would over-sample
 * early positions and leave later words never verified.
 */
export function createBackupChallenge({
  phrase,
  wordCount = DEFAULT_BACKUP_CHALLENGE_WORD_COUNT,
}: CreateBackupChallengeParams): BackupChallenge {
  const words = normalizeMnemonicPhrase(phrase).split(" ");
  if (words.length === 0 || words[0] === "") {
    throw new Error("Cannot build a backup challenge from an empty phrase.");
  }
  const requested = Math.min(wordCount, words.length);
  const positions = new Set<number>();
  while (positions.size < requested) {
    positions.add(selectUniformIndex(words.length));
  }
  return { wordPositions: [...positions].sort((left, right) => left - right) };
}

/**
 * Rejection sampling for a uniform index in [0, bound).
 * A plain `% bound` would bias toward low indices whenever bound is not a power
 * of two.
 */
function selectUniformIndex(bound: number): number {
  const limit = Math.floor(0xffffffff / bound) * bound;
  for (;;) {
    const bytes = randomBytes(4);
    const value =
      ((bytes[0] as number) << 24) |
      ((bytes[1] as number) << 16) |
      ((bytes[2] as number) << 8) |
      (bytes[3] as number);
    const unsigned = value >>> 0;
    if (unsigned < limit) return unsigned % bound;
  }
}

export interface VerifyBackupResponseParams {
  phrase: string;
  challenge: BackupChallenge;
  /** User-supplied words, keyed by the position they were asked for. */
  responses: Record<number, string>;
}

export function verifyBackupResponse({
  phrase,
  challenge,
  responses,
}: VerifyBackupResponseParams): boolean {
  const words = normalizeMnemonicPhrase(phrase).split(" ");
  return challenge.wordPositions.every((position) => {
    const expected = words[position];
    const supplied = responses[position];
    if (expected === undefined || supplied === undefined) return false;
    return expected === supplied.trim().toLowerCase();
  });
}
