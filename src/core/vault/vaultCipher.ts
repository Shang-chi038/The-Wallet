import { AuthenticationFailedError, decrypt, encrypt } from "../crypto/authenticatedCipher";
import { decodeBase64Url, decodeUtf8, encodeBase64Url, encodeUtf8 } from "../crypto/encoding";
import {
  DEFAULT_KEY_DERIVATION_PARAMS,
  createKeyDerivationSalt,
  deriveEncryptionKey,
  type KeyDerivationParams,
} from "../crypto/keyDerivation";
import { zeroize } from "../crypto/secretBytes";
import {
  IncorrectPasswordError,
  UnsupportedVaultVersionError,
  VaultCorruptedError,
} from "./vaultErrors";
import {
  VAULT_RECORD_VERSION,
  serializeVaultHeaderForAuthentication,
  type VaultPayload,
  type VaultRecord,
} from "./vaultRecord";

/**
 * Seals and opens the encrypted vault.
 *
 * This module is the trust boundary between "secret, in memory, unlocked" and
 * "public, on disk, locked". It is pure and platform-agnostic — it knows
 * nothing about chrome.storage — so the entire encryption path is unit testable
 * without a browser. The storage adapter is a separate concern.
 */

export interface SealVaultParams {
  payload: VaultPayload;
  password: string;
  /** Override for tests or for migrating a vault to stronger parameters. */
  keyDerivationParams?: KeyDerivationParams;
  /** Preserved across re-seals so `createdAt` survives a password change. */
  createdAt?: number;
  now?: () => number;
}

export async function sealVault({
  payload,
  password,
  keyDerivationParams = DEFAULT_KEY_DERIVATION_PARAMS,
  createdAt,
  now = Date.now,
}: SealVaultParams): Promise<VaultRecord> {
  // A fresh salt whenever we seal from a password. Re-sealing with the same
  // salt after a password change would let an attacker holding both ciphertexts
  // attack the weaker of the two passwords and get the same key.
  const salt = createKeyDerivationSalt();
  const encryptionKey = await deriveEncryptionKey({ password, salt, params: keyDerivationParams });
  try {
    return await sealVaultWithDerivedKey({
      payload,
      encryptionKey,
      salt,
      keyDerivationParams,
      ...(createdAt === undefined ? {} : { createdAt }),
      now,
    });
  } finally {
    zeroize(encryptionKey);
  }
}

export interface SealVaultWithDerivedKeyParams {
  payload: VaultPayload;
  /** Raw 32-byte key previously derived from the user's password. */
  encryptionKey: Uint8Array;
  /** The salt that key was derived under. Must match, or unlock will fail. */
  salt: Uint8Array;
  keyDerivationParams: KeyDerivationParams;
  createdAt?: number;
  now?: () => number;
}

/**
 * Re-seals using a key the caller already holds.
 *
 * WHY THIS EXISTS. Mutating vault contents while unlocked (adding an account,
 * importing a key) means re-encrypting — but we never retain the password, so
 * we cannot re-derive. Prompting for the password on every account creation
 * would be miserable UX and would train users to type their password into any
 * prompt that asks, which is the exact habit phishing relies on.
 *
 * So an unlocked session retains the DERIVED KEY (not the password) and
 * re-seals with it. This does not widen the attack surface in practice: the
 * same memory already holds the decrypted mnemonic, which is strictly more
 * valuable than a key scoped to one vault.
 *
 * The salt is deliberately REUSED here, and that is safe: the salt's job is to
 * stop cross-vault precomputation, and the password has not changed. What must
 * never be reused is the IV, and `encrypt` generates a fresh one every call.
 */
export async function sealVaultWithDerivedKey({
  payload,
  encryptionKey,
  salt,
  keyDerivationParams,
  createdAt,
  now = Date.now,
}: SealVaultWithDerivedKeyParams): Promise<VaultRecord> {
  const saltEncoded = encodeBase64Url(salt);

  const header = {
    version: VAULT_RECORD_VERSION,
    cipher: "aes-256-gcm",
    keyDerivation: keyDerivationParams,
    salt: saltEncoded,
  } as const satisfies Pick<VaultRecord, "version" | "cipher" | "keyDerivation" | "salt">;

  const additionalAuthenticatedData = encodeUtf8(serializeVaultHeaderForAuthentication(header));
  const plaintext = encodeUtf8(JSON.stringify(payload));

  try {
    const { initializationVector, ciphertext } = await encrypt({
      key: encryptionKey,
      plaintext,
      additionalAuthenticatedData,
    });
    const timestamp = now();
    return {
      ...header,
      initializationVector: encodeBase64Url(initializationVector),
      ciphertext: encodeBase64Url(ciphertext),
      createdAt: createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  } finally {
    // Drop the serialised secret as soon as the ciphertext exists. The key
    // belongs to the caller here and is wiped by whoever derived it. The JSON
    // string itself is immutable and unreachable, which is the limitation
    // documented in crypto/secretBytes.ts.
    zeroize(plaintext);
  }
}

export interface OpenVaultParams {
  record: VaultRecord;
  password: string;
}

export interface UnsealedVault {
  payload: VaultPayload;
  /**
   * The derived key, handed to the caller so an unlocked session can re-seal
   * without the password. The CALLER owns its lifetime and must zeroize it on
   * lock. Never serialise it, never send it over a message port.
   */
  encryptionKey: Uint8Array;
  /** The salt the key was derived under; required to re-seal. */
  salt: Uint8Array;
}

/**
 * Opens the vault and RETAINS the derived key for the caller.
 *
 * Used by the unlock path. Callers that only need the payload should use
 * `openVault`, which wipes the key for them.
 */
export async function unsealVault({ record, password }: OpenVaultParams): Promise<UnsealedVault> {
  return openVaultInternal({ record, password });
}

export async function openVault({ record, password }: OpenVaultParams): Promise<VaultPayload> {
  const { payload, encryptionKey } = await openVaultInternal({ record, password });
  zeroize(encryptionKey);
  return payload;
}

async function openVaultInternal({ record, password }: OpenVaultParams): Promise<UnsealedVault> {
  if (record.version !== VAULT_RECORD_VERSION) {
    // Refuse rather than guess. Opening an unknown future format risks
    // misinterpreting its contents and destroying the user's only copy on the
    // next write.
    throw new UnsupportedVaultVersionError(record.version);
  }
  if (record.cipher !== "aes-256-gcm") {
    throw new VaultCorruptedError("unrecognised cipher");
  }

  let salt: Uint8Array;
  let initializationVector: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = decodeBase64Url(record.salt);
    initializationVector = decodeBase64Url(record.initializationVector);
    ciphertext = decodeBase64Url(record.ciphertext);
  } catch {
    throw new VaultCorruptedError("malformed encoding");
  }

  const additionalAuthenticatedData = encodeUtf8(serializeVaultHeaderForAuthentication(record));

  const encryptionKey = await deriveEncryptionKey({
    password,
    salt,
    params: record.keyDerivation,
  });

  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decrypt({
      key: encryptionKey,
      initializationVector,
      ciphertext,
      additionalAuthenticatedData,
    });
    const payload: unknown = JSON.parse(decodeUtf8(plaintext));
    if (!isVaultPayload(payload)) {
      throw new VaultCorruptedError("unexpected payload shape");
    }
    return { payload, encryptionKey, salt };
  } catch (error) {
    // Failure means the key never reaches a caller, so wipe it here.
    zeroize(encryptionKey);
    if (error instanceof AuthenticationFailedError) {
      // Deliberately collapses "wrong password" and "tampered ciphertext" into
      // one error. Reporting them separately would tell an attacker probing a
      // stolen vault file whether their edits were accepted.
      throw new IncorrectPasswordError();
    }
    throw error;
  } finally {
    // The key is returned to the caller on success, so only wipe the plaintext.
    zeroize(plaintext);
  }
}

function isVaultPayload(value: unknown): value is VaultPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VaultPayload>;
  return candidate.version === VAULT_RECORD_VERSION && Array.isArray(candidate.keyringSources);
}

export interface ChangeVaultPasswordParams {
  record: VaultRecord;
  currentPassword: string;
  nextPassword: string;
  keyDerivationParams?: KeyDerivationParams;
}

/**
 * Re-seals the vault under a new password.
 *
 * Verifies the current password by fully opening the vault first, so a mistyped
 * current password cannot silently orphan the wallet. Also the point at which
 * an old vault picks up current KDF parameters.
 */
export async function changeVaultPassword({
  record,
  currentPassword,
  nextPassword,
  keyDerivationParams = DEFAULT_KEY_DERIVATION_PARAMS,
}: ChangeVaultPasswordParams): Promise<VaultRecord> {
  const payload = await openVault({ record, password: currentPassword });
  return sealVault({
    payload,
    password: nextPassword,
    keyDerivationParams,
    createdAt: record.createdAt,
  });
}
