import {
  createEmptyPermissionState,
  grantOrigin,
  listGrants,
  revokeOrigin,
  type OriginGrant,
  type OriginPermissionState,
} from "@/core/messaging/originPermissions";
import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";

/**
 * Persistence for per-origin connection grants.
 *
 * ===========================================================================
 * WHY GRANTS SURVIVE A LOCK, AND WHY THEY MUST
 * ===========================================================================
 * Grants live in chrome.storage.local, NOT in service-worker memory, so they
 * outlive worker teardown and browser restarts. That is deliberate: a
 * connection the user approved is a standing decision about a site, not part of
 * an unlock session. Dropping grants on lock would re-prompt on every dApp
 * visit, and a user prompted that often stops reading prompts -- which is the
 * failure mode the prompt exists to prevent.
 *
 * What locking DOES take away is the account list itself. `listAccountsForOrigin`
 * filters every grant against the accounts that currently exist, and a locked
 * wallet has none, so a granted origin sees `[]` until the user unlocks. The
 * grant is remembered; the access is not live.
 *
 * A grant is not a secret -- it records which sites the user visits, which is
 * why it goes in `local` and never in `sync` (see platform/storage/chromeStorage.ts).
 *
 * The in-memory copy is a cache, not the source of truth: `load()` is awaited
 * before the first read, and every mutation writes through before it resolves,
 * so a worker torn down mid-operation cannot leave a grant that the user
 * approved but storage never saw.
 */

export const ORIGIN_PERMISSIONS_STORAGE_KEY = "wallet.originPermissions.v1";

export interface OriginPermissionStoreOptions {
  area: KeyValueStorageArea;
  now?: () => number;
}

export class OriginPermissionStore {
  private state: OriginPermissionState = createEmptyPermissionState();
  private loaded = false;
  private readonly area: KeyValueStorageArea;
  private readonly now: () => number;

  constructor({ area, now = Date.now }: OriginPermissionStoreOptions) {
    this.area = area;
    this.now = now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(ORIGIN_PERMISSIONS_STORAGE_KEY);
    this.state = isPermissionState(stored) ? stored : createEmptyPermissionState();
    this.loaded = true;
  }

  /**
   * Synchronous read of the cached state, for the pure `originPermissions`
   * helpers. Callers must have awaited `load()` -- the router does so once at
   * startup, so no request path can observe an unloaded store.
   */
  getState(): OriginPermissionState {
    return this.state;
  }

  async grant(origin: string, accounts: readonly string[]): Promise<void> {
    await this.load();
    this.state = grantOrigin({ state: this.state, origin, accounts, now: this.now });
    await this.persist();
  }

  async revoke(origin: string): Promise<void> {
    await this.load();
    this.state = revokeOrigin(this.state, origin);
    await this.persist();
  }

  async listGrants(): Promise<OriginGrant[]> {
    await this.load();
    return listGrants(this.state);
  }

  /**
   * Drops every grant. Called on wallet reset only.
   *
   * Without this, resetting and restoring a different recovery phrase would
   * leave every previously connected site still holding a grant -- and although
   * the account filter means they would see no addresses, the site would appear
   * connected in the UI and would be granted the new accounts the moment the
   * user reconnected without a fresh prompt.
   */
  async clear(): Promise<void> {
    this.state = createEmptyPermissionState();
    this.loaded = true;
    await this.area.remove(ORIGIN_PERMISSIONS_STORAGE_KEY);
  }

  private async persist(): Promise<void> {
    await this.area.set(ORIGIN_PERMISSIONS_STORAGE_KEY, this.state);
  }
}

/**
 * Shape check on read.
 *
 * Storage is not a trusted input: another extension cannot reach it, but a
 * partial write or a downgrade can leave a shape we do not recognise. An
 * unrecognised blob becomes "no grants", which fails CLOSED -- the user is
 * re-prompted. The opposite default would treat corruption as authorisation.
 */
function isPermissionState(value: unknown): value is OriginPermissionState {
  if (typeof value !== "object" || value === null) return false;
  const grants = (value as { grants?: unknown }).grants;
  if (typeof grants !== "object" || grants === null || Array.isArray(grants)) return false;
  return Object.values(grants as Record<string, unknown>).every((grant) => {
    if (typeof grant !== "object" || grant === null) return false;
    const candidate = grant as Partial<OriginGrant>;
    return (
      typeof candidate.origin === "string" &&
      Array.isArray(candidate.accounts) &&
      candidate.accounts.every((address) => typeof address === "string")
    );
  });
}
