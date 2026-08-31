/**
 * The single source of randomness for the wallet.
 *
 * SECURITY: every byte of key material in this codebase originates here.
 * `crypto.getRandomValues` is the platform CSPRNG. `Math.random` is a
 * non-cryptographic PRNG whose output is predictable from a handful of
 * observations, and must never appear anywhere in this repository.
 *
 * Centralising randomness in one module means an audit only has to verify one
 * call site, and it gives tests a single seam to make determinism explicit
 * rather than accidental.
 */

export interface RandomSource {
  randomBytes(byteLength: number): Uint8Array;
}

export const systemRandomSource: RandomSource = {
  randomBytes(byteLength: number): Uint8Array {
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new Error("randomBytes requires a positive integer byte length.");
    }
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes;
  },
};

export function randomBytes(byteLength: number): Uint8Array {
  return systemRandomSource.randomBytes(byteLength);
}
