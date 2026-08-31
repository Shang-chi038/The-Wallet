import { describe, expect, it } from "vitest";
import {
  PAGE_READ_METHODS,
  PRIVILEGED_METHODS,
  PROVIDER_ERROR_CODES,
} from "@/core/messaging/protocol";
import type { WalletStatusResult } from "@/core/messaging/walletApi";
import { VaultLockedError } from "@/core/vault/vaultErrors";
import { InsufficientFundsError } from "@/core/transaction/transactionBuilder";
import { toErrorPayload } from "@/background/messageRouter";
import {
  createHarness,
  expectError,
  expectResult,
  OTHER_PAGE_SENDER,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
  TEST_ORIGIN,
} from "./support/routerHarness";

/**
 * Lets a queued approval reach the front of the queue.
 *
 * A request that prompts suspends inside several awaits before the approval is
 * registered, so a single `Promise.resolve()` is not enough and a test that
 * uses one fails intermittently -- the worst kind of test.
 */
async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The router is where the trust boundary is actually enforced. Everything below
 * is a property that, if it broke, would let a website the user merely visited
 * take their money.
 */

describe("trust boundary at the router", () => {
  it("refuses EVERY privileged method from a page", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    for (const method of PRIVILEGED_METHODS) {
      const response = await harness.route({ method, params: {} }, PAGE_SENDER);
      const error = expectError(response);
      expect(
        error.code,
        `${method} must not be reachable from a page`,
      ).toBe(PROVIDER_ERROR_CODES.unsupportedMethod);
    }
  });

  /**
   * Named individually so a regression names the method it exposed. These are
   * the ones where a single mistake is unrecoverable.
   */
  it.each(["wallet.revealMnemonic", "wallet.unlock", "wallet.reset", "wallet.changePassword"])(
    "does not leak %s to a page even with a live wallet and a grant",
    async (method) => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();
      await harness.connectOrigin();

      const response = await harness.route(
        { method, params: { password: "a good long password" } },
        PAGE_SENDER,
      );
      expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unsupportedMethod);
    },
  );

  /**
   * The refusal must not confirm the method EXISTS. `unauthorized` would tell a
   * probing site which internal methods are worth attacking; "unsupported"
   * reveals nothing beyond echoing back the string the page itself sent.
   */
  it("reports a blocked privileged method as unsupported, not unauthorized", async () => {
    const harness = createHarness();
    const response = await harness.route({ method: "wallet.unlock", params: {} }, PAGE_SENDER);
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unsupportedMethod);
  });

  it("lets a page reach the read half of the EIP-1193 surface", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    for (const method of PAGE_READ_METHODS) {
      const response = await harness.route({ method, params: [] }, PAGE_SENDER);
      expect("result" in response, `${method} should answer a page`).toBe(true);
    }
  });

  /**
   * The approval half is reachable too, but reaching it means a PROMPT rather
   * than an answer. Asserted by observing the queue instead of awaiting the
   * response, because the response is exactly what does not arrive until a
   * human answers -- which is the property under test.
   */
  it("opens a prompt rather than answering, for the approval half", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    void harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER);
    await settleMicrotasks();

    expect(harness.context.approvalService.getPendingCount()).toBe(1);
    expect(harness.presenter.openCount).toBe(1);
  });

  it("refuses a page request that carries no usable origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route({ method: "eth_accounts", params: [] }, {
      kind: "page",
      origin: undefined,
    });
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
  });

  /**
   * The content script stamps the origin and Chrome reports it independently. A
   * disagreement means something is wrong with the bridge, and the safe reading
   * of that is an attempt to obtain a grant for someone else's origin.
   */
  it("refuses when the stamped origin disagrees with the sender's", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN);

    const response = await harness.route(
      { method: "eth_accounts", params: [], origin: TEST_ORIGIN },
      OTHER_PAGE_SENDER,
    );
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
  });
});

describe("privileged senders on the page surface", () => {
  /**
   * The allowlist lets extension pages use both method sets -- the popup has to
   * be able to read the chain id. The safety property is that the extension's
   * OWN origin is not a grantable origin, so nothing on the page surface leaks
   * to it by default.
   */
  it("answers a chain read for the popup", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    expect(
      expectResult<string>(await harness.route({ method: "eth_chainId" }, PRIVILEGED_SENDER)),
    ).toBe("0xaa36a7");
  });

  it("shows the popup no accounts on the page surface, grant or not", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    expect(
      expectResult<string[]>(
        await harness.route({ method: "eth_accounts", params: [] }, PRIVILEGED_SENDER),
      ),
    ).toEqual([]);
  });

  /**
   * `chrome-extension://` is not an http(s) origin, so it can never become a
   * permission key. An extension page that somehow reached the connect flow
   * fails closed rather than granting itself everything.
   */
  it("cannot grant the extension's own origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pending = harness.route(
      { method: "eth_requestAccounts", params: [] },
      PRIVILEGED_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true, [TEST_ADDRESS]);

    expect("error" in (await pending)).toBe(true);
    expect(await harness.context.permissionStore.listGrants()).toEqual([]);
  });
});

describe("account visibility", () => {
  it("returns [] to an origin that was never connected", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const accounts = expectResult<string[]>(
      await harness.route({ method: "eth_accounts", params: [] }, PAGE_SENDER),
    );
    expect(accounts).toEqual([]);
  });

  it("returns [] while locked, even to a connected origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();
    await harness.route({ method: "wallet.lock" }, PRIVILEGED_SENDER);

    const accounts = expectResult<string[]>(
      await harness.route({ method: "eth_accounts", params: [] }, PAGE_SENDER),
    );
    expect(accounts).toEqual([]);
  });

  it("does not show one origin's accounts to another", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);

    const accounts = expectResult<string[]>(
      await harness.route({ method: "eth_accounts", params: [] }, OTHER_PAGE_SENDER),
    );
    expect(accounts).toEqual([]);
  });

  /**
   * dApps cache this array and compare later values with `===`. Mixing
   * checksummed and lowercase forms makes a connected site decide the account
   * changed when it did not.
   */
  it("returns lowercase addresses on the page surface", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const accounts = expectResult<string[]>(
      await harness.route({ method: "eth_accounts", params: [] }, PAGE_SENDER),
    );
    expect(accounts).toEqual([TEST_ADDRESS.toLowerCase()]);
  });
});

describe("connect", () => {
  it("grants only the accounts the user ticked", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER);

    const status = expectResult<WalletStatusResult>(
      await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
    );
    expect(status.accounts).toHaveLength(2);

    const pending = harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER);
    await settleMicrotasks();
    await harness.answerNextApproval(true, [TEST_ADDRESS]);

    const accounts = expectResult<string[]>(await pending);
    expect(accounts).toEqual([TEST_ADDRESS.toLowerCase()]);

    // The second account must remain invisible: a grant is a subset, not a flag.
    const visible = expectResult<string[]>(
      await harness.route({ method: "eth_accounts", params: [] }, PAGE_SENDER),
    );
    expect(visible).toEqual([TEST_ADDRESS.toLowerCase()]);
  });

  it("rejects with 4001 when the user declines", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pending = harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER);
    await settleMicrotasks();
    await harness.answerNextApproval(false);

    expect(expectError(await pending).code).toBe(PROVIDER_ERROR_CODES.userRejectedRequest);
  });

  /**
   * A bug in our own approval window must not be able to grant a site an
   * address the wallet does not own. "Privileged" is not "infallible".
   */
  it("refuses an approval naming an address this wallet does not hold", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pending = harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER);
    await settleMicrotasks();
    await harness.answerNextApproval(true, ["0x000000000000000000000000000000000000dEaD"]);

    expect(expectError(await pending).code).toBe(PROVIDER_ERROR_CODES.userRejectedRequest);
  });

  it("does not prompt again for an origin already connected", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const accounts = expectResult<string[]>(
      await harness.route({ method: "eth_requestAccounts", params: [] }, PAGE_SENDER),
    );
    expect(accounts).toEqual([TEST_ADDRESS.toLowerCase()]);
    expect(harness.presenter.openCount).toBe(0);
  });
});

describe("signing authorisation", () => {
  it("refuses personal_sign from an unconnected origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      { method: "personal_sign", params: ["hello", TEST_ADDRESS] },
      PAGE_SENDER,
    );
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
    expect(harness.presenter.openCount).toBe(0);
  });

  /**
   * The grant is the authority, not the request. A site granted account A must
   * not obtain a signature from account B by naming it in the params.
   */
  it("refuses to sign with an account the origin was not granted", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    const second = expectResult<{ account: { address: string } }>(
      await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER),
    );
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);

    const response = await harness.route(
      { method: "personal_sign", params: ["hello", second.account.address] },
      PAGE_SENDER,
    );
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
  });

  it("signs for a granted account after approval", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const pending = harness.route(
      { method: "personal_sign", params: ["hello", TEST_ADDRESS] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true);

    const signature = expectResult<string>(await pending);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  /**
   * An approval can sit in the queue for minutes. Authorisation granted when it
   * was queued is not authorisation when it is answered.
   */
  it("refuses to sign when the grant was revoked while the approval waited", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const pending = harness.route(
      { method: "personal_sign", params: ["hello", TEST_ADDRESS] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.context.permissionStore.revoke(TEST_ORIGIN);
    await harness.answerNextApproval(true);

    expect(expectError(await pending).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
  });

  /**
   * A connected dApp asking a LOCKED wallet to sign must get an unlock prompt,
   * not a flat refusal -- otherwise the user sees a site that says "connected"
   * next to a wallet that says "no", with nothing to reconcile them. The real
   * authorisation check still runs after the unlock.
   */
  it("prompts rather than refusing when a connected origin asks a locked wallet", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();
    harness.context.walletService.lock();

    void harness.route({ method: "personal_sign", params: ["hello", TEST_ADDRESS] }, PAGE_SENDER);
    await settleMicrotasks();

    expect(harness.context.approvalService.getPendingCount()).toBe(1);
  });

  it("refuses to sign when the wallet locked while the approval waited", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const pending = harness.route(
      { method: "personal_sign", params: ["hello", TEST_ADDRESS] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    harness.context.walletService.lock();
    await harness.answerNextApproval(true);

    // Locked means the keyring holds no accounts, so the account check fails
    // first -- either way, no signature is produced.
    expect("error" in (await pending)).toBe(true);
  });
});

describe("error disclosure", () => {
  /**
   * `vault_not_found` reaching a page would tell every site the user visits
   * whether they have a wallet -- the exact fact `eth_accounts` returning []
   * is careful not to leak.
   */
  /**
   * Tested at the mapper rather than end to end, because the paths that produce
   * a wallet-state error from a page request all correctly PROMPT first -- see
   * the locked-wallet test below. The disclosure rule still has to hold for
   * every one of them, so it is asserted where it is decided.
   */
  it("never sends the internal reason, or the message, to a page", () => {
    const payload = toErrorPayload(new VaultLockedError(), false);
    expect(payload).not.toHaveProperty("data");
    expect(payload.message).toBe("The wallet could not complete this request.");
  });

  it("does send a reason describing the site's own request", () => {
    const payload = toErrorPayload(new InsufficientFundsError(10n, 1n), false);
    // The site asked for a transaction it cannot afford. Telling it so reveals
    // nothing about the wallet that the site did not itself supply.
    expect(payload.message).toContain("enough ETH");
  });

  it("never forwards the text of an error we did not model", () => {
    const payload = toErrorPayload(new Error("scrypt failed for password hunter2"), true);
    expect(payload.message).not.toContain("hunter2");
    expect(payload.data?.reason).toBe("internal_error");
  });

  it("sends the internal reason to our own pages, so the UI can branch on it", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.route({ method: "wallet.lock" }, PRIVILEGED_SENDER);

    const response = await harness.route(
      { method: "wallet.unlock", params: { password: "wrong password entirely" } },
      PRIVILEGED_SENDER,
    );
    const error = expectError(response) as { data?: { reason?: string } } & {
      code: number;
      message: string;
    };
    expect(error.data?.reason).toBe("incorrect_password");
  });

  /**
   * The popup renders a specific sentence for a duplicate import, and it
   * branches on `reason` rather than on the message text. That only works if
   * the reason survives the trust boundary, so assert it here rather than
   * trusting the mapping in `toErrorPayload`.
   *
   * The key is account 0 of the harness phrase -- a published vector, so a
   * collision is expected and a PASS here means the engine really did refuse.
   */
  it("reports a duplicate import as duplicate_account to our own pages", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      {
        method: "wallet.importPrivateKey",
        params: {
          privateKey: "0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727",
        },
      },
      PRIVILEGED_SENDER,
    );
    const error = expectError(response) as { data?: { reason?: string } } & {
      code: number;
      message: string;
    };
    expect(error.data?.reason).toBe("duplicate_account");
  });

  /**
   * Imported accounts are numbered from one, independently of how many HD
   * accounts sit in front of them. Getting this wrong is silent -- the wallet
   * works perfectly and just tells the user their first import is their third.
   */
  it("numbers imported accounts within their own source", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER);

    const first = await harness.route(
      { method: "wallet.importPrivateKey", params: { privateKey: `0x${"11".repeat(32)}` } },
      PRIVILEGED_SENDER,
    );
    const second = await harness.route(
      { method: "wallet.importPrivateKey", params: { privateKey: `0x${"ab".repeat(32)}` } },
      PRIVILEGED_SENDER,
    );

    expect(expectResult<{ account: { label: string } }>(first).account.label).toBe("Imported 1");
    expect(expectResult<{ account: { label: string } }>(second).account.label).toBe("Imported 2");
    // The two HD accounts still read 1 and 2, and the summary list agrees with
    // the single-account result it was taken from.
    expect(
      expectResult<{ accounts: { label: string }[] }>(second).accounts.map((a) => a.label),
    ).toEqual(["Account 1", "Account 2", "Imported 1", "Imported 2"]);
  });

  it("rejects a malformed envelope without throwing", async () => {
    const harness = createHarness();
    const response = await harness.route({ nonsense: true } as unknown, PAGE_SENDER);
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.invalidParams);
  });
});
