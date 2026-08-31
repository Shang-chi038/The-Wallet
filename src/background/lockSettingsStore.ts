import {
  DEFAULT_LOCK_SETTINGS,
  MINIMUM_AUTO_LOCK_MINUTES,
  normalizeAutoLockMinutes,
  type LockSettings,
} from "./lockPolicy";
import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";

/**
 * How long the wallet stays unlocked while idle.
 *
 * A PREFERENCE, not a secret: it holds a number of minutes and nothing else, so
 * chrome.storage.local is the right home. Persisted rather than kept in memory
 * for the reason every other setting here is -- the service worker is collected
 * constantly, and a setting that reset on every nap would look broken and be
 * ignored.
 *
 * ===========================================================================
 * WHY THIS IS SETTABLE AT ALL
 * ===========================================================================
 * lockPolicy.ts argues that the strictest policy is not automatically the
 * safest one in practice: a wallet that demands a password every few minutes
 * trains its user to choose a password they can type quickly. The interval is
 * the one dial that lets someone match the wallet to their own threat model --
 * one minute on a shared laptop, an hour on a machine only they touch.
 *
 * What is NOT settable is `unlockPersistence`. The type admits a
 * "browserSession" policy and nothing in this codebase implements it: no code
 * mirrors the derived key into chrome.storage.session. A settings toggle for it
 * would be a security control that silently does nothing, which is worse than
 * its absence -- the user would believe they had made a choice. It stays out of
 * the UI until the mechanism behind it exists.
 */

export const LOCK_SETTINGS_STORAGE_KEY = "wallet.lockSettings.v1";

/**
 * The offered intervals.
 *
 * One minute is the floor chrome.alarms will schedule; anything shorter would
 * be a promise the platform cannot keep. The top of the range is deliberately
 * an hour rather than "never": a wallet with no auto-lock is one closed laptop
 * lid away from an unlocked wallet on someone else's desk, and the honest way
 * to offer that is not to offer it.
 */
export const AUTO_LOCK_INTERVAL_CHOICES = [1, 5, 15, 30, 60] as const;

export interface LockSettingsStoreOptions {
  area: KeyValueStorageArea;
  /**
   * Called after a change is persisted.
   *
   * The countdown must be re-armed IMMEDIATELY, not at the next lock. A user
   * who shortens the interval from an hour to a minute because they are about
   * to walk away has an hour-long alarm still pending, and the setting they
   * just chose does not apply to the very session that prompted them to choose
   * it. The store cannot re-arm it itself -- `chrome.alarms` lives outside this
   * layer, which is what keeps the router testable in plain Node.
   */
  onChanged?: ((settings: LockSettings) => void) | undefined;
}

export class LockSettingsStore {
  private settings: LockSettings = DEFAULT_LOCK_SETTINGS;
  private loaded = false;
  private readonly area: KeyValueStorageArea;
  private readonly onChanged: ((settings: LockSettings) => void) | undefined;

  constructor({ area, onChanged }: LockSettingsStoreOptions) {
    this.area = area;
    this.onChanged = onChanged;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.settings = toLockSettings(await this.area.get(LOCK_SETTINGS_STORAGE_KEY));
    this.loaded = true;
  }

  get(): LockSettings {
    return this.settings;
  }

  async updateAutoLockMinutes(minutes: number): Promise<LockSettings> {
    const next: LockSettings = {
      ...this.settings,
      autoLockAfterMinutes: normalizeAutoLockMinutes(minutes),
    };
    this.settings = next;
    this.loaded = true;
    await this.area.set(LOCK_SETTINGS_STORAGE_KEY, next);
    this.onChanged?.(next);
    return next;
  }

  /** Called on wallet reset, alongside every other stored preference. */
  async clear(): Promise<void> {
    this.settings = DEFAULT_LOCK_SETTINGS;
    this.loaded = true;
    await this.area.remove(LOCK_SETTINGS_STORAGE_KEY);
    this.onChanged?.(this.settings);
  }
}

/**
 * Shape check on the stored record.
 *
 * Storage is not a trusted input: a record can predate a schema change, or be
 * left behind by a different version of the extension. Anything unrecognised
 * falls back to the default rather than being repaired field by field, because
 * a half-understood lock policy is the one thing here that must not be guessed
 * at -- and the default is the strict one.
 */
function toLockSettings(stored: unknown): LockSettings {
  if (typeof stored !== "object" || stored === null) return DEFAULT_LOCK_SETTINGS;
  const record = stored as Partial<LockSettings>;
  if (typeof record.autoLockAfterMinutes !== "number") return DEFAULT_LOCK_SETTINGS;
  if (record.autoLockAfterMinutes < MINIMUM_AUTO_LOCK_MINUTES) return DEFAULT_LOCK_SETTINGS;
  return {
    autoLockAfterMinutes: normalizeAutoLockMinutes(record.autoLockAfterMinutes),
    // Not read back from storage. See the note on `unlockPersistence` above:
    // the policy has no implementation, so honouring a stored "browserSession"
    // would change nothing except what the wallet claims about itself.
    unlockPersistence: DEFAULT_LOCK_SETTINGS.unlockPersistence,
  };
}
