import { randomBytes } from "../crypto/randomSource";
import { decodeBase64Url, decodeHex, encodeHex } from "../crypto/encoding";
import { zeroize } from "../crypto/secretBytes";
import { DEFAULT_KEY_DERIVATION_PARAMS, type KeyDerivationParams } from "../crypto/keyDerivation";
import { deriveAddressFromPrivateKey, isValidPrivateKey } from "../account/ethereumAddress";
import { assertAcceptablePassword } from "./passwordPolicy";
import {
  addHdAccount,
  createUnlockedKeyring,
  isUnlocked,
  LOCKED_KEYRING,
  lockKeyring,
  toVaultPayload,
  type Keyring,
  type KeyringAccount,
} from "../keyring/keyring";
import {
  createMnemonicPhrase,
  normalizeMnemonicPhrase,
  validateMnemonicPhrase,
  InvalidMnemonicError,
  type MnemonicStrength,
} from "../mnemonic/mnemonicPhrase";
import {
  changeVaultPassword,
  openVault,
  sealVault,
  sealVaultWithDerivedKey,
  unsealVault,
} from "../vault/vaultCipher";
import { VaultAlreadyExistsError, VaultLockedError, VaultNotFoundError } from "../vault/vaultErrors";
import type { KeyringSource, VaultPayload } from "../vault/vaultRecord";
import type { VaultStorage } from "../vault/vaultStorage";

/**
 * Re-exported so the engine still reads as one surface. The definitions live in
 * `passwordPolicy.ts` because the UI needs them and must not link against this
 * file to get them.
 */
export {
  assertAcceptablePassword,
  MINIMUM_PASSWORD_LENGTH,
  WeakPasswordError,
} from "./passwordPolicy";

/**
 * The wallet engine.
 *
 * Owns the transitions between locked and unlocked, and is the only component
 * that writes the vault. It is deliberately free of any chrome.* dependency —
 * storage arrives as an injected `VaultStorage` — so the entire lifecycle is
 * exercised in tests exactly as it runs in the service worker.
 *
 * Instantiated ONCE, in the background service worker. Never in the popup,
 * never in a content script.
 */

export interface WalletStatus {
  hasVault: boolean;
  isUnlocked: boolean;
  accounts: readonly KeyringAccount[];
}

export interface WalletServiceOptions {
  storage: VaultStorage;
  /** Overridable so tests can use cheap KDF parameters. */
  keyDerivationParams?: KeyDerivationParams;
  now?: () => number;
}

export interface CreateWalletParams {
  password: string;
  /** Omit to generate a fresh phrase. Supply to import an existing one. */
  mnemonic?: string;
  strength?: MnemonicStrength;
  passphrase?: string;
}

export interface CreateWalletResult {
  /**
   * Returned ONLY at creation, so onboarding can display it for backup. It is
   * never returned again without a password re-authentication — see
   * `revealMnemonic`.
   */
  mnemonic: string;
  accounts: readonly KeyringAccount[];
}

export class InvalidPrivateKeyError extends Error {
  readonly code = "invalid_private_key";
  constructor() {
    super("That is not a valid secp256k1 private key.");
    this.name = "InvalidPrivateKeyError";
  }
}

/**
 * An import whose address this wallet already controls.
 *
 * Refused rather than accepted, because there is no way back. Keyring sources
 * are append-only and there is no remove-account path, so a duplicate is
 * permanent short of resetting the wallet — two entries for one address, both
 * spending the same funds, and a user who assumes two entries means two
 * balances. Carries the address so the caller can say WHICH account it is.
 */
export class DuplicateAccountError extends Error {
  readonly code = "duplicate_account";
  readonly address: string;
  constructor(address: string) {
    super(`This wallet already holds ${address}.`);
    this.name = "DuplicateAccountError";
    this.address = address;
  }
}

function createKeyringSourceId(prefix: string): string {
  return `${prefix}_${encodeHex(randomBytes(8))}`;
}

/**
 * Key material retained for the duration of an unlocked session, so that
 * mutating operations can re-seal without re-prompting for the password.
 * Cleared by `lock()`.
 */
interface UnlockedSessionKey {
  encryptionKey: Uint8Array;
  salt: Uint8Array;
  keyDerivationParams: KeyDerivationParams;
  createdAt: number;
}

export class WalletService {
  private keyring: Keyring = LOCKED_KEYRING;
  private sessionKey: UnlockedSessionKey | undefined;
  private readonly storage: VaultStorage;
  private readonly keyDerivationParams: KeyDerivationParams | undefined;
  private readonly now: () => number;

  constructor({ storage, keyDerivationParams, now = Date.now }: WalletServiceOptions) {
    this.storage = storage;
    this.keyDerivationParams = keyDerivationParams;
    this.now = now;
  }

  async getStatus(): Promise<WalletStatus> {
    return {
      hasVault: await this.storage.exists(),
      isUnlocked: isUnlocked(this.keyring),
      accounts: isUnlocked(this.keyring) ? this.keyring.accounts : [],
    };
  }

  /**
   * Creates or imports a wallet and leaves it unlocked.
   *
   * Refuses when a vault already exists. Overwriting is the single most
   * destructive thing this codebase could do, so it is never implicit — the
   * caller must `resetWallet` first, behind an explicit confirmation.
   */
  async createWallet({
    password,
    mnemonic,
    strength = 128,
    passphrase = "",
  }: CreateWalletParams): Promise<CreateWalletResult> {
    if (await this.storage.exists()) throw new VaultAlreadyExistsError();
    assertAcceptablePassword(password);

    let phrase: string;
    if (mnemonic === undefined) {
      phrase = createMnemonicPhrase({ strength });
    } else {
      phrase = normalizeMnemonicPhrase(mnemonic);
      // Validate BEFORE sealing. An invalid phrase that reached storage would
      // produce a wallet whose addresses no other client can reproduce.
      if (!validateMnemonicPhrase(phrase)) throw new InvalidMnemonicError();
    }

    const payload: VaultPayload = {
      version: 1,
      keyringSources: [
        {
          type: "hd",
          id: createKeyringSourceId("kr_hd"),
          mnemonic: phrase,
          passphrase,
          accountCount: 1,
        },
      ],
    };

    await this.sealFromPassword(payload, password);
    this.keyring = createUnlockedKeyring({ payload, now: this.now });

    return { mnemonic: phrase, accounts: this.keyring.accounts };
  }

  async unlock(password: string): Promise<readonly KeyringAccount[]> {
    const record = await this.storage.read();
    if (!record) throw new VaultNotFoundError();

    // Throws IncorrectPasswordError on a bad password or tampered record.
    const { payload, encryptionKey, salt } = await unsealVault({ record, password });
    this.sessionKey = {
      encryptionKey,
      salt,
      keyDerivationParams: record.keyDerivation,
      createdAt: record.createdAt,
    };
    this.keyring = createUnlockedKeyring({ payload, now: this.now });
    return this.keyring.accounts;
  }

  /**
   * Drops all in-memory secrets.
   *
   * Safe to call when already locked, because it is invoked from the auto-lock
   * alarm, from explicit user action, and from worker teardown paths that
   * cannot know the current state.
   */
  lock(): void {
    this.keyring = lockKeyring(this.keyring);
    if (this.sessionKey) {
      // Overwrite the key bytes in place before releasing the reference. This
      // is a real erasure, unlike the mnemonic string, because typed-array
      // backing stores are mutable.
      zeroize(this.sessionKey.encryptionKey, this.sessionKey.salt);
      this.sessionKey = undefined;
    }
  }

  isUnlocked(): boolean {
    return isUnlocked(this.keyring);
  }

  /** Exposed to the signing layer only. Never serialise the result. */
  getKeyring(): Keyring {
    return this.keyring;
  }

  async addAccount(): Promise<KeyringAccount> {
    if (!isUnlocked(this.keyring)) throw new VaultLockedError();

    const hdSource = this.keyring.sources.find(
      (source): source is Extract<KeyringSource, { type: "hd" }> => source.type === "hd",
    );
    if (!hdSource) throw new Error("This wallet has no HD keyring to extend.");

    const extended = addHdAccount({ keyring: this.keyring, keyringSourceId: hdSource.id });
    // Re-seal so the new accountCount survives a lock.
    await this.persistUnlocked(extended);
    this.keyring = extended;

    const account = extended.accounts.at(-1);
    if (!account) throw new Error("Account derivation produced no account.");
    return account;
  }

  /**
   * Imports a standalone private key as its own keyring source.
   *
   * These accounts are NOT recoverable from the recovery phrase — they have no
   * relationship to the seed. The UI must mark them distinctly, because a user
   * who backs up their phrase and assumes imported accounts are covered will
   * lose them.
   */
  async importPrivateKey(privateKeyHex: string): Promise<KeyringAccount> {
    if (!isUnlocked(this.keyring)) throw new VaultLockedError();
    if (!isValidPrivateKey(privateKeyHex)) throw new InvalidPrivateKeyError();

    const normalized = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;

    /**
     * Derived and checked BEFORE anything is written.
     *
     * `createUnlockedKeyring` appends sources unconditionally, so without this
     * a key the wallet already holds becomes a SECOND account at the same
     * address. Both entries spend the same funds while appearing to be separate
     * balances, and nothing can remove either one.
     *
     * The check covers HD accounts too, not just previous imports: re-importing
     * the key of an account this wallet already derives is the likelier
     * mistake. What it CANNOT see is an HD account that exists in the seed but
     * has not been derived yet -- `accounts` holds `accountCount` of them, and
     * enumerating further would mean deriving without bound. That residual case
     * surfaces later as a duplicate the same way, and is left alone rather than
     * papered over with a guess at how many accounts to look ahead.
     */
    const bytes = decodeHex(normalized);
    let address: string;
    try {
      address = deriveAddressFromPrivateKey(bytes);
    } finally {
      zeroize(bytes);
    }
    const alreadyHeld = this.keyring.accounts.some(
      (account) => account.address.toLowerCase() === address.toLowerCase(),
    );
    if (alreadyHeld) throw new DuplicateAccountError(address);

    const sources: KeyringSource[] = [
      ...this.keyring.sources,
      { type: "privateKey", id: createKeyringSourceId("kr_pk"), privateKey: normalized },
    ];

    const payload: VaultPayload = { version: 1, keyringSources: sources };
    const next = createUnlockedKeyring({ payload, now: this.now });
    await this.persistUnlocked(next);
    this.keyring = next;

    const account = next.accounts.at(-1);
    if (!account) throw new Error("Import produced no account.");
    return account;
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const record = await this.storage.read();
    if (!record) throw new VaultNotFoundError();
    assertAcceptablePassword(nextPassword);

    // changeVaultPassword verifies the current password by fully opening the
    // vault first, so a typo cannot orphan the wallet under a password the user
    // never intended.
    const updated = await changeVaultPassword({
      record,
      currentPassword,
      nextPassword,
      ...(this.keyDerivationParams ? { keyDerivationParams: this.keyDerivationParams } : {}),
    });
    await this.storage.write(updated);

    // Refresh the retained key. Skipping this would leave the session holding
    // the key for the OLD password: the next addAccount() would re-seal under
    // it, and the user's new password would no longer open their wallet.
    if (this.sessionKey) {
      zeroize(this.sessionKey.encryptionKey, this.sessionKey.salt);
      const reopened = await unsealVault({ record: updated, password: nextPassword });
      this.sessionKey = {
        encryptionKey: reopened.encryptionKey,
        salt: reopened.salt,
        keyDerivationParams: updated.keyDerivation,
        createdAt: updated.createdAt,
      };
    }
  }

  /**
   * Returns the recovery phrase, gated on a fresh password check.
   *
   * Being unlocked is NOT sufficient. An unlocked wallet on an unattended
   * laptop must not surrender the seed to whoever walks past, so this
   * re-derives the KDF and re-opens the vault rather than reading the phrase
   * out of the in-memory keyring.
   */
  async revealMnemonic(password: string): Promise<string> {
    const record = await this.storage.read();
    if (!record) throw new VaultNotFoundError();

    const payload = await openVault({ record, password });
    const hdSource = payload.keyringSources.find((source) => source.type === "hd");
    if (!hdSource || hdSource.type !== "hd") {
      throw new Error("This wallet has no recovery phrase (imported keys only).");
    }
    return hdSource.mnemonic;
  }

  /**
   * Destroys the wallet on this device. Irreversible without the phrase.
   * Locks first, so no secrets survive in memory if the storage write fails.
   */
  async resetWallet(): Promise<void> {
    this.lock();
    await this.storage.clear();
  }

  /**
   * Re-seals using the session key held since unlock. Requires an unlocked
   * wallet by construction: no session key means no way to encrypt, which is
   * the property we want rather than a limitation to work around.
   */
  private async persistUnlocked(keyring: Keyring): Promise<void> {
    if (!this.sessionKey) throw new VaultLockedError();
    const record = await sealVaultWithDerivedKey({
      payload: toVaultPayload(keyring),
      encryptionKey: this.sessionKey.encryptionKey,
      salt: this.sessionKey.salt,
      keyDerivationParams: this.sessionKey.keyDerivationParams,
      createdAt: this.sessionKey.createdAt,
      now: this.now,
    });
    await this.storage.write(record);
  }

  private async sealFromPassword(payload: VaultPayload, password: string): Promise<void> {
    const keyDerivationParams = this.keyDerivationParams ?? DEFAULT_KEY_DERIVATION_PARAMS;
    const record = await sealVault({ payload, password, keyDerivationParams, now: this.now });
    await this.storage.write(record);
    // Retain the key so the freshly created wallet can add accounts without
    // asking for the password again.
    this.sessionKey = {
      encryptionKey: (await unsealVault({ record, password })).encryptionKey,
      salt: decodeBase64Url(record.salt),
      keyDerivationParams,
      createdAt: record.createdAt,
    };
  }
}
