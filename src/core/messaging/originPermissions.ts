import { normalizeOrigin } from "./protocol";

/**
 * Per-origin connection grants.
 *
 * A dApp does not get "access to the wallet". It gets access to a specific set
 * of accounts, on a specific origin, that the user picked and can revoke. This
 * is the model MetaMask settled on and it is the right one: it means visiting a
 * malicious site does not expose the addresses you use elsewhere, and a
 * compromised dApp is contained to whatever the user granted it.
 *
 * Two properties worth stating because they are easy to get wrong:
 *
 *   ACCOUNTS ARE A SUBSET, NOT A FLAG. Granting a site access must not mean
 *   granting it every account. Users keep separate accounts precisely so a dApp
 *   cannot see the others, and a boolean "connected" flag silently destroys
 *   that.
 *
 *   AN UNKNOWN ORIGIN GETS AN EMPTY LIST, NOT AN ERROR. `eth_accounts` on a
 *   site the user has never connected returns [], which is what EIP-1193
 *   specifies and also what avoids leaking that a wallet is even installed
 *   beyond the provider announcement.
 */

export interface OriginGrant {
  origin: string;
  /** Checksummed addresses this origin may see, in user-chosen order. */
  accounts: string[];
  grantedAt: number;
  lastUsedAt: number;
}

export interface OriginPermissionState {
  grants: Record<string, OriginGrant>;
}

export function createEmptyPermissionState(): OriginPermissionState {
  return { grants: {} };
}

export interface GrantOriginParams {
  state: OriginPermissionState;
  origin: string;
  accounts: readonly string[];
  now?: () => number;
}

export function grantOrigin({
  state,
  origin,
  accounts,
  now = Date.now,
}: GrantOriginParams): OriginPermissionState {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new Error(`Refusing to grant permission to "${origin}".`);
  if (accounts.length === 0) throw new Error("A grant must include at least one account.");

  const timestamp = now();
  return {
    grants: {
      ...state.grants,
      [normalized]: {
        origin: normalized,
        accounts: [...accounts],
        grantedAt: state.grants[normalized]?.grantedAt ?? timestamp,
        lastUsedAt: timestamp,
      },
    },
  };
}

export function revokeOrigin(
  state: OriginPermissionState,
  origin: string,
): OriginPermissionState {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return state;
  const { [normalized]: _removed, ...remaining } = state.grants;
  return { grants: remaining };
}

/**
 * Accounts an origin may see. Empty array for anything not granted.
 *
 * Also filters against the accounts that currently EXIST: a grant naming an
 * account the user has since removed must not resurrect it, and after a wallet
 * reset a stale grant must not report addresses from the old seed.
 */
export function listAccountsForOrigin(
  state: OriginPermissionState,
  origin: string | undefined,
  existingAccounts: readonly string[],
): string[] {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  const grant = state.grants[normalized];
  if (!grant) return [];

  const existing = new Set(existingAccounts.map((address) => address.toLowerCase()));
  return grant.accounts.filter((address) => existing.has(address.toLowerCase()));
}

/**
 * The addresses a grant NAMES, without filtering against the accounts that
 * currently exist.
 *
 * Exists for exactly one case: deciding whether a LOCKED wallet should prompt.
 * `listAccountsForOrigin` filters against live accounts and a locked wallet has
 * none, so it correctly reports [] -- but using that to answer "may this site
 * ask for a signature?" would mean a connected dApp gets a flat `unauthorized`
 * instead of an unlock prompt, and the user is left with a site that says it is
 * connected and a wallet that says it is not.
 *
 * NEVER use this to authorise anything. It is a hint for the prompt decision
 * only; the real check is re-run against live accounts after unlocking.
 */
export function listGrantedAddresses(
  state: OriginPermissionState,
  origin: string | undefined,
): string[] {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  return [...(state.grants[normalized]?.accounts ?? [])];
}

export function isOriginConnected(
  state: OriginPermissionState,
  origin: string | undefined,
  existingAccounts: readonly string[],
): boolean {
  return listAccountsForOrigin(state, origin, existingAccounts).length > 0;
}

/**
 * Whether an origin may sign with a specific account.
 *
 * Checked on every signature request, not just at connect time. A dApp that was
 * granted account A must not be able to request a signature from account B by
 * naming it in the params — the grant is the authority, not the request.
 */
export function canOriginUseAccount(
  state: OriginPermissionState,
  origin: string | undefined,
  address: string,
  existingAccounts: readonly string[],
): boolean {
  const permitted = listAccountsForOrigin(state, origin, existingAccounts);
  return permitted.some((candidate) => candidate.toLowerCase() === address.toLowerCase());
}

export function listGrants(state: OriginPermissionState): OriginGrant[] {
  return Object.values(state.grants).sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}
