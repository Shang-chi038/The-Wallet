import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { createMemoryStorageArea } from "@/core/vault/vaultStorage";
import { NetworkService } from "@/background/networkService";
import { createHarness, OTHER_ORIGIN, TEST_ORIGIN } from "./support/routerHarness";

/**
 * `wallet_addEthereumChain` as an OUTBOUND REQUEST PRIMITIVE.
 *
 * The method is reachable from any website and, before it can prompt, it asks
 * the proposed endpoint for its own chain id -- at a URL the PAGE supplied.
 * Ungated that is: a beacon to an arbitrary host from the user's IP with this
 * extension's `<all_urls>` access, a loopback port scanner that Chrome's
 * Private Network Access checks do not see because the request originates in
 * the service worker, and an unbounded one, because a mismatched answer throws
 * before anything is queued and the approval queue's cap never engages.
 *
 * These tests pin the gate that closes it. Each was written against the
 * unfixed code first and observed to FAIL.
 */

const ATTACKER_RPC = "https://beacon.attacker.example/rpc";

function addChainRequest(id: string, rpcUrl: string, origin: string) {
  return {
    namespace: "wallet:inpage",
    id,
    method: "wallet_addEthereumChain",
    params: [{ chainId: "0xf423f", chainName: "Probe", rpcUrls: [rpcUrl] }],
    origin,
  };
}

describe("wallet_addEthereumChain requires a connected origin", () => {
  it("refuses an unconnected site without contacting the endpoint", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    // Deliberately not connected.

    const response = await harness.route(
      addChainRequest("probe", ATTACKER_RPC, OTHER_ORIGIN),
      { kind: "page", origin: OTHER_ORIGIN },
    );

    expect("error" in response && response.error.code).toBe(4100);
    expect(harness.presenter.openCount).toBe(0);
  });

  it("does not leak a probed endpoint's chain id to an unconnected site", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.chainId = 31337;

    const response = await harness.route(
      addChainRequest("leak", "https://rpc.example.com", OTHER_ORIGIN),
      { kind: "page", origin: OTHER_ORIGIN },
    );

    // `chain_id_mismatch` is page-safe and its message names what answered, so
    // reaching the verification step at all is the leak. The gate is in front.
    expect("error" in response && response.error.message).not.toContain("31337");
  });

  it("still prompts a CONNECTED site, so the feature is gated and not removed", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    await harness.connectOrigin();
    // The fake client answers with the harness chain id; make the claim match.
    harness.chain.chainId = 999999;

    const pending = harness.route(
      addChainRequest("ok", "https://rpc.example.com", TEST_ORIGIN),
      { kind: "page", origin: TEST_ORIGIN },
    );
    await harness.waitForPendingApproval();
    await harness.answerNextApproval(false);

    const response = await pending;
    expect("error" in response && response.error.code).toBe(4001);
    expect(harness.presenter.openCount).toBe(1);
  });

  /**
   * The EIP-3326 flow -- switch, get 4902, add, retry -- must keep working for
   * a site that has not connected yet, so the gate sits AFTER the check for a
   * chain the wallet already has. That path makes no outbound request.
   */
  it("lets an unconnected site propose a chain the wallet already has", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pending = harness.route(
      {
        ...addChainRequest("known", "https://rpc.example.com", OTHER_ORIGIN),
        params: [
          {
            chainId: "0x1",
            chainName: "Ethereum",
            rpcUrls: ["https://rpc.example.com"],
          },
        ],
      },
      { kind: "page", origin: OTHER_ORIGIN },
    );
    await harness.waitForPendingApproval();
    await harness.answerNextApproval(false);

    // It reached a PROMPT rather than an `unauthorized`, which is the whole
    // point of placing the gate after the `existing` check.
    const response = await pending;
    expect("error" in response && response.error.code).toBe(4001);
  });
});

describe("a custom RPC endpoint must be publicly routable", () => {
  function serviceContacting(contacted: string[][]) {
    return new NetworkService({
      area: createMemoryStorageArea(),
      createClient: (_chain, rpcUrls) => {
        contacted.push(rpcUrls);
        return { async getChainId() { return 31337; } } as unknown as PublicClient;
      },
    });
  }

  it.each([
    ["loopback by name", "https://localhost:8545"],
    ["loopback by address", "https://127.0.0.1:8545"],
    ["IPv6 loopback", "https://[::1]:8545"],
    ["private network", "https://192.168.1.1/rpc"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["plain http", "http://127.0.0.1:8545"],
  ])("refuses %s without opening a connection", async (_label, rpcUrl) => {
    const contacted: string[][] = [];
    await expect(
      serviceContacting(contacted).prepareCustomChain({
        chainId: 999999,
        name: "Probe",
        rpcUrl,
      }),
    ).rejects.toThrow();

    // The refusal happens before any client is built, so nothing was dialled.
    expect(contacted).toEqual([]);
  });
});
