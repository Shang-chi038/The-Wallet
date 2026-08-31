import { VaultCorruptedError } from "./vaultErrors";
import { isVaultRecord, type VaultRecord } from "./vaultRecord";

/**
 * Vault persistence contract.
 *
 * The interface lives in `core` (pure) while the chrome.storage implementation
 * lives in `platform`. That inversion is what lets the whole wallet engine run
 * under vitest in plain Node against an in-memory fake, with zero divergence
 * from the code path that ships.
 */

export const VAULT_STORAGE_KEY = "wallet.vault.v1";

export interface KeyValueStorageArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface VaultStorage {
  read(): Promise<VaultRecord | undefined>;
  write(record: VaultRecord): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
}

export function createMemoryStorageArea(): KeyValueStorageArea {
  const entries = new Map<string, unknown>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      // Round-trip through JSON so the fake behaves like a real storage area,
      // which serialises. Catches accidental reliance on object identity.
      entries.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    },
    async remove(key) {
      entries.delete(key);
    },
  };
}

export function createVaultStorage(area: KeyValueStorageArea): VaultStorage {
  return {
    async read() {
      const stored = await area.get(VAULT_STORAGE_KEY);
      if (stored === undefined || stored === null) return undefined;
      if (!isVaultRecord(stored)) {
        // Refuse to interpret an unrecognised shape. Returning `undefined` here
        // would look like "no wallet yet" to the caller, which could lead the
        // onboarding flow to overwrite a damaged-but-recoverable vault — a
        // silent, unrecoverable loss of the user's funds.
        throw new VaultCorruptedError("stored record failed shape validation");
      }
      return stored;
    },
    async write(record) {
      await area.set(VAULT_STORAGE_KEY, record);
    },
    async clear() {
      await area.remove(VAULT_STORAGE_KEY);
    },
    async exists() {
      const stored = await area.get(VAULT_STORAGE_KEY);
      return stored !== undefined && stored !== null;
    },
  };
}
