/**
 * The unlock-password policy, and nothing else.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * The rule has to hold in two places: the engine enforces it, and the UI has to
 * state it BEFORE the user types, because a form that accepts a password and
 * then rejects it has already wasted the attempt. Both need the same number, so
 * the number must have one home.
 *
 * That home cannot be `walletService.ts`. Importing a constant from there drags
 * the whole engine -- vault cipher, keyring, key derivation -- into whatever
 * imports it, and the popup importing the keyring is precisely what the thin
 * client rule exists to prevent (see `ui/shared/walletClient.ts`). Measured: it
 * added ~100 kB, including the class that holds the derived key, to a bundle
 * that must not contain it.
 *
 * This module has no imports at all, so a UI file can state the rule without
 * linking against a single line of key handling.
 */

export class WeakPasswordError extends Error {
  readonly code = "weak_password";
  constructor(reason: string) {
    super(reason);
    this.name = "WeakPasswordError";
  }
}

export const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * Length-only policy, intentionally.
 *
 * Composition rules ("one uppercase, one symbol") push users toward
 * `Password1!` — predictable patterns that shrink the real search space while
 * feeling strict. Length is the property that actually matters, and the KDF is
 * doing the heavy lifting. The UI shows a strength meter and encourages a
 * passphrase rather than rejecting on shape.
 */
export function assertAcceptablePassword(password: string): void {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
}
