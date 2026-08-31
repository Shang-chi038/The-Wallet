import { describe, expect, it } from "vitest";
import {
  BRIDGE_NAMESPACE,
  isMethodAllowedForSender,
  isWalletRequest,
  normalizeOrigin,
  PAGE_APPROVAL_METHODS,
  PAGE_METHODS,
  PRIVILEGED_METHODS,
  PROVIDER_ERROR_CODES,
  requiresApproval,
  userRejectedError,
} from "@/core/messaging/protocol";
import {
  canOriginUseAccount,
  createEmptyPermissionState,
  grantOrigin,
  isOriginConnected,
  listAccountsForOrigin,
  listGrants,
  revokeOrigin,
} from "@/core/messaging/originPermissions";

const ACCOUNT_A = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ACCOUNT_B = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

/**
 * The single most important test file in the messaging layer. If a page can
 * reach a privileged method, any website the user visits can drain them.
 */
describe("trust boundary", () => {
  it("lets a page reach only the EIP-1193 surface", () => {
    for (const method of PAGE_METHODS) {
      expect(isMethodAllowedForSender(method, "page")).toBe(true);
    }
  });

  it("blocks EVERY privileged method from a page", () => {
    for (const method of PRIVILEGED_METHODS) {
      expect(isMethodAllowedForSender(method, "page")).toBe(false);
    }
  });

  /** Named individually so a regression names the method it exposed. */
  it.each([
    "wallet.unlock",
    "wallet.revealMnemonic",
    "wallet.create",
    "wallet.reset",
    "wallet.changePassword",
    "wallet.importPrivateKey",
  ])("a web page cannot call %s", (method) => {
    expect(isMethodAllowedForSender(method, "page")).toBe(false);
  });

  it("lets the popup reach both sets", () => {
    for (const method of [...PRIVILEGED_METHODS, ...PAGE_METHODS]) {
      expect(isMethodAllowedForSender(method, "privileged")).toBe(true);
    }
  });

  /** Allowlist, not denylist: an unknown method is refused for everyone. */
  it("refuses unknown methods from both sender kinds", () => {
    for (const sender of ["page", "privileged"] as const) {
      expect(isMethodAllowedForSender("wallet.somethingNew", sender)).toBe(false);
      expect(isMethodAllowedForSender("eth_secretBackdoor", sender)).toBe(false);
      expect(isMethodAllowedForSender("", sender)).toBe(false);
    }
  });

  it("does not let a near-miss name slip through", () => {
    for (const method of ["wallet.unlock ", "WALLET.UNLOCK", "wallet.unlock\n", "eth_accounts;"]) {
      expect(isMethodAllowedForSender(method, "page")).toBe(false);
    }
  });

  it("marks every state-changing page method as needing approval", () => {
    for (const method of PAGE_APPROVAL_METHODS) {
      expect(requiresApproval(method)).toBe(true);
    }
    expect(requiresApproval("eth_accounts")).toBe(false);
    expect(requiresApproval("eth_chainId")).toBe(false);
  });
});

describe("request validation", () => {
  const valid = { namespace: BRIDGE_NAMESPACE, id: "abc", method: "eth_accounts" };

  it("accepts a well-formed request", () => {
    expect(isWalletRequest(valid)).toBe(true);
  });

  it.each([
    ["wrong namespace", { ...valid, namespace: "other" }],
    ["missing id", { ...valid, id: undefined }],
    ["empty id", { ...valid, id: "" }],
    ["missing method", { ...valid, method: undefined }],
    ["empty method", { ...valid, method: "" }],
    ["null", null],
    ["a string", "eth_accounts"],
    ["an array", []],
  ])("rejects %s", (_label, candidate) => {
    expect(isWalletRequest(candidate)).toBe(false);
  });
});

describe("normalizeOrigin", () => {
  it("reduces a URL to scheme + host + port", () => {
    expect(normalizeOrigin("https://app.example.com/swap?a=1#x")).toBe("https://app.example.com");
  });

  it("keeps a non-default port distinct", () => {
    expect(normalizeOrigin("http://localhost:8080/x")).toBe("http://localhost:8080");
  });

  /** A grant to one host must never cover another. */
  it("treats different hosts as different origins", () => {
    expect(normalizeOrigin("https://app.example.com")).not.toBe(
      normalizeOrigin("https://evil.example.com"),
    );
  });

  it("treats http and https as different origins", () => {
    expect(normalizeOrigin("http://app.example.com")).not.toBe(
      normalizeOrigin("https://app.example.com"),
    );
  });

  it.each(["", "not a url", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings"])(
    "returns undefined for %o rather than guessing",
    (input) => {
      expect(normalizeOrigin(input)).toBeUndefined();
    },
  );

  it("returns undefined for undefined", () => {
    expect(normalizeOrigin(undefined)).toBeUndefined();
  });
});

describe("origin permissions", () => {
  const existing = [ACCOUNT_A, ACCOUNT_B];

  it("returns no accounts for an origin that was never granted", () => {
    const state = createEmptyPermissionState();
    expect(listAccountsForOrigin(state, "https://app.example.com", existing)).toEqual([]);
    expect(isOriginConnected(state, "https://app.example.com", existing)).toBe(false);
  });

  it("returns only the granted subset, not every account", () => {
    const state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A],
    });
    expect(listAccountsForOrigin(state, "https://app.example.com", existing)).toEqual([ACCOUNT_A]);
  });

  it("does not leak a grant across origins", () => {
    const state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A],
    });
    expect(listAccountsForOrigin(state, "https://evil.example.com", existing)).toEqual([]);
  });

  it("ignores path and query when matching a grant", () => {
    const state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com/swap",
      accounts: [ACCOUNT_A],
    });
    expect(listAccountsForOrigin(state, "https://app.example.com/pool?x=1", existing)).toEqual([
      ACCOUNT_A,
    ]);
  });

  /** A grant naming a deleted account must not resurrect it. */
  it("filters out accounts that no longer exist", () => {
    const state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A, ACCOUNT_B],
    });
    expect(listAccountsForOrigin(state, "https://app.example.com", [ACCOUNT_B])).toEqual([
      ACCOUNT_B,
    ]);
  });

  it("reports no accounts after a wallet reset leaves no accounts at all", () => {
    const state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A],
    });
    expect(listAccountsForOrigin(state, "https://app.example.com", [])).toEqual([]);
  });

  it("revokes cleanly", () => {
    let state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A],
    });
    state = revokeOrigin(state, "https://app.example.com");
    expect(listAccountsForOrigin(state, "https://app.example.com", existing)).toEqual([]);
  });

  it("preserves grantedAt when a grant is updated", () => {
    let clock = 1000;
    let state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A],
      now: () => clock,
    });
    clock = 2000;
    state = grantOrigin({
      state,
      origin: "https://app.example.com",
      accounts: [ACCOUNT_A, ACCOUNT_B],
      now: () => clock,
    });
    expect(state.grants["https://app.example.com"]).toMatchObject({
      grantedAt: 1000,
      lastUsedAt: 2000,
    });
  });

  it("refuses to grant to an unparseable origin", () => {
    expect(() =>
      grantOrigin({
        state: createEmptyPermissionState(),
        origin: "not a url",
        accounts: [ACCOUNT_A],
      }),
    ).toThrow();
  });

  it("refuses an empty grant", () => {
    expect(() =>
      grantOrigin({
        state: createEmptyPermissionState(),
        origin: "https://app.example.com",
        accounts: [],
      }),
    ).toThrow();
  });
});

describe("canOriginUseAccount", () => {
  const existing = [ACCOUNT_A, ACCOUNT_B];
  const state = grantOrigin({
    state: createEmptyPermissionState(),
    origin: "https://app.example.com",
    accounts: [ACCOUNT_A],
  });

  it("permits the granted account", () => {
    expect(canOriginUseAccount(state, "https://app.example.com", ACCOUNT_A, existing)).toBe(true);
  });

  /**
   * The grant is the authority, not the request. A dApp granted account A must
   * not obtain a signature from account B by naming it in the params.
   */
  it("refuses an account the origin was not granted", () => {
    expect(canOriginUseAccount(state, "https://app.example.com", ACCOUNT_B, existing)).toBe(false);
  });

  it("is case-insensitive on the address", () => {
    expect(
      canOriginUseAccount(state, "https://app.example.com", ACCOUNT_A.toLowerCase(), existing),
    ).toBe(true);
  });

  it("refuses everything for an unconnected origin", () => {
    expect(canOriginUseAccount(state, "https://evil.example.com", ACCOUNT_A, existing)).toBe(false);
  });
});

describe("listGrants", () => {
  it("orders by most recently used", () => {
    let state = grantOrigin({
      state: createEmptyPermissionState(),
      origin: "https://old.example.com",
      accounts: [ACCOUNT_A],
      now: () => 1000,
    });
    state = grantOrigin({
      state,
      origin: "https://new.example.com",
      accounts: [ACCOUNT_A],
      now: () => 2000,
    });
    expect(listGrants(state).map((grant) => grant.origin)).toEqual([
      "https://new.example.com",
      "https://old.example.com",
    ]);
  });
});

describe("provider errors", () => {
  /** dApps branch on 4001 numerically to tell "cancelled" from "broken". */
  it("uses the EIP-1193 code for user rejection", () => {
    expect(userRejectedError().code).toBe(4001);
    expect(PROVIDER_ERROR_CODES.userRejectedRequest).toBe(4001);
  });
});
