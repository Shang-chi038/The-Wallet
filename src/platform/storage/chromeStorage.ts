import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";

/**
 * chrome.storage adapters.
 *
 * STORAGE AREA CHOICE — a security decision, not a convenience one.
 *
 *   chrome.storage.local    On disk, plaintext LevelDB under the browser
 *                           profile. Survives restart. The ENCRYPTED vault goes
 *                           here; safe only because it is ciphertext.
 *
 *   chrome.storage.session  Memory-backed, never written to disk, cleared when
 *                           the browser closes. The only place a derived key
 *                           may live outside service-worker memory, and only
 *                           under the opt-in policy in background/lockPolicy.ts.
 *
 *   chrome.storage.sync     Replicated to the user's Google account, i.e.
 *                           uploaded to a third party. NEVER used for anything
 *                           in this extension — not even non-secret settings,
 *                           so that no future refactor can widen it into a leak.
 */

export function createChromeLocalStorageArea(): KeyValueStorageArea {
  return {
    async get(key) {
      return (await chrome.storage.local.get(key))[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}

export function createChromeSessionStorageArea(): KeyValueStorageArea {
  return {
    async get(key) {
      return (await chrome.storage.session.get(key))[key];
    },
    async set(key, value) {
      await chrome.storage.session.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.session.remove(key);
    },
  };
}
