import { describe, expect, it } from "vitest";
import { toChecksumAddress } from "@/core/account/ethereumAddress";
import type { WatchAssetApprovalPresentation } from "@/core/approval/approvalRequest";
import type { TokenListResult } from "@/core/messaging/walletApi";
import {
  createHarness,
  expectError,
  expectResult,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
  type Harness,
} from "./support/routerHarness";

/**
 * EIP-747 -- a website asking for a token to appear in the wallet.
 *
 * The property every test here defends: THE PAGE CHOOSES THE ADDRESS AND
 * NOTHING ELSE. EIP-747 lets the caller send `symbol` and `decimals`, and a
 * wallet that honours them lets any site register "USDC, 6 decimals" against a
 * contract it wrote -- producing a row indistinguishable from the real USDC in
 * the list the user picks from when sending.
 */

const HONEST_TOKEN = toChecksumAddress("0x00000000000000000000000000000000000000bb");
const NOT_A_TOKEN = toChecksumAddress("0x00000000000000000000000000000000000000cc");

async function connectedHarness(): Promise<Harness> {
  const harness = createHarness();
  await harness.createAndUnlockWallet();
  await harness.connectOrigin();
  return harness;
}

function watchAssetParams(address: string, extra: Record<string, unknown> = {}): unknown {
  return { type: "ERC20", options: { address, ...extra } };
}

async function listImportedTokens(harness: Harness): Promise<TokenListResult["tokens"]> {
  return expectResult<TokenListResult>(
    await harness.route({ method: "wallet.listTokens" }, PRIVILEGED_SENDER),
  ).tokens;
}

describe("wallet_watchAsset", () => {
  it("prompts, then stores the token the CONTRACT describes", async () => {
    const harness = await connectedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
    });

    const pending = harness.route(
      { method: "wallet_watchAsset", params: watchAssetParams(HONEST_TOKEN) },
      PAGE_SENDER,
    );
    await harness.waitForPendingApproval();
    await harness.answerNextApproval(true);

    expect(expectResult<boolean>(await pending)).toBe(true);
    const tokens = await listImportedTokens(harness);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8 });
  });

  /**
   * The regression this whole handler is shaped around. The page sends metadata
   * for a contract that says something else entirely; what is shown and what is
   * stored must both come from the contract.
   */
  it("ignores the symbol and decimals the page supplied", async () => {
    const harness = await connectedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
    });

    const pending = harness.route(
      {
        method: "wallet_watchAsset",
        params: watchAssetParams(HONEST_TOKEN, { symbol: "USDC", decimals: 6, name: "USD Coin" }),
      },
      PAGE_SENDER,
    );
    await harness.waitForPendingApproval();

    const presentation = harness.context.approvalService
      .listPending()[0] as WatchAssetApprovalPresentation;
    expect(presentation.kind).toBe("watchAsset");
    expect(presentation.token).toMatchObject({ symbol: "WBTC", decimals: 8 });

    await harness.answerNextApproval(true);
    await pending;

    const tokens = await listImportedTokens(harness);
    expect(tokens[0]).toMatchObject({ symbol: "WBTC", decimals: 8 });
  });

  it("declines as 4001 and stores nothing when the user says no", async () => {
    const harness = await connectedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });

    const pending = harness.route(
      { method: "wallet_watchAsset", params: watchAssetParams(HONEST_TOKEN) },
      PAGE_SENDER,
    );
    await harness.waitForPendingApproval();
    await harness.answerNextApproval(false);

    expect(expectError(await pending).code).toBe(4001);
    expect(await listImportedTokens(harness)).toEqual([]);
  });

  /**
   * A site asking for a state that already holds is not asking for anything.
   * Re-prompting on every page load is how a dApp trains its users to click
   * through wallet dialogs without reading them.
   */
  it("answers true without prompting for a token the wallet already has", async () => {
    const harness = await connectedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });
    await harness.route(
      { method: "wallet.importToken", params: { address: HONEST_TOKEN, decimals: 8 } },
      PRIVILEGED_SENDER,
    );

    const response = await harness.route(
      { method: "wallet_watchAsset", params: watchAssetParams(HONEST_TOKEN) },
      PAGE_SENDER,
    );

    expect(expectResult<boolean>(response)).toBe(true);
    expect(harness.context.approvalService.listPending()).toEqual([]);
    expect(await listImportedTokens(harness)).toHaveLength(1);
  });

  /**
   * The prompt has nothing to say about an address that does not answer as a
   * token, and a user cannot be asked to judge one. Refused before it is shown.
   */
  it("refuses an address that is not a token contract, without prompting", async () => {
    const harness = await connectedHarness();

    const response = await harness.route(
      { method: "wallet_watchAsset", params: watchAssetParams(NOT_A_TOKEN) },
      PAGE_SENDER,
    );

    expect("error" in response).toBe(true);
    expect(harness.context.approvalService.listPending()).toEqual([]);
  });

  /**
   * Everything this handler does past the parse reads a contract over the
   * network, with an address the PAGE chose. Ungated, any site the user merely
   * visits could make the wallet issue RPC calls on demand -- billed to this
   * wallet's rate-limit key, from the user's IP -- without a prompt ever
   * appearing.
   */
  it("refuses a site the user has not connected, before touching the network", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });

    const error = expectError(
      await harness.route(
        { method: "wallet_watchAsset", params: watchAssetParams(HONEST_TOKEN) },
        PAGE_SENDER,
      ),
    );
    expect(error.code).toBe(4100);
    expect(harness.context.approvalService.listPending()).toEqual([]);
  });

  it("refuses asset types that are not ERC20", async () => {
    const harness = await connectedHarness();

    const response = await harness.route(
      {
        method: "wallet_watchAsset",
        params: { type: "ERC721", options: { address: HONEST_TOKEN, tokenId: "1" } },
      },
      PAGE_SENDER,
    );

    expect("error" in response).toBe(true);
  });

  /**
   * EIP-747 specifies a bare object where every other method on this surface
   * takes an array, and libraries disagree about it. Both are accepted rather
   * than failing on a wrapper the calling site cannot control.
   */
  it("accepts the params as a bare object or wrapped in an array", async () => {
    for (const params of [
      watchAssetParams(HONEST_TOKEN),
      [watchAssetParams(HONEST_TOKEN)],
    ]) {
      const harness = await connectedHarness();
      harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });

      const pending = harness.route({ method: "wallet_watchAsset", params }, PAGE_SENDER);
      await harness.waitForPendingApproval();
      await harness.answerNextApproval(true);

      expect(expectResult<boolean>(await pending)).toBe(true);
    }
  });

  /**
   * A token added this way is an IMPORTED token, so the never-price rule
   * applies unchanged -- which is the rule's whole point. A site-suggested
   * token is exactly the case it was written for.
   */
  it("adds it as an unpriced token", async () => {
    const harness = await connectedHarness();
    // A contract calling itself by a symbol the price feed knows.
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 6, symbol: "USDC" });

    const pending = harness.route(
      { method: "wallet_watchAsset", params: watchAssetParams(HONEST_TOKEN) },
      PAGE_SENDER,
    );
    await harness.waitForPendingApproval();
    await harness.answerNextApproval(true);
    await pending;

    const tokens = await listImportedTokens(harness);
    expect(tokens[0]?.address).toBe(HONEST_TOKEN);
  });
});
