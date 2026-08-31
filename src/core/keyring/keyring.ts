import {
  deriveAccountKeyFromSeed,
  deriveAccountSummariesFromSeed,
} from "../account/hierarchicalDeterministicKey";
import { deriveAddressFromPrivateKey } from "../account/ethereumAddress";
import { decodeHex } from "../crypto/encoding";
import { zeroize } from "../crypto/secretBytes";
import { deriveSeedFromMnemonic } from "../mnemonic/mnemonicPhrase";
import { VaultLockedError } from "../vault/vaultErrors";
import type { KeyringSource, VaultPayload } from "../vault/vaultRecord";
import { HDKey } from "@scure/bip32";
import {
  createBitcoinAccountBasePath,
  createBitcoinDerivationPath,
} from "../bitcoin/derivationPath";
import {
  findBitcoinNetwork,
  type BitcoinNetworkName,
} from "../bitcoin/bitcoinNetwork";

/**
 * The unlocked keyring: the wallet's in-memory secret state.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL SECURITY INVARIANT
 * ---------------------------------------------------------------------------
 * This object exists ONLY inside the background service worker. It is never
 * serialised, never sent over a message port, never written to any storage
 * area, and never reachable from the popup, a content script, or a page.
 * Clients ask the service worker to *perform* an operation; they never receive
 * the material that performs it.
 *
 * Private keys are NOT cached here. The keyring holds the mnemonic and derives
 * the one private key a signature needs, at the moment it needs it, then
 * zeroizes it (see `withAccountPrivateKey`). So a heap snapshot taken while the
 * wallet is unlocked but idle contains no per-account private keys — only the
 * seed material, which is one secret instead of N.
 *
 * Deriving per signature costs a few milliseconds of BIP-32 work. That is an
 * entirely acceptable price for shrinking the window in which key material is
 * resident.
 */

export type KeyringAccountSource = "hd" | "privateKey";

export interface KeyringAccount {
  /** Stable identifier, safe to expose to the UI. */
  id: string;
  address: string;
  source: KeyringAccountSource;
  /** Present for HD accounts only. */
  derivationPath?: string;
  addressIndex?: number;
  keyringSourceId: string;
}

export interface UnlockedKeyring {
  readonly status: "unlocked";
  readonly accounts: readonly KeyringAccount[];
  /**
   * Secret material. Deliberately not `readonly` at the byte level so it can be
   * cleared in place by `lockKeyring`.
   */
  readonly sources: KeyringSource[];
  readonly unlockedAt: number;
}

export interface LockedKeyring {
  readonly status: "locked";
}

export type Keyring = UnlockedKeyring | LockedKeyring;

export const LOCKED_KEYRING: LockedKeyring = { status: "locked" };

export interface CreateUnlockedKeyringParams {
  payload: VaultPayload;
  now?: () => number;
}

/**
 * Builds the account list from vault contents.
 *
 * Addresses are derived without retaining private keys — the summary path
 * exists precisely so that listing accounts does not populate memory with N
 * secrets the user is not currently using.
 */
export function createUnlockedKeyring({
  payload,
  now = Date.now,
}: CreateUnlockedKeyringParams): UnlockedKeyring {
  const accounts: KeyringAccount[] = [];

  for (const source of payload.keyringSources) {
    if (source.type === "hd") {
      const seed = deriveSeedFromMnemonic({
        phrase: source.mnemonic,
        passphrase: source.passphrase,
      });
      try {
        const summaries = deriveAccountSummariesFromSeed({ seed, count: source.accountCount });
        for (const summary of summaries) {
          accounts.push({
            id: `${source.id}:${summary.addressIndex}`,
            address: summary.address,
            source: "hd",
            derivationPath: summary.derivationPath,
            addressIndex: summary.addressIndex,
            keyringSourceId: source.id,
          });
        }
      } finally {
        // The seed is reconstructible from the mnemonic on demand, so there is
        // no reason to keep it resident between operations.
        zeroize(seed);
      }
      continue;
    }

    const privateKey = decodeHex(source.privateKey);
    try {
      accounts.push({
        id: source.id,
        address: deriveAddressFromPrivateKey(privateKey),
        source: "privateKey",
        keyringSourceId: source.id,
      });
    } finally {
      zeroize(privateKey);
    }
  }

  return { status: "unlocked", accounts, sources: payload.keyringSources, unlockedAt: now() };
}

export function isUnlocked(keyring: Keyring): keyring is UnlockedKeyring {
  return keyring.status === "unlocked";
}

export function assertUnlocked(keyring: Keyring): asserts keyring is UnlockedKeyring {
  if (keyring.status !== "unlocked") throw new VaultLockedError();
}

export class UnknownAccountError extends Error {
  readonly code = "unknown_account";
  constructor(address: string) {
    super(`No account in this wallet matches ${address}.`);
    this.name = "UnknownAccountError";
  }
}

export interface WithAccountPrivateKeyParams<TResult> {
  keyring: Keyring;
  address: string;
  operation: (privateKey: Uint8Array) => Promise<TResult> | TResult;
}

/**
 * Lends a private key to `operation` for the duration of that call, then wipes
 * it.
 *
 * This is the ONLY way any code in this codebase obtains a private key. The
 * scoped-lending shape is what makes the guarantee enforceable: there is no
 * `getPrivateKey(address)` to misuse, the buffer is cleared in a `finally` so a
 * throwing signer still wipes, and the key never becomes a value a caller can
 * store.
 *
 * Callers must not retain the buffer. It is zeroized the instant `operation`
 * settles, so a retained reference reads as zeros rather than leaking — the
 * failure mode is a broken signature, not a silent key leak.
 */
export async function withAccountPrivateKey<TResult>({
  keyring,
  address,
  operation,
}: WithAccountPrivateKeyParams<TResult>): Promise<TResult> {
  assertUnlocked(keyring);

  const normalizedAddress = address.toLowerCase();
  const account = keyring.accounts.find(
    (candidate) => candidate.address.toLowerCase() === normalizedAddress,
  );
  if (!account) throw new UnknownAccountError(address);

  const source = keyring.sources.find((candidate) => candidate.id === account.keyringSourceId);
  if (!source) throw new UnknownAccountError(address);

  if (source.type === "privateKey") {
    const privateKey = decodeHex(source.privateKey);
    try {
      return await operation(privateKey);
    } finally {
      zeroize(privateKey);
    }
  }

  const seed = deriveSeedFromMnemonic({
    phrase: source.mnemonic,
    passphrase: source.passphrase,
  });
  let privateKey: Uint8Array | undefined;
  try {
    const derived = deriveAccountKeyFromSeed({ seed, addressIndex: account.addressIndex ?? 0 });
    privateKey = derived.privateKey;
    return await operation(privateKey);
  } finally {
    zeroize(seed, privateKey);
  }
}

export interface AddHdAccountParams {
  keyring: Keyring;
  keyringSourceId: string;
}

/**
 * Extends an HD keyring by one account.
 *
 * Only `accountCount` changes, which is what makes account creation
 * reproducible: restoring the phrase elsewhere and asking for the same count
 * yields the same addresses in the same order.
 */
export function addHdAccount({ keyring, keyringSourceId }: AddHdAccountParams): UnlockedKeyring {
  assertUnlocked(keyring);

  const sources = keyring.sources.map((source) =>
    source.type === "hd" && source.id === keyringSourceId
      ? { ...source, accountCount: source.accountCount + 1 }
      : source,
  );
  const target = sources.find((source) => source.id === keyringSourceId);
  if (!target || target.type !== "hd") {
    throw new Error(`No HD keyring source with id ${keyringSourceId}.`);
  }

  return createUnlockedKeyring({
    payload: { version: 1, keyringSources: sources },
    now: () => keyring.unlockedAt,
  });
}

export function toVaultPayload(keyring: Keyring): VaultPayload {
  assertUnlocked(keyring);
  return { version: 1, keyringSources: keyring.sources };
}

/**
 * Drops all secret state.
 *
 * Overwrites what can be overwritten and returns the locked sentinel. The
 * mnemonic and hex private keys are JavaScript strings and therefore immutable
 * — we cannot scrub them, only release the last reference and let GC reclaim
 * them. That limitation is precisely why lock-on-service-worker-termination is
 * the default policy rather than an optimisation: process teardown is the only
 * erasure primitive JavaScript actually gives us.
 */
export function lockKeyring(keyring: Keyring): LockedKeyring {
  if (keyring.status === "unlocked") {
    for (const source of keyring.sources) {
      if (source.type === "hd") {
        source.mnemonic = "";
        source.passphrase = "";
        source.accountCount = 0;
      } else {
        source.privateKey = "";
      }
    }
    keyring.sources.length = 0;
  }
  return LOCKED_KEYRING;
}

export interface DeriveBitcoinAccountPublicNodeParams {
  keyring: Keyring;
  accountIndex?: number;
  network?: BitcoinNetworkName;
}

/**
 * Derives a neutered, public-only HDKey node for an account under BIP-84.
 *
 * Security properties:
 * - The returned node is reconstructed from public extended key material only.
 *   It cannot produce signatures, only derive child public keys and addresses.
 * - The seed is zeroized immediately in a finally block.
 * - Throws VaultLockedError if the keyring is locked.
 */
export function deriveBitcoinAccountPublicNode({
  keyring,
  accountIndex = 0,
  network = "signet",
}: DeriveBitcoinAccountPublicNodeParams): HDKey {
  assertUnlocked(keyring);

  const hdSource = keyring.sources.find((source) => source.type === "hd");
  if (!hdSource || hdSource.type !== "hd") {
    throw new Error("Wallet has no HD mnemonic seed to derive Bitcoin accounts.");
  }

  const networkDef = findBitcoinNetwork(network);
  const basePath = createBitcoinAccountBasePath({
    coinType: networkDef.coinType,
    accountIndex,
  });

  const seed = deriveSeedFromMnemonic({
    phrase: hdSource.mnemonic,
    passphrase: hdSource.passphrase,
  });

  let masterNode: HDKey | undefined;
  try {
    masterNode = HDKey.fromMasterSeed(seed);
    const accountNode = masterNode.derive(basePath);
    // Neutered node: reconstructed from the public extended key so it cannot sign
    return HDKey.fromExtendedKey(accountNode.publicExtendedKey);
  } finally {
    if (masterNode) {
      masterNode.wipePrivateData();
    }
    zeroize(seed);
  }
}

export interface WithBitcoinAccountPrivateKeyParams<TResult> {
  keyring: Keyring;
  accountIndex?: number;
  branch: 0 | 1;
  addressIndex: number;
  network?: BitcoinNetworkName;
  operation: (privateKey: Uint8Array) => Promise<TResult> | TResult;
}

/**
 * Lends a Bitcoin private key derived under BIP-84 to `operation` for the duration
 * of that call, then wipes it.
 */
export async function withBitcoinAccountPrivateKey<TResult>({
  keyring,
  accountIndex = 0,
  branch,
  addressIndex,
  network = "signet",
  operation,
}: WithBitcoinAccountPrivateKeyParams<TResult>): Promise<TResult> {
  assertUnlocked(keyring);

  const hdSource = keyring.sources.find((source) => source.type === "hd");
  if (!hdSource || hdSource.type !== "hd") {
    throw new Error("Wallet has no HD mnemonic seed to derive Bitcoin accounts.");
  }

  const networkDef = findBitcoinNetwork(network);
  const derivationPath = createBitcoinDerivationPath({
    coinType: networkDef.coinType,
    accountIndex,
    branch,
    addressIndex,
  });

  const seed = deriveSeedFromMnemonic({
    phrase: hdSource.mnemonic,
    passphrase: hdSource.passphrase,
  });

  let masterNode: HDKey | undefined;
  let privateKey: Uint8Array | undefined;
  try {
    masterNode = HDKey.fromMasterSeed(seed);
    const childNode = masterNode.derive(derivationPath);
    if (!childNode.privateKey) {
      throw new Error("Failed to derive private key for Bitcoin account.");
    }
    privateKey = new Uint8Array(childNode.privateKey);
    return await operation(privateKey);
  } finally {
    if (masterNode) {
      masterNode.wipePrivateData();
    }
    zeroize(seed, privateKey);
  }
}

