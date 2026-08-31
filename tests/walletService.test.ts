import { beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateAccountError,
  InvalidPrivateKeyError,
  MINIMUM_PASSWORD_LENGTH,
  WalletService,
  WeakPasswordError,
} from "@/core/wallet/walletService";
import {
  createMemoryStorageArea,
  createVaultStorage,
  VAULT_STORAGE_KEY,
  type KeyValueStorageArea,
} from "@/core/vault/vaultStorage";
import {
  IncorrectPasswordError,
  VaultAlreadyExistsError,
  VaultLockedError,
  VaultNotFoundError,
} from "@/core/vault/vaultErrors";
import { InvalidMnemonicError } from "@/core/mnemonic/mnemonicPhrase";
import type { KeyDerivationParams } from "@/core/crypto/keyDerivation";

const FAST_SCRYPT: KeyDerivationParams = {
  algorithm: "scrypt",
  costFactor: 2 ** 14,
  blockSize: 8,
  parallelism: 1,
};

const PASSWORD = "a good long password";
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FIRST_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SECOND_ADDRESS = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

/**
 * Every string VALUE in a stored record, flattened.
 *
 * Deliberately excludes object keys -- see the test below for why matching
 * against them turned a security assertion into a coin flip.
 */
function storedStringValues(value: unknown): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object" && node !== null) {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return found.join("\n");
}

let area: KeyValueStorageArea;
let service: WalletService;

beforeEach(() => {
  area = createMemoryStorageArea();
  service = new WalletService({
    storage: createVaultStorage(area),
    keyDerivationParams: FAST_SCRYPT,
  });
});

describe("createWallet", () => {
  it("generates a 12-word phrase and one account by default", async () => {
    const result = await service.createWallet({ password: PASSWORD });
    expect(result.mnemonic.split(" ")).toHaveLength(12);
    expect(result.accounts).toHaveLength(1);
    expect(service.isUnlocked()).toBe(true);
  });

  it("supports 24-word creation", async () => {
    const result = await service.createWallet({ password: PASSWORD, strength: 256 });
    expect(result.mnemonic.split(" ")).toHaveLength(24);
  });

  it("imports an existing phrase to the expected address", async () => {
    const result = await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    expect(result.accounts[0]?.address).toBe(FIRST_ADDRESS);
  });

  it("derives a different wallet when a BIP-39 passphrase is supplied", async () => {
    const result = await service.createWallet({
      password: PASSWORD,
      mnemonic: PHRASE,
      passphrase: "hidden",
    });
    expect(result.accounts[0]?.address).not.toBe(FIRST_ADDRESS);
  });

  it("rejects an invalid phrase before writing anything", async () => {
    await expect(
      service.createWallet({ password: PASSWORD, mnemonic: "clearly not a phrase" }),
    ).rejects.toThrow(InvalidMnemonicError);
    expect(await service.getStatus()).toMatchObject({ hasVault: false });
  });

  it("rejects a short password", async () => {
    await expect(service.createWallet({ password: "short" })).rejects.toThrow(WeakPasswordError);
    expect(MINIMUM_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  /** Overwriting an existing vault would be an unrecoverable loss of funds. */
  it("refuses to overwrite an existing wallet", async () => {
    await service.createWallet({ password: PASSWORD });
    await expect(service.createWallet({ password: PASSWORD })).rejects.toThrow(
      VaultAlreadyExistsError,
    );
  });

  /**
   * The most important assertion in this file, and it has to be reliable.
   *
   * It searches the record's string VALUES, never `JSON.stringify` of the whole
   * object. The field names are part of the schema, not of the secret, and
   * several of them contain BIP-39 words as substrings -- "text" inside
   * `ciphertext`, "cost" inside `costFactor`, "initial" inside
   * `initializationVector`. Matching against those made a security test fail
   * roughly one run in six on a phrase it had no business objecting to, which
   * is how a real failure ends up being waved through as "the flaky one".
   */
  it("writes only ciphertext to storage", async () => {
    const { mnemonic } = await service.createWallet({ password: PASSWORD });
    const stored = storedStringValues(await area.get(VAULT_STORAGE_KEY));

    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(mnemonic);

    /**
     * Any two ADJACENT words, which is the assertion a random phrase can carry
     * without flaking: the pair contains a space, and base64url has no space in
     * its alphabet, so a chance collision is impossible rather than merely
     * unlikely. Anything that wrote the phrase out -- whole, truncated, or
     * re-joined -- trips this.
     */
    const words = mnemonic.split(" ");
    for (let index = 0; index + 1 < words.length; index += 1) {
      expect(stored).not.toContain(`${words[index]} ${words[index + 1]}`);
    }
  });

  /**
   * The per-WORD check, which only a fixed phrase can make without flaking.
   *
   * A single short word can appear inside base64url by chance, so running this
   * against a freshly generated phrase would fail at random. Against a known
   * phrase it is deterministic: it either passes forever or it has found
   * something.
   */
  it("writes no individual word of a known phrase to storage", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    const stored = storedStringValues(await area.get(VAULT_STORAGE_KEY));
    for (const word of new Set(PHRASE.split(" "))) {
      expect(stored, `"${word}" must not appear in the stored vault`).not.toContain(word);
    }
  });
});

describe("unlock / lock", () => {
  beforeEach(async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    service.lock();
  });

  it("restores the same accounts after unlock", async () => {
    expect((await service.unlock(PASSWORD))[0]?.address).toBe(FIRST_ADDRESS);
  });

  it("rejects a wrong password", async () => {
    await expect(service.unlock("wrong password")).rejects.toThrow(IncorrectPasswordError);
    expect(service.isUnlocked()).toBe(false);
  });

  it("reports locked status with no accounts", async () => {
    expect(await service.getStatus()).toMatchObject({
      hasVault: true,
      isUnlocked: false,
      accounts: [],
    });
  });

  it("refuses to unlock when no wallet exists", async () => {
    const empty = new WalletService({
      storage: createVaultStorage(createMemoryStorageArea()),
      keyDerivationParams: FAST_SCRYPT,
    });
    await expect(empty.unlock(PASSWORD)).rejects.toThrow(VaultNotFoundError);
  });

  it("is safe to lock twice", async () => {
    await service.unlock(PASSWORD);
    service.lock();
    expect(() => service.lock()).not.toThrow();
    expect(service.isUnlocked()).toBe(false);
  });
});

describe("addAccount", () => {
  it("adds the next sequential account without asking for the password again", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    expect((await service.addAccount()).address).toBe(SECOND_ADDRESS);
  });

  /** The account must survive a lock, which means the vault was re-sealed. */
  it("persists the new account across lock and unlock", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    await service.addAccount();
    service.lock();
    const accounts = await service.unlock(PASSWORD);
    expect(accounts).toHaveLength(2);
    expect(accounts[1]?.address).toBe(SECOND_ADDRESS);
  });

  it("refuses while locked", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    service.lock();
    await expect(service.addAccount()).rejects.toThrow(VaultLockedError);
  });
});

describe("importPrivateKey", () => {
  const KEY = `0x${"11".repeat(32)}`;

  it("imports and persists a raw key", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    const account = await service.importPrivateKey(KEY);
    expect(account.source).toBe("privateKey");
    service.lock();
    expect((await service.unlock(PASSWORD)).map((a) => a.address)).toContain(account.address);
  });

  it("rejects an invalid key", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    await expect(service.importPrivateKey(`0x${"00".repeat(32)}`)).rejects.toThrow(
      InvalidPrivateKeyError,
    );
  });

  it("refuses while locked", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    service.lock();
    await expect(service.importPrivateKey(KEY)).rejects.toThrow(VaultLockedError);
  });

  /**
   * Keyring sources are append-only and nothing removes an account, so an
   * accepted duplicate is permanent: two entries, one address, one balance
   * shown twice. These three cases are the ways to arrive at one.
   */
  it("refuses a key it already holds, and writes nothing", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    const account = await service.importPrivateKey(KEY);

    await expect(service.importPrivateKey(KEY)).rejects.toThrow(DuplicateAccountError);

    // Unchanged in memory AND on disk -- a refusal that still persisted the
    // source would produce the duplicate on the next unlock instead of now.
    const inMemory = (await service.getStatus()).accounts;
    expect(inMemory.filter((a) => a.address === account.address)).toHaveLength(1);
    service.lock();
    const reopened = await service.unlock(PASSWORD);
    expect(reopened.filter((a) => a.address === account.address)).toHaveLength(1);
  });

  it("sees through 0x prefixing and case", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    // Deliberately not `KEY`: that one is all digits, so an uppercase variant
    // of it is the SAME string and would assert nothing. These 32 bytes have
    // hex letters in them, so the three spellings below are three different
    // strings for one key -- which is the whole point of comparing the derived
    // address rather than the text.
    const lettered = `0x${"ab".repeat(32)}`;
    await service.importPrivateKey(lettered);

    await expect(service.importPrivateKey("ab".repeat(32))).rejects.toThrow(DuplicateAccountError);
    await expect(service.importPrivateKey(`0x${"AB".repeat(32)}`)).rejects.toThrow(
      DuplicateAccountError,
    );
  });

  /**
   * The likelier mistake: re-importing the key of an account the wallet already
   * DERIVES, having exported it from somewhere else.
   *
   * The key below is account 0 of the `abandon...about` phrase -- a published
   * vector, not something this code produced. If the derivation ever changed,
   * this test would stop finding a collision and fail rather than pass quietly.
   */
  it("refuses a key matching an account derived from the phrase", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    const firstAccountKey = "0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727";

    await expect(service.importPrivateKey(firstAccountKey)).rejects.toThrow(DuplicateAccountError);
    await expect(service.importPrivateKey(firstAccountKey)).rejects.toThrow(FIRST_ADDRESS);
  });
});

describe("changePassword", () => {
  beforeEach(async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
  });

  it("makes the new password work and the old one fail", async () => {
    await service.changePassword(PASSWORD, "an even better password");
    service.lock();
    await expect(service.unlock(PASSWORD)).rejects.toThrow(IncorrectPasswordError);
    await expect(service.unlock("an even better password")).resolves.toHaveLength(1);
  });

  it("rejects a wrong current password", async () => {
    await expect(service.changePassword("nope nope nope", "another password")).rejects.toThrow(
      IncorrectPasswordError,
    );
  });

  it("rejects a weak new password", async () => {
    await expect(service.changePassword(PASSWORD, "short")).rejects.toThrow(WeakPasswordError);
  });

  /**
   * Regression guard: if the session key is not refreshed on password change,
   * the next re-seal encrypts under the OLD key and the user's brand-new
   * password silently stops opening their wallet.
   */
  it("re-seals subsequent changes under the NEW password", async () => {
    await service.changePassword(PASSWORD, "an even better password");
    await service.addAccount();
    service.lock();
    expect(await service.unlock("an even better password")).toHaveLength(2);
  });
});

describe("revealMnemonic", () => {
  it("returns the phrase when the password is correct", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    expect(await service.revealMnemonic(PASSWORD)).toBe(PHRASE);
  });

  /**
   * Being unlocked must not be enough. An unlocked wallet on an unattended
   * machine must not hand the seed to whoever walks past.
   */
  it("requires re-authentication even while unlocked", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    expect(service.isUnlocked()).toBe(true);
    await expect(service.revealMnemonic("wrong password")).rejects.toThrow(IncorrectPasswordError);
  });
});

describe("resetWallet", () => {
  it("clears storage and locks", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    await service.resetWallet();
    expect(await service.getStatus()).toMatchObject({ hasVault: false, isUnlocked: false });
    expect(await area.get(VAULT_STORAGE_KEY)).toBeUndefined();
  });

  it("allows creating a fresh wallet afterwards", async () => {
    await service.createWallet({ password: PASSWORD, mnemonic: PHRASE });
    await service.resetWallet();
    await expect(service.createWallet({ password: PASSWORD })).resolves.toBeDefined();
  });
});
