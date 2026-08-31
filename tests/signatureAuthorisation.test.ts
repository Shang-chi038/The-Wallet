import { describe, expect, it } from "vitest";
import { createHarness, TEST_ADDRESS, TEST_ORIGIN, OTHER_ORIGIN } from "./support/routerHarness";

/**
 * Can a website move funds?
 *
 * Two separate questions, and they have different answers:
 *   A. without the user approving anything  -- proved impossible below
 *   B. with the user approving something the wallet does not explain -- yes
 */

const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function pageRequest(method: string, params: unknown, id = "x") {
  return { namespace: "wallet:inpage", id, method, params, origin: TEST_ORIGIN };
}

describe("A. No fund movement without an approval", () => {
  it("a declined transaction broadcasts nothing and frees the nonce", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const pending = harness.route(
      pageRequest("eth_sendTransaction", [
        { from: TEST_ADDRESS, to: "0x".padEnd(42, "b"), value: "0x2386f26fc10000" },
      ]),
      { kind: "page", origin: TEST_ORIGIN },
    );

    await harness.waitForPendingApproval();
    await harness.answerNextApproval(false);

    const response = await pending;
    expect("error" in response && response.error.code).toBe(4001);
    expect(harness.chain.broadcasts).toEqual([]);
  });

  it("an unconnected origin cannot even queue a transaction", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      {
        namespace: "wallet:inpage",
        id: "y",
        method: "eth_sendTransaction",
        params: [{ from: TEST_ADDRESS, to: "0x".padEnd(42, "b"), value: "0x1" }],
        origin: OTHER_ORIGIN,
      },
      { kind: "page", origin: OTHER_ORIGIN },
    );

    expect("error" in response && response.error.code).toBe(4100);
    expect(harness.presenter.openCount).toBe(0);
    expect(harness.chain.broadcasts).toEqual([]);
  });

  it("a page cannot reach the wallet's own send or answer its own approval", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    for (const method of ["wallet.submitSend", "wallet.prepareSend", "wallet.resolveApproval"]) {
      const response = await harness.route(pageRequest(method, {}), {
        kind: "page",
        origin: TEST_ORIGIN,
      });
      // 4200 unsupportedMethod -- the page is not told the method exists.
      expect("error" in response && response.error.code).toBe(4200);
    }
    expect(harness.chain.broadcasts).toEqual([]);
  });
});

describe("B. An approved signature says what it authorises", () => {
  it("warns on an unlimited EIP-2612 permit, before the field list", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const attacker = "0xaaaa000000000000000000000000000000000aaa";
    const permit = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: harness.chain.chainId,
        verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: TEST_ADDRESS,
        spender: attacker,
        value: MAX_UINT256,
        nonce: 0,
        deadline: 99999999999,
      },
    };

    const pending = harness.route(
      pageRequest("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify(permit)]),
      { kind: "page", origin: TEST_ORIGIN },
    );
    await harness.waitForPendingApproval();

    const shown = harness.context.approvalService.listPending()[0];
    if (!shown || shown.kind !== "typedData") throw new Error("expected a typedData approval");

    expect(shown.warnings).toEqual([
      "spending_permission",
      "unlimited_permission",
      "long_lived_permission",
    ]);
    // The rows are still all there -- the warning is added, not substituted.
    expect(shown.fields).toContainEqual({ path: "spender", value: attacker });

    await harness.answerNextApproval(true);
    const response = await pending;
    if ("error" in response) throw new Error(`signing failed: ${JSON.stringify(response.error)}`);
    expect(typeof response.result).toBe("string");
    expect(harness.chain.broadcasts).toEqual([]);
  });

  it("does not cry unlimited over an ordinary capped, short-lived permit", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const permit = {
      domain: { name: "USD Coin", version: "2", chainId: harness.chain.chainId },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: TEST_ADDRESS,
        spender: "0xaaaa000000000000000000000000000000000aaa",
        value: "1000000",
        // The harness clock is fixed at 2023-11-14; an hour past it.
        deadline: Math.floor(1_700_000_000_000 / 1000) + 3600,
        nonce: 0,
      },
    };

    const pending = harness.route(
      pageRequest("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify(permit)]),
      { kind: "page", origin: TEST_ORIGIN },
    );
    await harness.waitForPendingApproval();

    const shown = harness.context.approvalService.listPending()[0];
    if (!shown || shown.kind !== "typedData") throw new Error("expected a typedData approval");

    // Still says it is a spending permission -- that is always worth saying --
    // but neither escalation fires.
    expect(shown.warnings).toEqual(["spending_permission"]);

    await harness.answerNextApproval(false);
    await pending;
  });

  it("labels an unrecognised structure as blind signing rather than implying it is readable", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();

    const opaque = {
      domain: { name: "Some Protocol", chainId: harness.chain.chainId },
      types: { Thing: [{ name: "a", type: "uint256" }] },
      primaryType: "Thing",
      message: { a: "1" },
    };

    const pending = harness.route(
      pageRequest("eth_signTypedData_v4", [TEST_ADDRESS, JSON.stringify(opaque)]),
      { kind: "page", origin: TEST_ORIGIN },
    );
    await harness.waitForPendingApproval();

    const shown = harness.context.approvalService.listPending()[0];
    if (!shown || shown.kind !== "typedData") throw new Error("expected a typedData approval");
    expect(shown.warnings).toEqual(["blind_signing"]);

    await harness.answerNextApproval(false);
    await pending;
  });
});
