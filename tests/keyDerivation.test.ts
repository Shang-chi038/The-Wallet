import { describe, expect, it } from "vitest";
import {
  ARGON2ID_KEY_DERIVATION_PARAMS,
  createKeyDerivationSalt,
  DEFAULT_KEY_DERIVATION_PARAMS,
  deriveEncryptionKey,
  ENCRYPTION_KEY_BYTE_LENGTH,
  KEY_DERIVATION_SALT_BYTE_LENGTH,
  type KeyDerivationParams,
} from "@/core/crypto/keyDerivation";
import { encodeHex } from "@/core/crypto/encoding";

/** Cheapest parameters the validator accepts, so tests stay fast. */
const FAST_SCRYPT: KeyDerivationParams = {
  algorithm: "scrypt",
  costFactor: 2 ** 14,
  blockSize: 8,
  parallelism: 1,
};

describe("createKeyDerivationSalt", () => {
  it("returns a 16-byte salt", () => {
    expect(createKeyDerivationSalt().length).toBe(KEY_DERIVATION_SALT_BYTE_LENGTH);
  });

  it("never repeats", () => {
    const salts = new Set(Array.from({ length: 100 }, () => encodeHex(createKeyDerivationSalt())));
    expect(salts.size).toBe(100);
  });
});

describe("deriveEncryptionKey", () => {
  const salt = new Uint8Array(KEY_DERIVATION_SALT_BYTE_LENGTH).fill(7);

  it("returns a 32-byte key for AES-256", async () => {
    const key = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    expect(key.length).toBe(ENCRYPTION_KEY_BYTE_LENGTH);
  });

  it("is deterministic for the same password, salt and params", async () => {
    const first = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    const second = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    expect(encodeHex(first)).toBe(encodeHex(second));
  });

  it("produces a different key for a different password", async () => {
    const first = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    const second = await deriveEncryptionKey({ password: "hunter3", salt, params: FAST_SCRYPT });
    expect(encodeHex(first)).not.toBe(encodeHex(second));
  });

  it("produces a different key for a different salt", async () => {
    const otherSalt = new Uint8Array(KEY_DERIVATION_SALT_BYTE_LENGTH).fill(8);
    const first = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    const second = await deriveEncryptionKey({
      password: "hunter2",
      salt: otherSalt,
      params: FAST_SCRYPT,
    });
    expect(encodeHex(first)).not.toBe(encodeHex(second));
  });

  it("normalizes passwords to NFKC so equivalent Unicode forms unlock the same vault", async () => {
    // U+00E9 (precomposed e-acute) vs U+0065 U+0301 (e + combining acute).
    // Without normalisation these are different byte strings and the user is
    // permanently locked out depending on which keyboard they used.
    const precomposed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(precomposed).not.toBe(decomposed);
    const first = await deriveEncryptionKey({ password: precomposed, salt, params: FAST_SCRYPT });
    const second = await deriveEncryptionKey({ password: decomposed, salt, params: FAST_SCRYPT });
    expect(encodeHex(first)).toBe(encodeHex(second));
  });

  it("supports argon2id as an alternative", async () => {
    const key = await deriveEncryptionKey({
      password: "hunter2",
      salt,
      params: ARGON2ID_KEY_DERIVATION_PARAMS,
    });
    expect(key.length).toBe(ENCRYPTION_KEY_BYTE_LENGTH);
  });

  it("derives different keys from scrypt and argon2id for the same password", async () => {
    const viaScrypt = await deriveEncryptionKey({ password: "hunter2", salt, params: FAST_SCRYPT });
    const viaArgon = await deriveEncryptionKey({
      password: "hunter2",
      salt,
      params: ARGON2ID_KEY_DERIVATION_PARAMS,
    });
    expect(encodeHex(viaScrypt)).not.toBe(encodeHex(viaArgon));
  });

  describe("parameter floors", () => {
    it("rejects a scrypt cost factor below 2^14", async () => {
      await expect(
        deriveEncryptionKey({
          password: "hunter2",
          salt,
          params: { algorithm: "scrypt", costFactor: 2 ** 10, blockSize: 8, parallelism: 1 },
        }),
      ).rejects.toThrow(/costFactor is below the minimum/);
    });

    it("rejects a non-power-of-two scrypt cost factor", async () => {
      await expect(
        deriveEncryptionKey({
          password: "hunter2",
          salt,
          params: { algorithm: "scrypt", costFactor: 100000, blockSize: 8, parallelism: 1 },
        }),
      ).rejects.toThrow(/power of two/);
    });

    it("rejects argon2id memory below the OWASP minimum", async () => {
      await expect(
        deriveEncryptionKey({
          password: "hunter2",
          salt,
          params: {
            algorithm: "argon2id",
            timeCost: 2,
            memoryCostInKibibytes: 1024,
            parallelism: 1,
          },
        }),
      ).rejects.toThrow(/OWASP minimum/);
    });

    it("rejects a salt shorter than 16 bytes", async () => {
      await expect(
        deriveEncryptionKey({ password: "hunter2", salt: new Uint8Array(8), params: FAST_SCRYPT }),
      ).rejects.toThrow(/Salt must be at least/);
    });
  });

  it("ships a memory-hard default", () => {
    expect(DEFAULT_KEY_DERIVATION_PARAMS.algorithm).toBe("scrypt");
    expect(DEFAULT_KEY_DERIVATION_PARAMS.costFactor).toBeGreaterThanOrEqual(2 ** 17);
  });
});

/**
 * The CEILING, which is newer than the floor and exists for a different attack.
 *
 * KDF parameters come out of the vault record -- a plaintext file on disk. The
 * AAD binds them to the ciphertext so they cannot be downgraded, but the tag is
 * checked AFTER the key is derived, so the derivation runs on whatever the
 * record says first. With only floors, `costFactor: 2 ** 30` was accepted and
 * unlock tried to allocate a terabyte.
 */
describe("key derivation parameter ceiling", () => {
  const password = "a good long password";
  const salt = new Uint8Array(16);

  async function derive(params: unknown) {
    return deriveEncryptionKey({ password, salt, params: params as KeyDerivationParams });
  }

  it("refuses a cost factor that would allocate far beyond the ceiling", async () => {
    await expect(
      derive({ algorithm: "scrypt", costFactor: 2 ** 30, blockSize: 8, parallelism: 1 }),
    ).rejects.toThrow(/memory ceiling/);
  });

  it("refuses an enormous block size, which multiplies with the cost factor", async () => {
    await expect(
      derive({ algorithm: "scrypt", costFactor: 2 ** 14, blockSize: 4096, parallelism: 1 }),
    ).rejects.toThrow(/blockSize exceeds/);
  });

  it("refuses runaway parallelism", async () => {
    await expect(
      derive({ algorithm: "scrypt", costFactor: 2 ** 14, blockSize: 8, parallelism: 1_000_000 }),
    ).rejects.toThrow(/parallelism exceeds/);
  });

  /**
   * These are all rejected, and it is the MEMORY CEILING that rejects them --
   * not the power-of-two check, because 2^32, 2^33 and 2^40 genuinely are
   * powers of two. Asserted on the specific message so the test says which
   * guard is load-bearing rather than merely that something threw.
   */
  it.each([2 ** 32, 2 ** 33, 2 ** 40])(
    "refuses the absurd cost factor %d on memory grounds",
    async (costFactor) => {
      await expect(
        derive({ algorithm: "scrypt", costFactor, blockSize: 8, parallelism: 1 }),
      ).rejects.toThrow(/memory ceiling/);
    },
  );

  /**
   * The power-of-two check itself, pinned at a size the ceiling does not
   * already catch.
   *
   * It was `costFactor & (costFactor - 1)`, which coerces to int32, so every
   * value from 2^32 up collapsed to 0 and passed as a power of two. 2^32 and
   * 2^40 really are powers of two, so the ceiling catches those either way --
   * the value that separates the two implementations is a non-power-of-two
   * above the coercion boundary, which the fixed check names correctly and the
   * bitwise one waved through to be rejected for the wrong reason.
   */
  it.each([100_000, 2 ** 32 + 2 ** 17])(
    "refuses the non-power-of-two cost factor %d, and says so",
    async (costFactor) => {
      await expect(
        derive({ algorithm: "scrypt", costFactor, blockSize: 8, parallelism: 1 }),
      ).rejects.toThrow(/power of two/);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0, -8])(
    "refuses the non-integer or non-positive cost factor %p",
    async (costFactor) => {
      await expect(
        derive({ algorithm: "scrypt", costFactor, blockSize: 8, parallelism: 1 }),
      ).rejects.toThrow(/scrypt costFactor must be a positive integer|power of two/);
    },
  );

  /**
   * `NaN < 1` is false, so the old floor let this through and the memory
   * calculation came out NaN, which is not `> ceiling` either.
   *
   * Matched on OUR message, prefixed with the field name. @noble/hashes throws
   * "positive integer expected, got NaN" for the same input, so a looser regex
   * passes whether or not this wallet checks anything -- which is exactly how
   * this test read before a mutation run caught it.
   */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0])(
    "refuses the block size %p itself rather than leaving it to the KDF",
    async (blockSize) => {
      await expect(
        derive({ algorithm: "scrypt", costFactor: 2 ** 14, blockSize, parallelism: 1 }),
      ).rejects.toThrow(/scrypt blockSize must be a positive integer/);
    },
  );

  it.each([Number.NaN, 2.5, 0])(
    "refuses the parallelism %p itself rather than leaving it to the KDF",
    async (parallelism) => {
      await expect(
        derive({ algorithm: "scrypt", costFactor: 2 ** 14, blockSize: 8, parallelism }),
      ).rejects.toThrow(/scrypt parallelism must be a positive integer/);
    },
  );

  it("refuses an argon2id memory cost above the ceiling", async () => {
    await expect(
      derive({ algorithm: "argon2id", timeCost: 2, memoryCostInKibibytes: 4_194_304, parallelism: 1 }),
    ).rejects.toThrow(/memory ceiling/);
  });

  it("refuses an argon2id time cost above the ceiling", async () => {
    await expect(
      derive({ algorithm: "argon2id", timeCost: 5000, memoryCostInKibibytes: 19456, parallelism: 1 }),
    ).rejects.toThrow(/timeCost exceeds/);
  });

  it("still accepts both shipped defaults, with headroom to strengthen", async () => {
    await expect(derive(DEFAULT_KEY_DERIVATION_PARAMS)).resolves.toBeInstanceOf(Uint8Array);
    await expect(derive(ARGON2ID_KEY_DERIVATION_PARAMS)).resolves.toBeInstanceOf(Uint8Array);
  });

  /**
   * The headroom is one doubling, and it is asserted rather than described so
   * that shrinking the ceiling later fails here instead of at someone's unlock.
   */
  it("leaves room for the next cost-factor step up, but not two", async () => {
    const memoryBytes = (costFactor: number) => 128 * 8 * (costFactor + 1);
    expect(memoryBytes(2 ** 18)).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(memoryBytes(2 ** 19)).toBeGreaterThan(512 * 1024 * 1024);

    await expect(
      derive({ algorithm: "scrypt", costFactor: 2 ** 18, blockSize: 8, parallelism: 1 }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
