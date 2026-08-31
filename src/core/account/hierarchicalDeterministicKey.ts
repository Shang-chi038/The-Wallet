import { HDKey } from "@scure/bip32";
import { deriveSeedFromMnemonic } from "../mnemonic/mnemonicPhrase";
import { zeroize } from "../crypto/secretBytes";
import { createEthereumDerivationPath } from "./derivationPath";
import { deriveAddressFromPublicKey } from "./ethereumAddress";

/**
 * BIP-32 hierarchical deterministic key derivation.
 *
 * Every account in an HD wallet is derived on demand from the seed. We never
 * persist individual private keys — only the mnemonic (sealed in the vault)
 * plus how many accounts the user has created. That keeps the secret surface to
 * exactly one item and makes "restore from phrase" reproduce the same set of
 * accounts by construction rather than by bookkeeping.
 */

export interface DerivedAccountKey {
  addressIndex: number;
  derivationPath: string;
  address: string;
  /** Raw 32-byte private key. The caller owns its lifetime and must zeroize. */
  privateKey: Uint8Array;
}

export interface DerivedAccountSummary {
  addressIndex: number;
  derivationPath: string;
  address: string;
}

export interface DeriveAccountKeyParams {
  seed: Uint8Array;
  addressIndex: number;
}

export function deriveAccountKeyFromSeed({
  seed,
  addressIndex,
}: DeriveAccountKeyParams): DerivedAccountKey {
  const derivationPath = createEthereumDerivationPath({ addressIndex });
  const masterKey = HDKey.fromMasterSeed(seed);
  const childKey = masterKey.derive(derivationPath);

  if (!childKey.privateKey || !childKey.publicKey) {
    throw new Error(`Derivation produced no key material at ${derivationPath}.`);
  }

  const address = deriveAddressFromPublicKey(childKey.publicKey);
  // Copy out before wiping the HDKey's internal buffers, so the returned key is
  // not aliased to memory we are about to clear.
  const privateKey = Uint8Array.from(childKey.privateKey);

  childKey.wipePrivateData();
  masterKey.wipePrivateData();

  return { addressIndex, derivationPath, address, privateKey };
}

export interface DeriveAccountSummariesParams {
  seed: Uint8Array;
  /** Number of sequential accounts to derive, starting at index 0. */
  count: number;
}

/**
 * Derives addresses WITHOUT retaining private keys.
 *
 * Used for account lists and balance display. Signing re-derives the single key
 * it needs, so private keys for accounts the user is merely looking at never
 * enter memory.
 */
export function deriveAccountSummariesFromSeed({
  seed,
  count,
}: DeriveAccountSummariesParams): DerivedAccountSummary[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("count must be a non-negative integer.");
  }
  const masterKey = HDKey.fromMasterSeed(seed);
  const summaries: DerivedAccountSummary[] = [];
  try {
    for (let addressIndex = 0; addressIndex < count; addressIndex += 1) {
      const derivationPath = createEthereumDerivationPath({ addressIndex });
      const childKey = masterKey.derive(derivationPath);
      if (!childKey.publicKey) {
        throw new Error(`Derivation produced no public key at ${derivationPath}.`);
      }
      summaries.push({
        addressIndex,
        derivationPath,
        address: deriveAddressFromPublicKey(childKey.publicKey),
      });
      childKey.wipePrivateData();
    }
  } finally {
    masterKey.wipePrivateData();
  }
  return summaries;
}

export interface DeriveAccountFromMnemonicParams {
  phrase: string;
  passphrase?: string;
  addressIndex: number;
}

/**
 * Convenience path from phrase straight to one account key.
 *
 * The intermediate seed is zeroized before returning; only the requested
 * account's private key survives the call.
 */
export function deriveAccountKeyFromMnemonic({
  phrase,
  passphrase = "",
  addressIndex,
}: DeriveAccountFromMnemonicParams): DerivedAccountKey {
  const seed = deriveSeedFromMnemonic({ phrase, passphrase });
  try {
    return deriveAccountKeyFromSeed({ seed, addressIndex });
  } finally {
    zeroize(seed);
  }
}
