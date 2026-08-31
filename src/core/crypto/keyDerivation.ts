import { scryptAsync } from "@noble/hashes/scrypt.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { encodeUtf8 } from "./encoding";
import { randomBytes } from "./randomSource";
import { zeroize } from "./secretBytes";

/**
 * Password-based key derivation for the vault.
 *
 * The vault's confidentiality reduces entirely to this function. An attacker
 * who copies the extension's storage directory holds the ciphertext and can
 * grind passwords offline at whatever rate their hardware allows. The KDF's
 * only job is to make each guess expensive in a way GPUs and ASICs cannot
 * amortise away — which means MEMORY hardness, not iteration count.
 *
 * This is why plain PBKDF2 is rejected here. PBKDF2 is compute-hard but
 * memory-trivial, so a GPU evaluates it thousands of times in parallel.
 * MetaMask's historical PBKDF2 configuration is the bar we are deliberately
 * clearing, not matching.
 *
 * ---------------------------------------------------------------------------
 * WHY scrypt IS THE DEFAULT AND NOT Argon2id
 * ---------------------------------------------------------------------------
 * Argon2id is the better algorithm on paper and is the usual recommendation.
 * But we ship a pure-JavaScript implementation (no native module is available
 * to an MV3 service worker, and no WASM without relaxing our CSP posture), and
 * in that setting the two are not equally efficient.
 *
 * Measured on the development machine, @noble/hashes v1.8.0, Node 24:
 *
 *   Argon2id  m=19MiB   t=2  p=1        ~799 ms   (OWASP minimum)
 *   Argon2id  m=32MiB   t=2  p=1       ~1394 ms
 *   scrypt    N=2^15 r=8 p=1 (32MiB)    ~203 ms
 *   scrypt    N=2^16 r=8 p=1 (64MiB)    ~357 ms
 *   scrypt    N=2^17 r=8 p=1 (128MiB)   ~734 ms
 *
 * At an equal ~750ms of user-visible unlock latency, this scrypt build buys
 * 128 MiB of memory hardness where this Argon2id build buys 19 MiB — roughly a
 * 7x advantage in the property that actually resists parallel cracking. So the
 * default is scrypt at 128 MiB.
 *
 * Argon2id remains fully supported and selectable. Parameters are stored per
 * vault (see `VaultRecord`), so this is a per-vault decision that can be
 * re-tuned or migrated later without breaking existing wallets.
 */

export const KEY_DERIVATION_SALT_BYTE_LENGTH = 16;
export const ENCRYPTION_KEY_BYTE_LENGTH = 32; // AES-256

export interface ScryptKeyDerivationParams {
  algorithm: "scrypt";
  /** CPU/memory cost. Must be a power of two. Memory used is ~128 * N * r bytes. */
  costFactor: number;
  blockSize: number;
  parallelism: number;
}

export interface Argon2idKeyDerivationParams {
  algorithm: "argon2id";
  /** Number of passes over memory. */
  timeCost: number;
  /** Memory cost in KiB. */
  memoryCostInKibibytes: number;
  parallelism: number;
}

export type KeyDerivationParams = ScryptKeyDerivationParams | Argon2idKeyDerivationParams;

/**
 * ~734ms on a 2024-class laptop for 128 MiB of memory hardness.
 *
 * Chosen as the point where unlock still feels responsive. Raising the cost
 * factor to 2^18 doubles both memory and time; revisit as hardware improves.
 */
export const DEFAULT_KEY_DERIVATION_PARAMS: ScryptKeyDerivationParams = {
  algorithm: "scrypt",
  costFactor: 2 ** 17,
  blockSize: 8,
  parallelism: 1,
};

/** OWASP-minimum Argon2id, provided for vaults that select it explicitly. */
export const ARGON2ID_KEY_DERIVATION_PARAMS: Argon2idKeyDerivationParams = {
  algorithm: "argon2id",
  timeCost: 2,
  memoryCostInKibibytes: 19456,
  parallelism: 1,
};

export function createKeyDerivationSalt(): Uint8Array {
  return randomBytes(KEY_DERIVATION_SALT_BYTE_LENGTH);
}

/**
 * The most memory a derivation may be talked into allocating.
 *
 * 512 MiB, against a shipped default of 128 MiB. That is room for one full
 * doubling of the cost factor -- 2^18 at r=8 is 256 MiB, which CLAUDE.md
 * already names as the next step up -- so the ceiling cannot start rejecting
 * our own configuration if it is strengthened later, while staying an
 * allocation a service worker can actually attempt.
 *
 * Note that 2^19 at r=8 does NOT fit: 128 * r * (N + p) puts it a kilobyte
 * over. That is the correct reading rather than an oversight, because 2^19
 * would cost roughly three seconds per unlock and is not a configuration this
 * wallet would ship. Raise the ceiling deliberately if that ever changes; do
 * not raise it to make a test pass.
 */
const MAX_DERIVED_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_PARALLELISM = 4;
const MAX_SCRYPT_BLOCK_SIZE = 64;
const MAX_ARGON2ID_TIME_COST = 10;

/** Rejects NaN, Infinity, fractions and anything beyond exact integer range. */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

/**
 * Validates stored KDF parameters, in BOTH directions.
 *
 * ===========================================================================
 * WHY THERE IS A CEILING AND NOT ONLY A FLOOR
 * ===========================================================================
 * These numbers come out of the vault record, which is a plaintext file on
 * disk. The AAD binds them to the ciphertext, so they cannot be DOWNGRADED --
 * a weakened parameter fails the GCM tag check. But the tag is verified after
 * the key is derived, which means the derivation runs on whatever the record
 * says FIRST. Only the floors existed, so `costFactor: 2 ** 30` was accepted
 * and the unlock path tried to allocate a terabyte: not a slow unlock, a
 * wallet that cannot be opened again by any means the UI offers.
 *
 * This bounds the damage rather than eliminating it, and the distinction is
 * worth stating: anyone who can rewrite the vault record can also delete it.
 * What a ceiling buys is that the failure is a clean, immediate error instead
 * of a frozen worker or an out-of-memory crash, so a user with their recovery
 * phrase can reset and restore rather than staring at a wallet that hangs.
 *
 * ===========================================================================
 * THE POWER-OF-TWO CHECK USED TO BE A BITWISE ONE
 * ===========================================================================
 * `costFactor & (costFactor - 1)` coerces both operands to INT32. Every value
 * from 2^32 up therefore collapses to 0 and passed as a power of two --
 * including values that are not powers of two at all, such as 2^32 + 2^17.
 * Exactly the range the ceiling exists to reject, admitted by the check meant
 * to be strict about it. Tested by exponent instead.
 */
function assertValidParams(params: KeyDerivationParams): void {
  if (params.algorithm === "scrypt") {
    const { costFactor, blockSize, parallelism } = params;
    assertPositiveInteger(costFactor, "scrypt costFactor");
    assertPositiveInteger(blockSize, "scrypt blockSize");
    assertPositiveInteger(parallelism, "scrypt parallelism");

    const exponent = Math.log2(costFactor);
    if (!Number.isInteger(exponent) || exponent < 1) {
      throw new Error("scrypt costFactor must be a power of two greater than 1.");
    }

    // Reject parameters weaker than the 2015 baseline. A tampered storage
    // record must never be able to talk us into a cheap derivation.
    if (costFactor < 2 ** 14) throw new Error("scrypt costFactor is below the minimum of 2^14.");

    if (blockSize > MAX_SCRYPT_BLOCK_SIZE) {
      throw new Error(`scrypt blockSize exceeds the maximum of ${MAX_SCRYPT_BLOCK_SIZE}.`);
    }
    if (parallelism > MAX_PARALLELISM) {
      throw new Error(`scrypt parallelism exceeds the maximum of ${MAX_PARALLELISM}.`);
    }
    // ~128 * N * r for the mixing array, plus 128 * r * p for the working
    // blocks. Computed rather than bounded knob by knob, because the knobs
    // multiply: a modest N with an enormous r is the same allocation.
    const memoryBytes = 128 * blockSize * (costFactor + parallelism);
    if (memoryBytes > MAX_DERIVED_MEMORY_BYTES) {
      throw new Error("scrypt parameters would exceed the memory ceiling.");
    }
    return;
  }

  const { timeCost, memoryCostInKibibytes, parallelism } = params;
  assertPositiveInteger(timeCost, "argon2id timeCost");
  assertPositiveInteger(memoryCostInKibibytes, "argon2id memoryCostInKibibytes");
  assertPositiveInteger(parallelism, "argon2id parallelism");

  if (timeCost < 2) throw new Error("argon2id timeCost is below the minimum of 2.");
  if (memoryCostInKibibytes < 19456) {
    throw new Error("argon2id memoryCostInKibibytes is below the OWASP minimum of 19456.");
  }
  if (timeCost > MAX_ARGON2ID_TIME_COST) {
    throw new Error(`argon2id timeCost exceeds the maximum of ${MAX_ARGON2ID_TIME_COST}.`);
  }
  if (parallelism > MAX_PARALLELISM) {
    throw new Error(`argon2id parallelism exceeds the maximum of ${MAX_PARALLELISM}.`);
  }
  if (memoryCostInKibibytes * 1024 > MAX_DERIVED_MEMORY_BYTES) {
    throw new Error("argon2id memoryCostInKibibytes would exceed the memory ceiling.");
  }
}

export interface DeriveEncryptionKeyParams {
  password: string;
  salt: Uint8Array;
  params?: KeyDerivationParams;
}

/**
 * Derives the 32-byte AES-256 key from the user's password.
 *
 * Returns raw bytes rather than a CryptoKey so the caller controls the
 * lifetime and can zeroize. Import into WebCrypto happens at the point of use.
 */
export async function deriveEncryptionKey({
  password,
  salt,
  params = DEFAULT_KEY_DERIVATION_PARAMS,
}: DeriveEncryptionKeyParams): Promise<Uint8Array> {
  assertValidParams(params);
  if (salt.length < KEY_DERIVATION_SALT_BYTE_LENGTH) {
    throw new Error(`Salt must be at least ${KEY_DERIVATION_SALT_BYTE_LENGTH} bytes.`);
  }

  // NFKC normalisation so a password typed on a different keyboard/IME still
  // derives the same key. Without this, users with accented or CJK characters
  // can be permanently locked out of their own vault.
  const passwordBytes = encodeUtf8(password.normalize("NFKC"));

  try {
    if (params.algorithm === "scrypt") {
      return await scryptAsync(passwordBytes, salt, {
        N: params.costFactor,
        r: params.blockSize,
        p: params.parallelism,
        dkLen: ENCRYPTION_KEY_BYTE_LENGTH,
      });
    }
    return await argon2idAsync(passwordBytes, salt, {
      t: params.timeCost,
      m: params.memoryCostInKibibytes,
      p: params.parallelism,
      dkLen: ENCRYPTION_KEY_BYTE_LENGTH,
    });
  } finally {
    zeroize(passwordBytes);
  }
}
