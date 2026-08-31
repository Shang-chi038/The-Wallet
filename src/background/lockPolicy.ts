/**
 * Auto-lock and service-worker lifecycle policy.
 *
 * ===========================================================================
 * THE MV3 PROBLEM
 * ===========================================================================
 * A Manifest V3 background service worker is not a persistent process. Chrome
 * terminates it after ~30 seconds of inactivity and restarts it on the next
 * event. Every module-level variable is lost across that boundary.
 *
 * For most extensions this is an annoyance. For a wallet it is a security
 * primitive, because JavaScript gives us no way to erase a string from the heap
 * — the decrypted mnemonic lives until GC decides otherwise, and we cannot
 * force it. Worker teardown is the only true erasure the platform offers. So we
 * treat termination as a FEATURE:
 *
 *     service worker terminated  ==>  wallet locked
 *
 * That is the default policy, and it is the secure one.
 *
 * ===========================================================================
 * WHY setTimeout CANNOT IMPLEMENT AUTO-LOCK
 * ===========================================================================
 * A pending setTimeout dies with the worker. An auto-lock built on it fails
 * open in the worst possible way: the worker sleeps, the timer evaporates, the
 * worker wakes on a later event, and no lock ever fires. chrome.alarms is
 * persisted by the browser and survives worker restarts, so it is the only
 * correct scheduler here.
 *
 * (chrome.alarms enforces a 1-minute minimum period, which is why the shortest
 * selectable auto-lock interval is one minute.)
 *
 * ===========================================================================
 * THE SESSION-PERSISTENCE TRADE-OFF
 * ===========================================================================
 * Locking on every worker nap means re-typing the password constantly — and a
 * ~750ms KDF each time. Users respond to that by choosing weak passwords, so
 * the strictest policy is not automatically the safest one in practice.
 *
 * The opt-in alternative keeps ONLY the derived encryption key in
 * chrome.storage.session, which is memory-backed, never written to disk, and
 * cleared when the browser closes.
 *
 * Be honest about what that costs: it widens the key's exposure from
 * "service-worker heap" to "any extension-context code that can call
 * chrome.storage.session". A content-script compromise still cannot reach it
 * (different context, no storage access), but a compromised extension page or a
 * malicious dependency running in an extension context could. That is a
 * strictly larger surface than worker memory alone.
 *
 * Hence: SESSION PERSISTENCE IS OFF BY DEFAULT and the settings UI states the
 * trade-off in plain language rather than burying it.
 */

export const AUTO_LOCK_ALARM_NAME = "wallet.autoLock";
export const KEEP_ALIVE_ALARM_NAME = "wallet.keepAlive";

/** chrome.alarms will not schedule below one minute. */
export const MINIMUM_AUTO_LOCK_MINUTES = 1;
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

export type UnlockPersistencePolicy =
  /**
   * Default. Secrets exist only in service-worker memory. Worker termination
   * locks the wallet and the user re-authenticates on next use.
   */
  | "workerMemoryOnly"
  /**
   * Opt-in. The derived key is mirrored into chrome.storage.session so a worker
   * restart can rehydrate without a password prompt. Cleared on browser close,
   * on explicit lock, and on the auto-lock alarm.
   */
  | "browserSession";

export interface LockSettings {
  autoLockAfterMinutes: number;
  unlockPersistence: UnlockPersistencePolicy;
}

export const DEFAULT_LOCK_SETTINGS: LockSettings = {
  autoLockAfterMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  unlockPersistence: "workerMemoryOnly",
};

export function normalizeAutoLockMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.max(MINIMUM_AUTO_LOCK_MINUTES, Math.floor(minutes));
}

export interface AlarmScheduler {
  create(name: string, options: { delayInMinutes?: number; periodInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
}

export function createChromeAlarmScheduler(): AlarmScheduler {
  return {
    create(name, options) {
      chrome.alarms.create(name, options);
    },
    clear(name) {
      return chrome.alarms.clear(name);
    },
  };
}

/**
 * (Re)arms the auto-lock countdown.
 *
 * Called on unlock and on each user interaction. Re-creating an alarm with the
 * same name replaces the pending one, which is exactly the "reset the idle
 * timer" semantics we want.
 */
export function scheduleAutoLock(scheduler: AlarmScheduler, settings: LockSettings): void {
  scheduler.create(AUTO_LOCK_ALARM_NAME, {
    delayInMinutes: normalizeAutoLockMinutes(settings.autoLockAfterMinutes),
  });
}

/**
 * What an incoming request should do to the auto-lock countdown.
 *
 * Extracted from the worker so the RULE is covered by the hermetic suite.
 * `chrome.alarms` cannot run there, so without this the only thing a test could
 * assert is that a callback fired -- which says nothing about whether an alarm
 * is ever armed with the user's chosen interval.
 *
 * PRIVILEGED SENDERS ONLY. Auto-lock measures whether the USER is still here,
 * and a dApp polling `eth_chainId` from a background tab is not the user being
 * present. Re-arming on page traffic would let any open site hold an unlocked
 * wallet open indefinitely -- the protection inverted.
 */
export function decideAutoLockAction({
  senderKind,
  isUnlocked,
}: {
  senderKind: "privileged" | "page";
  isUnlocked: boolean;
}): "schedule" | "cancel" | "ignore" {
  if (senderKind !== "privileged") return "ignore";
  return isUnlocked ? "schedule" : "cancel";
}

export async function cancelAutoLock(scheduler: AlarmScheduler): Promise<void> {
  await scheduler.clear(AUTO_LOCK_ALARM_NAME);
}
