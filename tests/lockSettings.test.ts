import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  MINIMUM_AUTO_LOCK_MINUTES,
  decideAutoLockAction,
} from "@/background/lockPolicy";
import {
  AUTO_LOCK_INTERVAL_CHOICES,
  LOCK_SETTINGS_STORAGE_KEY,
  LockSettingsStore,
} from "@/background/lockSettingsStore";
import type { LockSettingsResult } from "@/core/messaging/walletApi";
import { createMemoryStorageArea } from "@/core/vault/vaultStorage";
import {
  createHarness,
  expectError,
  expectResult,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
} from "./support/routerHarness";

/**
 * Auto-lock interval.
 *
 * The setting is a preference, so most of what matters here is that it cannot
 * become a way to disable auto-lock, cannot be read by a website, and takes
 * effect on the session that set it rather than the next one.
 */

describe("LockSettingsStore", () => {
  it("starts at the default and persists a change", async () => {
    const area = createMemoryStorageArea();
    const store = new LockSettingsStore({ area });
    await store.load();
    expect(store.get().autoLockAfterMinutes).toBe(DEFAULT_AUTO_LOCK_MINUTES);

    await store.updateAutoLockMinutes(5);
    expect(store.get().autoLockAfterMinutes).toBe(5);

    // A cold store over the same area -- the worker restarting.
    const reloaded = new LockSettingsStore({ area });
    await reloaded.load();
    expect(reloaded.get().autoLockAfterMinutes).toBe(5);
  });

  /**
   * The re-arm is the whole reason `onChanged` exists. Someone who shortens the
   * interval is usually about to walk away, and a change that applied only from
   * the next unlock would miss the session that prompted it.
   */
  it("asks for the countdown to be re-armed on every change", async () => {
    const rearmed: number[] = [];
    const store = new LockSettingsStore({
      area: createMemoryStorageArea(),
      onChanged: (settings) => rearmed.push(settings.autoLockAfterMinutes),
    });
    await store.load();

    await store.updateAutoLockMinutes(30);
    await store.updateAutoLockMinutes(1);
    expect(rearmed).toEqual([30, 1]);
  });

  /**
   * Storage is not a trusted input. A record from another version -- or one
   * hand-edited to disable auto-lock -- must fall back to the strict default
   * rather than being repaired into something plausible.
   */
  it("falls back to the default for an unusable stored record", async () => {
    const area = createMemoryStorageArea();
    for (const stored of [
      null,
      "15",
      {},
      { autoLockAfterMinutes: "15" },
      { autoLockAfterMinutes: 0 },
      { autoLockAfterMinutes: MINIMUM_AUTO_LOCK_MINUTES - 1 },
    ]) {
      await area.set(LOCK_SETTINGS_STORAGE_KEY, stored);
      const store = new LockSettingsStore({ area });
      await store.load();
      expect(store.get().autoLockAfterMinutes).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    }
  });

  /**
   * `browserSession` persistence is declared in the type and implemented
   * nowhere -- no code mirrors the derived key into chrome.storage.session. A
   * stored record claiming it must not change what the wallet reports about
   * itself, or the setting becomes a security control that does nothing.
   */
  it("ignores a stored unlock-persistence policy that has no implementation", async () => {
    const area = createMemoryStorageArea();
    await area.set(LOCK_SETTINGS_STORAGE_KEY, {
      autoLockAfterMinutes: 5,
      unlockPersistence: "browserSession",
    });
    const store = new LockSettingsStore({ area });
    await store.load();

    expect(store.get()).toEqual({ autoLockAfterMinutes: 5, unlockPersistence: "workerMemoryOnly" });
  });
});

describe("wallet.getLockSettings / wallet.updateLockSettings", () => {
  it("reports the interval and the intervals on offer", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const settings = expectResult<LockSettingsResult>(
      await harness.route({ method: "wallet.getLockSettings" }, PRIVILEGED_SENDER),
    );
    expect(settings.autoLockAfterMinutes).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(settings.choices).toEqual([...AUTO_LOCK_INTERVAL_CHOICES]);
  });

  it("saves a change and re-arms the countdown", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const settings = expectResult<LockSettingsResult>(
      await harness.route(
        { method: "wallet.updateLockSettings", params: { autoLockAfterMinutes: 1 } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(settings.autoLockAfterMinutes).toBe(1);
    expect(harness.rescheduledAutoLockMinutes).toEqual([1]);
  });

  /**
   * The list is a closed set, not a hint. `normalizeAutoLockMinutes` clamps the
   * bottom and nothing clamps the top, so an unvalidated write of 100000 would
   * leave a wallet that never auto-locks in practice -- configured through a UI
   * that never offered it.
   */
  it("refuses an interval that was never offered", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    for (const minutes of [0, -1, 7, 100_000, 1.5]) {
      expectError(
        await harness.route(
          { method: "wallet.updateLockSettings", params: { autoLockAfterMinutes: minutes } },
          PRIVILEGED_SENDER,
        ),
      );
    }
    expect(harness.context.lockSettings.get().autoLockAfterMinutes).toBe(
      DEFAULT_AUTO_LOCK_MINUTES,
    );
    expect(harness.rescheduledAutoLockMinutes).toEqual([]);
  });

  /**
   * How long the wallet stays unlocked is a fact about the user's machine, and
   * a site that could read it would learn when the wallet is likeliest to be
   * unlocked. Reported as 4200 rather than 4100 -- see the note in CLAUDE.md on
   * not confirming that a method exists.
   */
  it("is unreachable from a website", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const error = expectError(
      await harness.route({ method: "wallet.getLockSettings" }, PAGE_SENDER),
    );
    expect(error.code).toBe(4200);
  });

  /** A reset hands the next person the strict default, not an inherited hour. */
  it("returns to the default on wallet reset", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.route(
      { method: "wallet.updateLockSettings", params: { autoLockAfterMinutes: 60 } },
      PRIVILEGED_SENDER,
    );

    await harness.route({ method: "wallet.reset" }, PRIVILEGED_SENDER);

    expect(harness.context.lockSettings.get().autoLockAfterMinutes).toBe(
      DEFAULT_AUTO_LOCK_MINUTES,
    );
  });
});

describe("decideAutoLockAction", () => {
  /**
   * The regression this exists for. Arming used to hang off the APPROVAL queue,
   * which fires when a dApp request is queued or settles -- not on unlock, and
   * not on ordinary use. A wallet unlocked from the popup by someone who never
   * connects a site had no alarm scheduled at all, so auto-lock failed open:
   * the exact failure `lockPolicy.ts` refuses `setTimeout` to avoid.
   */
  it("re-arms the countdown on the user's own interactions", () => {
    expect(decideAutoLockAction({ senderKind: "privileged", isUnlocked: true })).toBe("schedule");
  });

  /**
   * Auto-lock measures whether the USER is still here. A dApp polling
   * `eth_chainId` from a background tab is not the user being present, and
   * re-arming on it would let any open site hold an unlocked wallet open
   * indefinitely -- the protection inverted.
   */
  it("ignores traffic from websites, however busy", () => {
    expect(decideAutoLockAction({ senderKind: "page", isUnlocked: true })).toBe("ignore");
    expect(decideAutoLockAction({ senderKind: "page", isUnlocked: false })).toBe("ignore");
  });

  /** A stale alarm would fire against the NEXT session, cutting it short. */
  it("clears the alarm once there is nothing left to lock", () => {
    expect(decideAutoLockAction({ senderKind: "privileged", isUnlocked: false })).toBe("cancel");
  });
});
