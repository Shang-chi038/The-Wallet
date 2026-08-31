import { describe, expect, it } from "vitest";
import { PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import type { TransactionApprovalPresentation } from "@/core/approval/approvalRequest";
import {
  createHarness,
  expectError,
  expectResult,
  PAGE_SENDER,
  TEST_ADDRESS,
} from "./support/routerHarness";

/**
 * eth_sendTransaction, end to end through the router.
 *
 * This is the path where a mistake costs the user money directly, so the
 * assertions are about ORDER as much as outcome: what is checked before the
 * user is prompted, what the prompt is derived from, and what is cleaned up
 * when the answer is no.
 */

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const RECIPIENT = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

async function connectedHarness() {
  const harness = createHarness();
  await harness.createAndUnlockWallet();
  await harness.connectOrigin();
  return harness;
}

describe("eth_sendTransaction", () => {
  it("signs and broadcasts after approval", async () => {
    const harness = await connectedHarness();

    const pending = harness.route(
      {
        method: "eth_sendTransaction",
        params: [{ from: TEST_ADDRESS, to: RECIPIENT, value: "0x2386f26fc10000" }],
      },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true);

    expect(expectResult<string>(await pending)).toBe(harness.chain.nextTransactionHash);
    expect(harness.chain.broadcasts).toHaveLength(1);
  });

  it("broadcasts nothing when the user declines", async () => {
    const harness = await connectedHarness();

    const pending = harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(false);

    expect(expectError(await pending).code).toBe(PROVIDER_ERROR_CODES.userRejectedRequest);
    expect(harness.chain.broadcasts).toHaveLength(0);
  });

  /**
   * THE NONCE GAP.
   *
   * A nonce allocated to a transaction that is then rejected must go back to
   * the pool. If it does not, every later transaction from that account queues
   * behind a nonce that will never appear on chain, and the wallet looks frozen
   * with nothing to explain why.
   */
  it("returns the nonce to the pool when the user declines", async () => {
    const harness = await connectedHarness();
    const key = { chainId: harness.chain.chainId, address: TEST_ADDRESS };

    const pending = harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([harness.chain.pendingNonce]);

    await harness.answerNextApproval(false);
    await pending;

    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([]);
  });

  /**
   * And the inverse: a broadcast nonce stays claimed. Releasing it on broadcast
   * would hand the same value to the next send, because a node that has just
   * accepted a transaction may not report it on the very next pending count.
   */
  it("keeps a broadcast nonce claimed so the next send does not collide", async () => {
    const harness = await connectedHarness();
    const key = { chainId: harness.chain.chainId, address: TEST_ADDRESS };

    const first = harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true);
    await first;

    const second = harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();

    const presentation = harness.context.approvalService
      .listPending()[0] as TransactionApprovalPresentation;
    expect(presentation.nonce).toBe(harness.chain.pendingNonce + 1);

    await harness.answerNextApproval(false);
    await second;
    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([harness.chain.pendingNonce]);
  });

  /**
   * Rejected BEFORE the prompt. Asking someone to approve a transaction the
   * wallet already knows cannot succeed trains them to click through warnings,
   * and burns a real fee when it reverts.
   */
  it("refuses an unaffordable transaction without prompting", async () => {
    const harness = await connectedHarness();
    harness.chain.nativeBalance = 1n;

    const response = await harness.route(
      {
        method: "eth_sendTransaction",
        params: [{ from: TEST_ADDRESS, to: RECIPIENT, value: "0x2386f26fc10000" }],
      },
      PAGE_SENDER,
    );

    expect(expectError(response).message).toContain("enough ETH");
    expect(harness.presenter.openCount).toBe(0);
  });

  it("prices the transaction with both an expected and a maximum fee", async () => {
    const harness = await connectedHarness();

    void harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();

    const presentation = harness.context.approvalService
      .listPending()[0] as TransactionApprovalPresentation;

    const expected = BigInt(presentation.expectedFeeBaseUnits);
    const maximum = BigInt(presentation.maximumFeeBaseUnits);
    expect(expected).toBeGreaterThan(0n);
    // The ceiling tolerates roughly six blocks of base-fee growth, so it must
    // exceed the expected cost -- and the gap is the whole reason both figures
    // are shown rather than one.
    expect(maximum).toBeGreaterThan(expected);
  });

  /**
   * The fallback exists so an unfunded account can still be shown a fee -- but
   * the number is an approximation and the UI has to be told so, or it presents
   * a guess as a measurement.
   */
  it("flags a fee derived from the static fallback as not estimated", async () => {
    const harness = await connectedHarness();
    harness.chain.gasEstimate = new Error("insufficient funds for gas * price + value");

    void harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();

    const presentation = harness.context.approvalService
      .listPending()[0] as TransactionApprovalPresentation;
    expect(presentation.isFeeEstimated).toBe(false);
  });

  /**
   * A revert is NOT an affordability problem. Substituting a plausible gas
   * number would let the user broadcast a transaction that burns a fee to fail.
   */
  it("propagates a revert instead of substituting a fallback gas limit", async () => {
    const harness = await connectedHarness();
    harness.chain.gasEstimate = new Error("execution reverted: ERC20: transfer amount exceeds balance");

    const response = await harness.route(
      { method: "eth_sendTransaction", params: [{ from: TEST_ADDRESS, to: RECIPIENT }] },
      PAGE_SENDER,
    );
    expect("error" in response).toBe(true);
    expect(harness.presenter.openCount).toBe(0);
  });

  it("labels undecodable calldata as blind signing rather than guessing", async () => {
    const harness = await connectedHarness();
    harness.chain.gasEstimate = 90_000n;

    void harness.route(
      {
        method: "eth_sendTransaction",
        params: [{ from: TEST_ADDRESS, to: RECIPIENT, data: "0xdeadbeef00112233" }],
      },
      PAGE_SENDER,
    );
    await settleMicrotasks();

    const presentation = harness.context.approvalService
      .listPending()[0] as TransactionApprovalPresentation;
    expect(presentation.isBlindSigning).toBe(true);
    expect(presentation.warnings).toContain("blind_signing");
  });

  it("honours a dApp-supplied gas limit without inflating it", async () => {
    const harness = await connectedHarness();

    void harness.route(
      {
        method: "eth_sendTransaction",
        params: [{ from: TEST_ADDRESS, to: RECIPIENT, gas: "0x186a0" }],
      },
      PAGE_SENDER,
    );
    await settleMicrotasks();

    const presentation = harness.context.approvalService
      .listPending()[0] as TransactionApprovalPresentation;
    const maximumFee = BigInt(presentation.maximumFeeBaseUnits);
    // 100000 gas exactly, not 100000 plus a margin.
    expect(maximumFee % 100_000n).toBe(0n);
  });

  it("refuses to send from an account the origin was not granted", async () => {
    const harness = await connectedHarness();
    const response = await harness.route(
      { method: "eth_sendTransaction", params: [{ from: RECIPIENT, to: TEST_ADDRESS }] },
      PAGE_SENDER,
    );
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unauthorized);
    expect(harness.presenter.openCount).toBe(0);
  });
});

describe("chain switching", () => {
  it("tells a dApp 4902 for a chain it has never added", async () => {
    const harness = await connectedHarness();
    const response = await harness.route(
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] },
      PAGE_SENDER,
    );
    // The dApp's cue to call wallet_addEthereumChain and retry. Anything else
    // strands every site that supports network switching.
    expect(expectError(response).code).toBe(PROVIDER_ERROR_CODES.unrecognizedChain);
  });

  it("is a no-op when the requested chain is already active", async () => {
    const harness = await connectedHarness();
    const response = await harness.route(
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] },
      PAGE_SENDER,
    );
    expect(expectResult(response)).toBeNull();
    expect(harness.presenter.openCount).toBe(0);
  });

  it("switches to a known chain after approval, and tells connected pages", async () => {
    const harness = await connectedHarness();

    const pending = harness.route(
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true);
    await pending;

    expect(harness.context.networkService.getActiveChain().chainId).toBe(1);
    expect(
      harness.events.some(
        (entry) => entry.message.event === "chainChanged" && entry.message.params === "0x1",
      ),
    ).toBe(true);
  });

  /**
   * The direct defence against a site "adding" chain 1 with its own RPC and
   * having the user sign real-value mainnet transactions against an
   * attacker-controlled node.
   */
  it("refuses to let a site redefine a built-in chain", async () => {
    const harness = await connectedHarness();
    const pending = harness.route(
      {
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x1",
            chainName: "Definitely Ethereum",
            rpcUrls: ["https://attacker.example/rpc"],
          },
        ],
      },
      PAGE_SENDER,
    );
    // Chain 1 is already known, so this degrades to a switch request to the
    // REAL Ethereum. The attacker's endpoint is discarded entirely rather than
    // registered alongside it.
    await settleMicrotasks();
    await harness.answerNextApproval(false);
    await pending;

    expect(harness.context.networkService.findChain(1)?.rpcUrls[0]).not.toContain("attacker");
    expect(harness.context.networkService.listChains()).toHaveLength(2);
  });

  /**
   * The check the user cannot make for themselves.
   *
   * A site can name any chain it likes. Only the endpoint's own eth_chainId can
   * catch an RPC serving something other than what was claimed -- and it must
   * be caught before the user is prompted, because "is this URL really Polygon"
   * is not a question anyone can answer by reading it.
   */
  it("refuses an endpoint whose own chain id disagrees with the claim", async () => {
    const harness = await connectedHarness();
    // The fake client reports the harness chain (Sepolia) whatever it is asked.
    const response = await harness.route(
      {
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x89",
            chainName: "Polygon",
            rpcUrls: ["https://impostor.example/rpc"],
          },
        ],
      },
      PAGE_SENDER,
    );

    expect(expectError(response).message).toContain("impersonating");
    expect(harness.presenter.openCount).toBe(0);
    expect(harness.context.networkService.findChain(137)).toBeUndefined();
  });

  it("adds and switches to a network whose endpoint checks out", async () => {
    const harness = await connectedHarness();
    // Endpoint agrees it is chain 137.
    harness.chain.chainId = 137;

    const pending = harness.route(
      {
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x89",
            chainName: "Polygon",
            rpcUrls: ["https://polygon-rpc.com"],
            nativeCurrency: { name: "Polygon", symbol: "POL", decimals: 18 },
          },
        ],
      },
      PAGE_SENDER,
    );
    await settleMicrotasks();
    await harness.answerNextApproval(true);
    await pending;

    expect(harness.context.networkService.findChain(137)?.name).toBe("Polygon");
    expect(harness.context.networkService.getActiveChain().chainId).toBe(137);
  });
});
