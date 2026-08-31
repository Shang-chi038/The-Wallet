import { normalize } from "viem/ens";
import { isValidAddress } from "../account/ethereumAddress";

/**
 * ENS name handling.
 *
 * ===========================================================================
 * A NAME IS NOT AN ADDRESS, AND THAT IS THE WHOLE PROBLEM
 * ===========================================================================
 * An Ethereum address is self-verifying: the user can read it, and the EIP-55
 * checksum catches a typo. A name is neither. It is a human-readable string
 * that some contract maps to an address, and the user has no way to check the
 * mapping by looking at it.
 *
 * That makes names the softest target in a send flow, in two distinct ways:
 *
 *   HOMOGRAPHS. Unicode contains thousands of characters that render
 *   identically or near-identically to ASCII. "vitalik.eth" typed with a
 *   Cyrillic 'a' is a different name, owned by someone else, that looks exactly
 *   the same in every font. ENSIP-15 normalisation is what makes this
 *   detectable, and a name that fails to normalise is REFUSED here rather than
 *   passed through -- a wallet that resolves an unnormalised name is resolving
 *   a name no legitimate registrar issued.
 *
 *   UNVERIFIED REVERSE RECORDS. Anyone can point a reverse record at any name.
 *   Reverse resolution is only meaningful if the forward record is checked to
 *   point back -- see `platform/ens/viemEnsResolver.ts`, where that check is
 *   the entire reason the universal resolver is used.
 *
 * This module is pure: no network, no resolver, no contract. It decides what a
 * name IS. Turning one into an address happens at the platform layer.
 */

export class InvalidEnsNameError extends Error {
  readonly code = "invalid_ens_name";
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidEnsNameError";
  }
}

/**
 * Whether a recipient string should be treated as a name rather than an
 * address.
 *
 * Checked BEFORE normalisation and deliberately loose: the job here is to route
 * the input to the right validator, not to decide whether the name is any good.
 * A string that is a valid address is never a name, even if it somehow contains
 * a dot, because addresses are unambiguous and must never take the slower,
 * riskier path.
 */
export function isEnsNameCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || isValidAddress(trimmed)) return false;
  // A label, a dot, and a TLD. `.eth` is the common case but ENS supports
  // DNS-imported names, so the TLD is not hardcoded.
  return /^[^\s.]+(\.[^\s.]+)+$/u.test(trimmed);
}

export interface NormalizedEnsName {
  /** ENSIP-15 normalised form. This, and only this, is what gets resolved. */
  normalized: string;
  /** Exactly what the user typed, trimmed. */
  entered: string;
  /**
   * True when normalisation CHANGED the string.
   *
   * Usually innocent -- uppercase folds to lowercase -- but it is also what a
   * homograph attack looks like from here, so the UI shows the normalised form
   * and lets the user see what will actually be resolved. Silently resolving
   * something other than what was typed is the behaviour to avoid.
   */
  wasChanged: boolean;
}

/**
 * Normalises a name, or refuses it.
 *
 * Throws rather than returning undefined because there is no safe fallback: a
 * name that cannot be normalised has no correct interpretation, and the only
 * options are refuse or guess. Guessing is how funds reach the wrong owner.
 */
export function normalizeEnsName(name: string): NormalizedEnsName {
  const entered = name.trim();
  if (entered === "") throw new InvalidEnsNameError("Enter a name.");

  let normalized: string;
  try {
    // ENSIP-15 (UTS-46 plus ENS-specific rules) via @adraffy/ens-normalize.
    // This is what rejects mixed-script confusables and disallowed characters.
    normalized = normalize(entered);
  } catch {
    throw new InvalidEnsNameError(
      "That name contains characters ENS does not allow. It may be an imitation of a name you know.",
    );
  }

  if (normalized === "") throw new InvalidEnsNameError("Enter a name.");
  return { normalized, entered, wasChanged: normalized !== entered };
}

/**
 * Shortens a long name for a dense row without hiding the part that matters.
 *
 * The TLD and the label boundary are always kept: truncating "verylongname.eth"
 * to "verylongna..." would drop the very suffix that tells the user what kind
 * of name they are looking at.
 */
export function abbreviateEnsName(name: string, maximumLength = 24): string {
  if (name.length <= maximumLength) return name;
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return `${name.slice(0, maximumLength - 3)}...`;

  const suffix = name.slice(lastDot);
  const head = Math.max(maximumLength - suffix.length - 3, 4);
  return `${name.slice(0, head)}...${suffix}`;
}
