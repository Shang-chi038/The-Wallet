import type { KeyDerivationParams } from "../crypto/keyDerivation";

/**
 * The on-disk vault format.
 *
 * This is the ONLY wallet artefact that touches persistent storage. Its
 * contents are assumed to be readable by an attacker: `chrome.storage.local` is
 * a plaintext LevelDB under the browser profile directory, so any process
 * running as the user, any backup tool, and any malware with filesystem access
 * can read it. Everything here must therefore be safe to publish.
 *
 * Persisted: version, cipher name, KDF parameters, salt, IV, ciphertext.
 * Never persisted: the password, the derived key, the seed, or private keys.
 */

export const VAULT_RECORD_VERSION = 1;

export interface VaultRecord {
  version: typeof VAULT_RECORD_VERSION;
  cipher: "aes-256-gcm";
  keyDerivation: KeyDerivationParams;
  /** base64url */
  salt: string;
  /** base64url */
  initializationVector: string;
  /** base64url, ciphertext with the GCM tag appended */
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

/** A distinct keyring inside one vault. Mirrors MetaMask's keyring model. */
export type KeyringSource = HdKeyringSource | PrivateKeyKeyringSource;

export interface HdKeyringSource {
  type: "hd";
  id: string;
  /** BIP-39 phrase. The root secret for every account this keyring derives. */
  mnemonic: string;
  /**
   * BIP-39 passphrase ("25th word"), empty string when unused.
   *
   * Stored alongside the mnemonic because seed derivation needs both on every
   * unlock. This means the passphrase does NOT add protection against an
   * attacker who has both the vault file and the vault password — it protects
   * against compromise of the written phrase alone. The onboarding copy states
   * this plainly rather than implying a second factor that does not exist.
   */
  passphrase: string;
  /**
   * How many sequential accounts the user has created. Accounts are re-derived
   * from this on unlock rather than stored, so the vault holds one secret
   * regardless of account count.
   */
  accountCount: number;
}

export interface PrivateKeyKeyringSource {
  type: "privateKey";
  id: string;
  /** Hex-encoded 32-byte key, for accounts imported without a phrase. */
  privateKey: string;
}

/** The plaintext sealed inside `VaultRecord.ciphertext`. */
export interface VaultPayload {
  version: typeof VAULT_RECORD_VERSION;
  keyringSources: KeyringSource[];
}

/**
 * Deterministic serialisation of the vault header for use as GCM additional
 * authenticated data.
 *
 * The header is not encrypted (we need the KDF parameters before we can derive
 * the key to decrypt anything), but it MUST be authenticated. Without this, an
 * attacker with write access to storage could rewrite `keyDerivation` to a
 * trivial cost, wait for the next unlock, and have the wallet itself hand them
 * a cheaply-derivable key. Binding the header into the tag makes any such edit
 * fail the integrity check.
 *
 * Field order is fixed explicitly rather than relying on JSON.stringify key
 * ordering, so the AAD is stable across engines and refactors.
 */
export function serializeVaultHeaderForAuthentication(
  header: Pick<VaultRecord, "version" | "cipher" | "keyDerivation" | "salt">,
): string {
  const { keyDerivation } = header;
  const derivationFields =
    keyDerivation.algorithm === "scrypt"
      ? [
          `algorithm=${keyDerivation.algorithm}`,
          `costFactor=${keyDerivation.costFactor}`,
          `blockSize=${keyDerivation.blockSize}`,
          `parallelism=${keyDerivation.parallelism}`,
        ]
      : [
          `algorithm=${keyDerivation.algorithm}`,
          `timeCost=${keyDerivation.timeCost}`,
          `memoryCostInKibibytes=${keyDerivation.memoryCostInKibibytes}`,
          `parallelism=${keyDerivation.parallelism}`,
        ];

  return [
    `version=${header.version}`,
    `cipher=${header.cipher}`,
    ...derivationFields,
    `salt=${header.salt}`,
  ].join("&");
}

export function isVaultRecord(value: unknown): value is VaultRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VaultRecord>;
  return (
    candidate.version === VAULT_RECORD_VERSION &&
    candidate.cipher === "aes-256-gcm" &&
    typeof candidate.salt === "string" &&
    typeof candidate.initializationVector === "string" &&
    typeof candidate.ciphertext === "string" &&
    typeof candidate.keyDerivation === "object" &&
    candidate.keyDerivation !== null
  );
}
