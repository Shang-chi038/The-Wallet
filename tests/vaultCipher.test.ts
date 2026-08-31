import { describe, expect, it } from "vitest";
import { changeVaultPassword, openVault, sealVault } from "@/core/vault/vaultCipher";
import {
  IncorrectPasswordError,
  UnsupportedVaultVersionError,
  VaultCorruptedError,
} from "@/core/vault/vaultErrors";
import type { VaultPayload, VaultRecord } from "@/core/vault/vaultRecord";
import type { KeyDerivationParams } from "@/core/crypto/keyDerivation";
import { decodeBase64Url, encodeBase64Url } from "@/core/crypto/encoding";

const FAST_SCRYPT: KeyDerivationParams = {
  algorithm: "scrypt",
  costFactor: 2 ** 14,
  blockSize: 8,
  parallelism: 1,
};

const PASSWORD = "correct horse battery staple";

const PAYLOAD: VaultPayload = {
  version: 1,
  keyringSources: [
    {
      type: "hd",
      id: "keyring_hd_1",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      passphrase: "",
      accountCount: 2,
    },
  ],
};

function seal(overrides: Partial<Parameters<typeof sealVault>[0]> = {}) {
  return sealVault({
    payload: PAYLOAD,
    password: PASSWORD,
    keyDerivationParams: FAST_SCRYPT,
    ...overrides,
  });
}

describe("sealVault", () => {
  it("round-trips the payload", async () => {
    const record = await seal();
    expect(await openVault({ record, password: PASSWORD })).toEqual(PAYLOAD);
  });

  it("never writes the mnemonic in the clear", async () => {
    const serialized = JSON.stringify(await seal());
    expect(serialized).not.toContain("abandon");
    expect(serialized).not.toContain(PASSWORD);
  });

  it("does not persist the password or any derived key", async () => {
    const fields = Object.keys(await seal()).join(",");
    expect(fields).not.toMatch(/password|key(?!Derivation)/i);
  });

  it("uses a fresh salt and IV on every seal", async () => {
    const first = await seal();
    const second = await seal();
    expect(first.salt).not.toBe(second.salt);
    expect(first.initializationVector).not.toBe(second.initializationVector);
    // Same plaintext, same password, but the ciphertexts must not match —
    // otherwise an observer could tell that the vault contents were unchanged.
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("records the KDF parameters it used", async () => {
    expect((await seal()).keyDerivation).toEqual(FAST_SCRYPT);
  });

  it("stamps createdAt and updatedAt", async () => {
    const record = await seal({ now: () => 1_700_000_000_000 });
    expect(record.createdAt).toBe(1_700_000_000_000);
    expect(record.updatedAt).toBe(1_700_000_000_000);
  });
});

describe("openVault", () => {
  it("rejects a wrong password", async () => {
    const record = await seal();
    await expect(openVault({ record, password: "wrong password" })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("rejects an empty password when one was set", async () => {
    const record = await seal();
    await expect(openVault({ record, password: "" })).rejects.toThrow(IncorrectPasswordError);
  });

  it("reports a future vault version rather than guessing at its contents", async () => {
    const record = { ...(await seal()), version: 99 } as unknown as VaultRecord;
    await expect(openVault({ record, password: PASSWORD })).rejects.toThrow(
      UnsupportedVaultVersionError,
    );
  });

  it("rejects an unrecognised cipher", async () => {
    const record = { ...(await seal()), cipher: "aes-256-cbc" } as unknown as VaultRecord;
    await expect(openVault({ record, password: PASSWORD })).rejects.toThrow(VaultCorruptedError);
  });
});

/**
 * These are the tests that justify choosing an AEAD and binding the header into
 * the tag. Storage is attacker-writable, so every one of these edits is
 * something a real attacker can perform on a stolen profile directory.
 */
describe("tamper resistance", () => {
  it("detects a flipped bit in the ciphertext", async () => {
    const record = await seal();
    const ciphertext = decodeBase64Url(record.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x01;
    const tampered: VaultRecord = { ...record, ciphertext: encodeBase64Url(ciphertext) };
    await expect(openVault({ record: tampered, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("detects a truncated ciphertext", async () => {
    const record = await seal();
    const ciphertext = decodeBase64Url(record.ciphertext);
    const tampered: VaultRecord = {
      ...record,
      ciphertext: encodeBase64Url(ciphertext.slice(0, -1)),
    };
    await expect(openVault({ record: tampered, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("detects a modified initialization vector", async () => {
    const record = await seal();
    const iv = decodeBase64Url(record.initializationVector);
    iv[0] = (iv[0] ?? 0) ^ 0xff;
    const tampered: VaultRecord = { ...record, initializationVector: encodeBase64Url(iv) };
    await expect(openVault({ record: tampered, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("detects a modified salt", async () => {
    const record = await seal();
    const salt = decodeBase64Url(record.salt);
    salt[0] = (salt[0] ?? 0) ^ 0xff;
    const tampered: VaultRecord = { ...record, salt: encodeBase64Url(salt) };
    await expect(openVault({ record: tampered, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  /**
   * The attack the AAD binding exists to stop: rewrite the stored KDF cost down
   * to something crackable, then wait for the user to unlock and capture a key
   * that took milliseconds to derive.
   */
  it("refuses a downgraded KDF cost factor", async () => {
    const record = await seal();
    const downgraded: VaultRecord = {
      ...record,
      keyDerivation: { algorithm: "scrypt", costFactor: 2 ** 14, blockSize: 1, parallelism: 1 },
    };
    await expect(openVault({ record: downgraded, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("refuses a KDF algorithm swap", async () => {
    const record = await seal();
    const swapped: VaultRecord = {
      ...record,
      keyDerivation: {
        algorithm: "argon2id",
        timeCost: 2,
        memoryCostInKibibytes: 19456,
        parallelism: 1,
      },
    };
    await expect(openVault({ record: swapped, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("rejects malformed base64 encoding", async () => {
    const record = await seal();
    const tampered = { ...record, ciphertext: "!!!not base64!!!" } as VaultRecord;
    await expect(openVault({ record: tampered, password: PASSWORD })).rejects.toThrow();
  });
});

describe("changeVaultPassword", () => {
  it("re-seals under the new password", async () => {
    const record = await seal();
    const updated = await changeVaultPassword({
      record,
      currentPassword: PASSWORD,
      nextPassword: "a brand new password",
      keyDerivationParams: FAST_SCRYPT,
    });
    expect(await openVault({ record: updated, password: "a brand new password" })).toEqual(PAYLOAD);
  });

  it("invalidates the old password", async () => {
    const record = await seal();
    const updated = await changeVaultPassword({
      record,
      currentPassword: PASSWORD,
      nextPassword: "a brand new password",
      keyDerivationParams: FAST_SCRYPT,
    });
    await expect(openVault({ record: updated, password: PASSWORD })).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("refuses when the current password is wrong, leaving the vault intact", async () => {
    const record = await seal();
    await expect(
      changeVaultPassword({
        record,
        currentPassword: "not the password",
        nextPassword: "whatever",
        keyDerivationParams: FAST_SCRYPT,
      }),
    ).rejects.toThrow(IncorrectPasswordError);
    expect(await openVault({ record, password: PASSWORD })).toEqual(PAYLOAD);
  });

  it("preserves createdAt while advancing updatedAt", async () => {
    const record = await seal({ now: () => 1_000 });
    const updated = await changeVaultPassword({
      record,
      currentPassword: PASSWORD,
      nextPassword: "next",
      keyDerivationParams: FAST_SCRYPT,
    });
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBeGreaterThan(1_000);
  });

  it("re-salts, so the two ciphertexts cannot be attacked as a pair", async () => {
    const record = await seal();
    const updated = await changeVaultPassword({
      record,
      currentPassword: PASSWORD,
      nextPassword: "next",
      keyDerivationParams: FAST_SCRYPT,
    });
    expect(updated.salt).not.toBe(record.salt);
  });
});
