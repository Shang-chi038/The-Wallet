/**
 * Best-effort zeroization for secret material.
 *
 * HONEST LIMITATION — read before relying on this.
 *
 * JavaScript cannot guarantee secret erasure. A `string` is immutable and
 * GC-managed: once a mnemonic exists as a string, copies may persist in the
 * heap until collection, and the engine may have relocated them during GC. We
 * cannot reach those copies.
 *
 * What we CAN control is `Uint8Array` backing stores, which are mutable and
 * (barring a copying GC moving them) can be overwritten in place. So the
 * discipline in this codebase is:
 *
 *   1. Hold secrets as Uint8Array wherever the API allows.
 *   2. Convert to string only at the boundary that demands it (BIP-39 needs a
 *      string), keeping that string's scope as narrow as possible.
 *   3. Call `zeroize` on every intermediate buffer once it is consumed.
 *
 * This raises the cost of heap-inspection attacks and shortens the window in
 * which key material is resident. It is a mitigation, not a guarantee, and the
 * real defence is that decrypted material lives only in the service worker and
 * is dropped on lock.
 */

export function zeroize(...buffers: Array<Uint8Array | undefined | null>): void {
  for (const buffer of buffers) {
    if (buffer) buffer.fill(0);
  }
}

/**
 * Runs `operation` with `secret`, then zeroizes `secret` unconditionally.
 * Guarantees the wipe happens even when the operation throws.
 */
export async function withSecret<TSecret extends Uint8Array, TResult>(
  secret: TSecret,
  operation: (secret: TSecret) => Promise<TResult> | TResult,
): Promise<TResult> {
  try {
    return await operation(secret);
  } finally {
    zeroize(secret);
  }
}
