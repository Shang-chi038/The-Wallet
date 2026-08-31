import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStorageArea,
  type KeyValueStorageArea,
} from "@/core/vault/vaultStorage";
import {
  ORIGIN_PERMISSIONS_STORAGE_KEY,
  OriginPermissionStore,
} from "@/background/originPermissionStore";
import { SelectedAccountStore } from "@/background/selectedAccountStore";
import { listAccountsForOrigin, listGrantedAddresses } from "@/core/messaging/originPermissions";

const ACCOUNT_A = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ACCOUNT_B = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
const ORIGIN = "https://app.example";

let area: KeyValueStorageArea;
let store: OriginPermissionStore;

beforeEach(() => {
  area = createMemoryStorageArea();
  store = new OriginPermissionStore({ area });
});

describe("persistence", () => {
  /**
   * A grant is a standing decision about a site, not part of an unlock session.
   * Dropping it on every worker nap would re-prompt on every dApp visit, and a
   * user prompted that often stops reading prompts.
   */
  it("survives a fresh store over the same storage", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A]);

    const reloaded = new OriginPermissionStore({ area });
    await reloaded.load();
    expect(listGrantedAddresses(reloaded.getState(), ORIGIN)).toEqual([ACCOUNT_A]);
  });

  it("writes through before it resolves, so a torn-down worker loses nothing", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A]);
    const stored = await area.get(ORIGIN_PERMISSIONS_STORAGE_KEY);
    expect(JSON.stringify(stored)).toContain(ACCOUNT_A);
  });

  /**
   * Corruption must fail CLOSED. Treating an unrecognised blob as a grant would
   * turn a partial write into authorisation.
   */
  it("treats an unrecognised stored shape as no grants at all", async () => {
    await area.set(ORIGIN_PERMISSIONS_STORAGE_KEY, { grants: "not an object" });
    await store.load();
    expect(listGrantedAddresses(store.getState(), ORIGIN)).toEqual([]);
  });

  it("drops a grant whose accounts are not strings", async () => {
    await area.set(ORIGIN_PERMISSIONS_STORAGE_KEY, {
      grants: { [ORIGIN]: { origin: ORIGIN, accounts: [42] } },
    });
    await store.load();
    expect(listGrantedAddresses(store.getState(), ORIGIN)).toEqual([]);
  });
});

describe("revocation and reset", () => {
  it("removes a single origin without touching the others", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A]);
    await store.grant("https://other.example", [ACCOUNT_B]);

    await store.revoke(ORIGIN);

    expect(listGrantedAddresses(store.getState(), ORIGIN)).toEqual([]);
    expect(listGrantedAddresses(store.getState(), "https://other.example")).toEqual([ACCOUNT_B]);
  });

  /**
   * After a reset and a restore from a DIFFERENT phrase, a surviving grant
   * would list the site as connected and hand it the new accounts the moment
   * the user reconnected, with no fresh prompt.
   */
  it("clears everything on reset", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A]);
    await store.clear();

    const reloaded = new OriginPermissionStore({ area });
    await reloaded.load();
    expect(listGrantedAddresses(reloaded.getState(), ORIGIN)).toEqual([]);
  });
});

describe("grants are filtered against live accounts", () => {
  /**
   * The grant is remembered; the ACCESS is not live. This is what makes a
   * locked wallet report [] to a connected site without forgetting the
   * connection.
   */
  it("reports nothing when the wallet holds no accounts", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A]);
    expect(listAccountsForOrigin(store.getState(), ORIGIN, [])).toEqual([]);
    // The grant itself is intact.
    expect(listGrantedAddresses(store.getState(), ORIGIN)).toEqual([ACCOUNT_A]);
  });

  it("does not resurrect an account the wallet no longer has", async () => {
    await store.grant(ORIGIN, [ACCOUNT_A, ACCOUNT_B]);
    expect(listAccountsForOrigin(store.getState(), ORIGIN, [ACCOUNT_B])).toEqual([ACCOUNT_B]);
  });
});

describe("selected account", () => {
  it("falls back to the first account when the stored one is gone", async () => {
    const selected = new SelectedAccountStore({ area });
    await selected.select(ACCOUNT_B);

    // Simulates a reset-and-restore onto a different phrase: the stored address
    // is not one this wallet holds any more.
    expect(selected.resolve([ACCOUNT_A])).toBe(ACCOUNT_A);
  });

  it("returns undefined when there are no accounts", async () => {
    const selected = new SelectedAccountStore({ area });
    await selected.select(ACCOUNT_A);
    expect(selected.resolve([])).toBeUndefined();
  });

  it("matches case-insensitively, so a checksum change does not lose the choice", async () => {
    const selected = new SelectedAccountStore({ area });
    await selected.select(ACCOUNT_A.toLowerCase());
    expect(selected.resolve([ACCOUNT_A])).toBe(ACCOUNT_A);
  });
});
