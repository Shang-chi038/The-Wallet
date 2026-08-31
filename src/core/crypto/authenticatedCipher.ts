/**
 * AES-256-GCM authenticated encryption, via the platform WebCrypto engine.
 *
 * GCM is an AEAD: it provides confidentiality AND integrity in one pass. That
 * second property is what matters most here. `chrome.storage.local` is a
 * plaintext file on disk that any process running as the user can rewrite. A
 * non-authenticated mode (AES-CBC, AES-CTR) would let an attacker flip bits in
 * the stored ciphertext and have us decrypt attacker-influenced plaintext
 * without noticing. With GCM, any modification fails the tag check and we
 * refuse to proceed.
 *
 * We use the platform implementation rather than a JS one: it is constant-time,
 * hardware-accelerated (AES-NI), and outside our supply-chain surface entirely.
 */

export const INITIALIZATION_VECTOR_BYTE_LENGTH = 12; // 96-bit, the GCM-standard size
export const AUTHENTICATION_TAG_BIT_LENGTH = 128;

import { randomBytes } from "./randomSource";

/**
 * Imports raw key bytes into WebCrypto.
 *
 * `extractable: false` means the resulting CryptoKey cannot be read back out
 * into JavaScript — the browser holds the key material outside the JS heap.
 * Even code with full heap access after this point cannot recover the key from
 * the CryptoKey handle.
 */
async function importEncryptionKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.length !== 32) {
    throw new Error("AES-256-GCM requires a 32-byte key.");
  }
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptParams {
  /** Raw 32-byte key, normally the output of `deriveEncryptionKey`. */
  key: Uint8Array;
  plaintext: Uint8Array;
  /**
   * Additional authenticated data. Not encrypted, but covered by the tag.
   * Used to bind the vault header (version, KDF params) to the ciphertext so
   * an attacker cannot downgrade the stored parameters.
   */
  additionalAuthenticatedData?: Uint8Array;
}

export interface EncryptResult {
  initializationVector: Uint8Array;
  /** Ciphertext with the 16-byte GCM tag appended, as WebCrypto returns it. */
  ciphertext: Uint8Array;
}

export async function encrypt({
  key,
  plaintext,
  additionalAuthenticatedData,
}: EncryptParams): Promise<EncryptResult> {
  // A fresh random IV per encryption. IV reuse under the same key is
  // catastrophic for GCM: it leaks the XOR of the plaintexts and allows
  // forgery of the authentication tag. There is no code path in this module
  // that accepts a caller-supplied IV for encryption, by design.
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTE_LENGTH);
  const cryptoKey = await importEncryptionKey(key);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: initializationVector as BufferSource,
      tagLength: AUTHENTICATION_TAG_BIT_LENGTH,
      ...(additionalAuthenticatedData
        ? { additionalData: additionalAuthenticatedData as BufferSource }
        : {}),
    },
    cryptoKey,
    plaintext as BufferSource,
  );

  return { initializationVector, ciphertext: new Uint8Array(ciphertext) };
}

export interface DecryptParams {
  key: Uint8Array;
  initializationVector: Uint8Array;
  ciphertext: Uint8Array;
  additionalAuthenticatedData?: Uint8Array;
}

export class AuthenticationFailedError extends Error {
  readonly code = "authentication_failed";
  constructor() {
    super("Decryption failed: wrong password or the stored data was modified.");
    this.name = "AuthenticationFailedError";
  }
}

/**
 * Decrypts and verifies.
 *
 * Throws `AuthenticationFailedError` on any failure. Note that a wrong password
 * and tampered ciphertext are INDISTINGUISHABLE here, deliberately: both
 * surface the same error with no detail about which check failed and no partial
 * plaintext. Distinguishing them would hand an attacker an oracle.
 */
export async function decrypt({
  key,
  initializationVector,
  ciphertext,
  additionalAuthenticatedData,
}: DecryptParams): Promise<Uint8Array> {
  const cryptoKey = await importEncryptionKey(key);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: initializationVector as BufferSource,
        tagLength: AUTHENTICATION_TAG_BIT_LENGTH,
        ...(additionalAuthenticatedData
          ? { additionalData: additionalAuthenticatedData as BufferSource }
          : {}),
      },
      cryptoKey,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new AuthenticationFailedError();
  }
}
