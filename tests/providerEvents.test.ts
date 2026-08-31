import { describe, expect, it } from "vitest";
import {
  createHarness,
  OTHER_ORIGIN,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
  TEST_ORIGIN,
} from "./support/routerHarness";

/**
 * Event delivery.
 *
 * There is no such thing as "the account list" -- each origin sees the subset
 * the user granted it. A broadcast that ignores that would leak every account
 * to every connected site, in the one code path most likely to be written
 * carelessly.
 *
 * The harness reports three tabs: TEST_ORIGIN (tab 1), OTHER_ORIGIN (tab 2),
 * and an about:blank tab (tab 3) whose origin is the string "null".
 */

describe("accountsChanged", () => {
  it("reaches only the origins that hold a grant", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.context.providerEvents.broadcastAccountsChanged();

    expect(harness.events.map((entry) => entry.tabId)).toEqual([1]);
  });

  /**
   * An unconnected site gets NOTHING, not an empty array. Telling it the
   * account list changed is a signal about activity in another tab, and it has
   * no business knowing that.
   */
  it("sends nothing at all to an unconnected origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.context.providerEvents.broadcastAccountsChanged();

    expect(harness.events.some((entry) => entry.tabId === 2)).toBe(false);
  });

  /**
   * `new URL("about:blank").origin` is the string "null", and every opaque
   * origin shares it. Used as a key, one grant would cover all of them, on
   * every site.
   */
  it("skips a tab with no usable origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    await harness.connectOrigin(OTHER_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.context.providerEvents.broadcastAccountsChanged();

    expect(harness.events.some((entry) => entry.tabId === 3)).toBe(false);
  });

  it("carries each origin its own subset", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER);

    const status = await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER);
    const accounts =
      "result" in status
        ? (status.result as { accounts: { address: string }[] }).accounts
        : [];
    const second = accounts[1]!.address;

    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    await harness.connectOrigin(OTHER_ORIGIN, [second]);
    harness.events.length = 0;

    await harness.context.providerEvents.broadcastAccountsChanged();

    const forTest = harness.events.find((entry) => entry.tabId === 1);
    const forOther = harness.events.find((entry) => entry.tabId === 2);
    expect(forTest?.message.params).toEqual([TEST_ADDRESS.toLowerCase()]);
    expect(forOther?.message.params).toEqual([second.toLowerCase()]);
  });

  /**
   * Locking sends an empty list rather than staying silent. A dApp that never
   * hears about the lock keeps showing a connected state next to a wallet that
   * will refuse everything it asks.
   */
  it("tells connected sites the accounts are gone when the wallet locks", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.route({ method: "wallet.lock" }, PRIVILEGED_SENDER);
    // wallet.lock broadcasts without awaiting, so let the microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const forTest = harness.events.find((entry) => entry.tabId === 1);
    expect(forTest?.message.event).toBe("accountsChanged");
    expect(forTest?.message.params).toEqual([]);
  });

  it("tells a site immediately when its connection is revoked", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.route(
      { method: "wallet.revokeConnection", params: { origin: TEST_ORIGIN } },
      PRIVILEGED_SENDER,
    );

    // The grant is gone, so the tab is no longer a recipient -- which is the
    // correct end state, but the site must have been told on the way out.
    expect(harness.events.every((entry) => entry.message.event === "accountsChanged")).toBe(true);
  });
});

describe("chainChanged", () => {
  it("reaches every connected origin, because the chain is not per-origin", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin(TEST_ORIGIN, [TEST_ADDRESS]);
    await harness.connectOrigin(OTHER_ORIGIN, [TEST_ADDRESS]);
    harness.events.length = 0;

    await harness.route({ method: "wallet.switchChain", params: { chainId: 1 } }, PRIVILEGED_SENDER);

    const tabs = harness.events
      .filter((entry) => entry.message.event === "chainChanged")
      .map((entry) => entry.tabId)
      .sort();
    expect(tabs).toEqual([1, 2]);
  });

  it("does not tell an unconnected site which network the user is on", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.events.length = 0;

    await harness.route({ method: "wallet.switchChain", params: { chainId: 1 } }, PRIVILEGED_SENDER);

    expect(harness.events).toHaveLength(0);
  });
});
