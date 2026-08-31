import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_NAMESPACE,
  DISCONNECTED,
  EVENT_NAMESPACE,
  OTHER_ORIGIN,
  PAGE_ORIGIN,
  RESPONSE_NAMESPACE,
  USER_REJECTED,
  createBridgeHarness,
  type BridgeHarness,
} from "./support/bridgeHarness";

/**
 * The page bridge.
 *
 * Everything above this layer is covered -- `messagingProtocol.test.ts` proves
 * the allowlist, `originPermissionStore` proves grants are per-origin,
 * `messageRouter.test.ts` proves a page cannot reach a privileged method. All
 * of them enter through `routerHarness`, which hands the router a sender the
 * test constructed.
 *
 * These two files are how a sender is constructed for real, and they were the
 * only ones on the boundary with no test at all. The properties below are the
 * ones a reader currently has to take on trust from a comment:
 *
 *   - the origin on a forwarded request comes from the document, never the
 *     message -- every grant and every approval prompt is anchored to it;
 *   - a message from anywhere but this window is dropped;
 *   - every request settles, including when the service worker is already
 *     gone and no code there will ever run again;
 *   - a response can only settle a request the provider actually issued.
 */

let harness: BridgeHarness;

afterEach(() => {
  harness?.cleanup();
});

function only<T>(items: T[]): T {
  if (items.length !== 1) {
    throw new Error(`expected exactly one item, got ${items.length}`);
  }
  return items[0] as T;
}

/** A well-formed request, as the injected provider would post it. */
function pageRequest(overrides: Record<string, unknown> = {}) {
  return {
    namespace: BRIDGE_NAMESPACE,
    id: "request-1",
    method: "eth_accounts",
    params: [],
    ...overrides,
  };
}

describe("the origin on a forwarded request", () => {
  it("is the document's own, stamped by the extension", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest());
    await harness.flush();

    expect(only(harness.forwarded).origin).toBe(PAGE_ORIGIN);
  });

  /**
   * THE test in this file.
   *
   * `contentScript.ts` destructures the three fields it forwards and builds a
   * fresh object with the real origin. That is correct, and it is defended by
   * nothing except the shape staying that way -- a tidy-up to
   * `{ ...event.data, origin }` reads identically, passes review, and lets a
   * page name the origin that every per-origin grant and every approval prompt
   * is keyed to. A site could then ask as the site next to it.
   */
  it("ignores an origin the page supplies for itself", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest({ origin: OTHER_ORIGIN }));
    await harness.flush();

    expect(only(harness.forwarded).origin).toBe(PAGE_ORIGIN);
  });

  /**
   * The same guarantee, stated as a whitelist rather than as a value.
   *
   * A page-supplied `sender`, `tab` or `frameId` would be read by
   * `classifySender` on the other side if it ever survived the crossing, and
   * that is the function deciding whether a caller may reach
   * `wallet.revealMnemonic`. Nothing the page writes is carried over.
   */
  it("carries no field the page attached beyond the four it forwards", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(
      pageRequest({
        origin: OTHER_ORIGIN,
        sender: { id: "some-extension-id", tab: { id: 7 } },
        frameId: 0,
      }),
    );
    await harness.flush();

    expect(Object.keys(only(harness.forwarded)).sort()).toEqual([
      "id",
      "method",
      "namespace",
      "origin",
      "params",
    ]);
  });

  it("forwards the method and params unchanged", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    const params = [{ to: "0xabc", value: "0x1" }];
    harness.postFromPage(pageRequest({ method: "eth_sendTransaction", params }));
    await harness.flush();

    const forwarded = only(harness.forwarded);
    expect(forwarded.method).toBe("eth_sendTransaction");
    expect(forwarded.params).toEqual(params);
  });
});

describe("messages the bridge refuses to forward", () => {
  /**
   * An embedded frame posting to the top window would otherwise be forwarded
   * under the TOP-LEVEL origin -- so the approval prompt would name the site
   * the user is looking at while an ad frame did the asking. This is the
   * highest-consequence drop of the four.
   */
  it("drops a message posted by another window", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest(), { source: { name: "an iframe" } });
    await harness.flush();

    expect(harness.forwarded).toEqual([]);
  });

  it("drops a message whose origin is not this document's", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest(), { origin: OTHER_ORIGIN });
    await harness.flush();

    expect(harness.forwarded).toEqual([]);
  });

  it("drops anything outside the bridge namespace", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage({ id: "1", method: "eth_accounts" });
    harness.postFromPage(pageRequest({ namespace: "wallet:inpage:response" }));
    harness.postFromPage(pageRequest({ namespace: "some-other-extension" }));
    await harness.flush();

    expect(harness.forwarded).toEqual([]);
  });

  /**
   * Shape checks, not politeness. An empty method reaches the router's
   * allowlist as a lookup miss and a non-string reaches it as a type the
   * allowlist was never written against; neither should get that far.
   */
  it("drops a malformed request", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest({ id: "" }));
    harness.postFromPage(pageRequest({ id: 7 }));
    harness.postFromPage(pageRequest({ method: "" }));
    harness.postFromPage(pageRequest({ method: null }));
    harness.postFromPage(null);
    harness.postFromPage("wallet:inpage");
    await harness.flush();

    expect(harness.forwarded).toEqual([]);
  });
});

describe("responses to the page", () => {
  /**
   * A wildcard target would deliver responses -- including the account
   * addresses `eth_accounts` returns -- to whatever happens to be listening on
   * a window that can be embedded.
   */
  it("are targeted at this document's origin, never a wildcard", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.postFromPage(pageRequest());
    harness.pushWorkerEvent({
      namespace: EVENT_NAMESPACE,
      event: "accountsChanged",
      params: [],
    });
    await harness.flush();

    expect(harness.posts.length).toBeGreaterThan(0);
    for (const post of harness.posts) {
      expect(post.targetOrigin).toBe(PAGE_ORIGIN);
    }
  });

  it("carry the worker's result under the id that asked for it", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.respondWith = () => ({ result: ["0xabc"] });

    harness.postFromPage(pageRequest({ id: "request-a" }));
    harness.postFromPage(pageRequest({ id: "request-b", method: "eth_chainId" }));
    await harness.flush();

    expect(harness.responses()).toEqual([
      { namespace: RESPONSE_NAMESPACE, id: "request-a", result: ["0xabc"] },
      { namespace: RESPONSE_NAMESPACE, id: "request-b", result: ["0xabc"] },
    ]);
  });

  it("carry the worker's error verbatim", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.respondWith = () => ({
      error: { code: 4100, message: "This site is not connected." },
    });

    harness.postFromPage(pageRequest());
    await harness.flush();

    expect(only(harness.responses())).toEqual({
      namespace: RESPONSE_NAMESPACE,
      id: "request-1",
      error: { code: 4100, message: "This site is not connected." },
    });
  });
});

/**
 * The approval queue settles every request it knows about. It cannot settle
 * one when Chrome has already killed the worker, because the queue died with
 * it -- so this half is the only half that runs in that case, and until now it
 * was the untested one. A dApp left waiting forever is the worst failure this
 * bridge has: no error, no timeout, just a spinner nobody can explain.
 */
describe("the half of the settle guarantee that survives worker teardown", () => {
  it("answers 4001 when the port closes with no response", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.simulateClosedPort = true;

    harness.postFromPage(pageRequest());
    await harness.flush();

    expect(only(harness.responses())).toEqual({
      namespace: RESPONSE_NAMESPACE,
      id: "request-1",
      error: {
        code: USER_REJECTED,
        message: "The wallet closed this request before it was answered.",
      },
    });
  });

  it("answers 4001 when the worker responds with nothing at all", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.respondWith = () => undefined;

    harness.postFromPage(pageRequest());
    await harness.flush();

    expect(only(harness.responses())["error"]).toMatchObject({ code: USER_REJECTED });
  });

  it("answers 4900 when the extension context is gone", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.simulateContextInvalidated = true;

    harness.postFromPage(pageRequest());
    await harness.flush();

    expect(only(harness.responses())).toEqual({
      namespace: RESPONSE_NAMESPACE,
      id: "request-1",
      error: {
        code: DISCONNECTED,
        message: "The wallet extension was reloaded. Refresh the page.",
      },
    });
  });

  it("answers every request exactly once", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.simulateClosedPort = true;

    harness.postFromPage(pageRequest({ id: "request-a" }));
    harness.postFromPage(pageRequest({ id: "request-b" }));
    harness.postFromPage(pageRequest({ id: "request-c" }));
    await harness.flush();

    expect(harness.responses().map((response) => response["id"])).toEqual([
      "request-a",
      "request-b",
      "request-c",
    ]);
  });
});

describe("provider events pushed from the worker", () => {
  it("are relayed to the page", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.pushWorkerEvent({
      namespace: EVENT_NAMESPACE,
      event: "accountsChanged",
      params: ["0xabc"],
    });
    await harness.flush();

    expect(only(harness.events())).toEqual({
      namespace: EVENT_NAMESPACE,
      event: "accountsChanged",
      params: ["0xabc"],
    });
  });

  it("ignores a worker message that is not a provider event", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.pushWorkerEvent({ namespace: "something-else", event: "accountsChanged" });
    harness.pushWorkerEvent({ namespace: EVENT_NAMESPACE });
    harness.pushWorkerEvent({ namespace: EVENT_NAMESPACE, event: 7 });
    await harness.flush();

    expect(harness.events()).toEqual([]);
  });

  /**
   * The `return true` trap, in the direction that hangs the SENDER.
   *
   * This listener never calls `sendResponse`, so returning true would hold the
   * service worker's port open until it gives up -- once per event, on every
   * tab with a page open.
   */
  it("never holds the worker's port open", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();

    harness.pushWorkerEvent({ namespace: EVENT_NAMESPACE, event: "chainChanged", params: "0x1" });
    harness.pushWorkerEvent({ namespace: "not-ours" });

    expect(harness.workerEventReturnValues).toEqual([undefined, undefined]);
  });
});

interface InjectedProvider {
  isWallet: boolean;
  chainId: string | undefined;
  selectedAddress: string | undefined;
  isConnected(): boolean;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): unknown;
  enable(): Promise<unknown>;
}

/** Both halves loaded, booted, and the boot traffic cleared away. */
async function bootBridge(): Promise<{
  harness: BridgeHarness;
  provider: InjectedProvider;
}> {
  const booted = createBridgeHarness();
  await booted.loadContentScript();
  await booted.loadProvider();
  await booted.flush();
  booted.clearRecords();
  return { harness: booted, provider: booted.window.ethereum as InjectedProvider };
}

describe("the injected provider", () => {
  it("resolves a request through the bridge", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.respondWith = () => ({ result: ["0xabc"] });

    const pending = booted.provider.request({ method: "eth_accounts" });
    await harness.flush();

    expect(await pending).toEqual(["0xabc"]);
    expect(only(harness.forwarded).origin).toBe(PAGE_ORIGIN);
  });

  it("rejects with an Error carrying the EIP-1193 code", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.respondWith = () => ({
      error: { code: USER_REJECTED, message: "You declined this request." },
    });

    const pending = booted.provider.request({ method: "eth_requestAccounts" });
    await harness.flush();

    /**
     * A real Error subclass, not a plain object: dApps branch on
     * `error.code === 4001` and then routinely log `error.message` or read
     * `error.stack`. Rejecting with an object breaks the second half and makes
     * a user cancellation look like a crash.
     */
    await expect(pending).rejects.toThrowError(Error);
    await pending.catch((error: unknown) => {
      expect(error).toMatchObject({
        name: "ProviderRpcError",
        code: USER_REJECTED,
        message: "You declined this request.",
      });
    });
  });

  it("keeps concurrent requests matched to their own responses", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.respondWith = (message) => ({ result: `answer:${String(message.method)}` });

    const accounts = booted.provider.request({ method: "eth_accounts" });
    const chain = booted.provider.request({ method: "eth_chainId" });
    await harness.flush();

    expect(await accounts).toBe("answer:eth_accounts");
    expect(await chain).toBe("answer:eth_chainId");
  });

  it("rejects a request with no method without troubling the wallet", async () => {
    const booted = await bootBridge();
    harness = booted.harness;

    await expect(booted.provider.request({ method: "" })).rejects.toMatchObject({
      code: -32602,
    });
    await harness.flush();

    expect(harness.forwarded).toEqual([]);
  });

  /**
   * A response can only settle a request the provider actually issued.
   *
   * The ids are `crypto.randomUUID()`, so a forged response cannot name one --
   * and an unknown id must be dropped rather than, say, settling whatever is
   * oldest. A page lying to its own provider can only lie to itself, but it
   * must not be able to answer on the wallet's behalf.
   */
  it("ignores a response for an id it never issued", async () => {
    const booted = await bootBridge();
    harness = booted.harness;

    /**
     * Exactly ONE request may be in flight for this to prove anything. The
     * boot-time `eth_chainId` is already settled by `bootBridge`, so a lookup
     * that fell back to "whatever is pending" has only this request to land
     * on -- and lands on it, rather than on a spare the assertion ignores.
     */
    harness.simulateNoReply = true;
    const settled: string[] = [];
    const pending = booted.provider.request({ method: "eth_accounts" });
    void pending.then(
      () => settled.push("resolved"),
      () => settled.push("rejected"),
    );
    await harness.flush();
    expect(harness.forwarded).toHaveLength(1);

    harness.postFromPage({
      namespace: RESPONSE_NAMESPACE,
      id: "an-id-nobody-issued",
      result: ["0xattacker"],
    });
    await harness.flush();

    expect(settled).toEqual([]);
  });

  /**
   * The content script drops what other windows post to it; this is the same
   * guarantee on the return leg, where the payload is not a request but an
   * ANSWER the dApp will act on. An embedded frame that could resolve a
   * pending request would be choosing what `eth_accounts` returns.
   */
  it("ignores a response posted by another window", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.simulateNoReply = true;

    const settled: string[] = [];
    const pending = booted.provider.request({ method: "eth_accounts" });
    void pending.then(
      () => settled.push("resolved"),
      () => settled.push("rejected"),
    );
    await harness.flush();

    // The real id, read off the wire -- so the only thing wrong with the
    // forged response is the window it came from.
    const issued = harness.posts.find(
      (post) => post.data["namespace"] === BRIDGE_NAMESPACE,
    );
    expect(issued?.data["id"]).toEqual(expect.any(String));

    harness.postFromPage(
      {
        namespace: RESPONSE_NAMESPACE,
        id: issued?.data["id"],
        result: ["0xattacker"],
      },
      { source: { name: "an iframe" } },
    );
    await harness.flush();

    expect(settled).toEqual([]);
  });

  it("ignores a second response for a request already settled", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.respondWith = () => ({ result: ["0xtrue"] });

    const pending = booted.provider.request({ method: "eth_accounts" });
    await harness.flush();
    expect(await pending).toEqual(["0xtrue"]);

    const issuedId = only(harness.forwarded).id;
    harness.postFromPage({
      namespace: RESPONSE_NAMESPACE,
      id: issuedId,
      result: ["0xattacker"],
    });
    await harness.flush();

    expect(await pending).toEqual(["0xtrue"]);
    expect(booted.provider.selectedAddress).toBe("0xtrue");
  });

  /**
   * The legacy mirrors are updated BEFORE listeners run. A handler that reads
   * `window.ethereum.selectedAddress` -- and a lot of deployed dApp code does
   * exactly that -- must see the account the event is announcing, not the
   * previous one.
   */
  it("mirrors accountsChanged into selectedAddress before notifying listeners", async () => {
    const booted = await bootBridge();
    harness = booted.harness;

    const observed: (string | undefined)[] = [];
    booted.provider.on("accountsChanged", () => {
      observed.push(booted.provider.selectedAddress);
    });

    harness.pushWorkerEvent({
      namespace: EVENT_NAMESPACE,
      event: "accountsChanged",
      params: ["0xnew"],
    });
    await harness.flush();

    expect(observed).toEqual(["0xnew"]);
  });

  it("mirrors chainChanged into chainId", async () => {
    const booted = await bootBridge();
    harness = booted.harness;

    harness.pushWorkerEvent({
      namespace: EVENT_NAMESPACE,
      event: "chainChanged",
      params: "0xaa36a7",
    });
    await harness.flush();

    expect(booted.provider.chainId).toBe("0xaa36a7");
  });

  it("announces itself over EIP-6963 on request", async () => {
    const booted = await bootBridge();
    harness = booted.harness;

    const announced: { info: { rdns: string }; provider: unknown }[] = [];
    harness.window.addEventListener("eip6963:announceProvider", ((event: {
      detail: { info: { rdns: string }; provider: unknown };
    }) => {
      announced.push(event.detail);
    }) as never);

    harness.window.dispatchEvent({ type: "eip6963:requestProvider" });

    expect(only(announced).info.rdns).toBe("xyz.wallet.extension");
    expect(only(announced).provider).toBe(booted.provider);
  });

  /**
   * Clobbering a competitor's provider breaks the user's other wallet, and is
   * the exact behaviour EIP-6963 exists to end. We take `window.ethereum` only
   * if it is free, and stay reachable through the announcement either way.
   */
  it("does not clobber another wallet already at window.ethereum", async () => {
    harness = createBridgeHarness();
    const otherWallet = { isSomeOtherWallet: true };
    harness.window.ethereum = otherWallet;

    await harness.loadContentScript();
    await harness.loadProvider();
    await harness.flush();

    expect(harness.window.ethereum).toBe(otherWallet);

    const announced: { provider: unknown }[] = [];
    harness.window.addEventListener("eip6963:announceProvider", ((event: {
      detail: { provider: unknown };
    }) => {
      announced.push(event.detail);
    }) as never);
    harness.window.dispatchEvent({ type: "eip6963:requestProvider" });

    expect(only(announced).provider).not.toBe(otherWallet);
    expect(only(announced).provider).toMatchObject({ isWallet: true });
  });

  /**
   * EIP-1193 says a provider emits `connect` when it can serve requests, and
   * dApps commonly wait for it before doing anything -- so a provider that
   * never emits it looks permanently unavailable.
   */
  it("emits connect once the chain id comes back", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    await harness.loadProvider();

    const provider = harness.window.ethereum as InjectedProvider;
    const connected: unknown[] = [];
    provider.on("connect", (payload) => connected.push(payload));

    await harness.flush();

    expect(only(connected)).toEqual({ chainId: "0x1" });
    expect(provider.chainId).toBe("0x1");
  });

  /**
   * Staying quiet when the wallet is unreachable is deliberate: a `disconnect`
   * here would tell every open site the user has no wallet, when the truth is
   * that the worker is asleep and will wake on the next request.
   */
  it("stays quiet when the wallet cannot be reached at all", async () => {
    harness = createBridgeHarness();
    await harness.loadContentScript();
    harness.simulateContextInvalidated = true;
    await harness.loadProvider();

    const provider = harness.window.ethereum as InjectedProvider;
    const seen: string[] = [];
    provider.on("connect", () => seen.push("connect"));
    provider.on("disconnect", () => seen.push("disconnect"));

    await harness.flush();

    expect(seen).toEqual([]);
    expect(provider.chainId).toBeUndefined();
  });

  it("bridges the legacy enable() alias to eth_requestAccounts", async () => {
    const booted = await bootBridge();
    harness = booted.harness;
    harness.respondWith = () => ({ result: ["0xabc"] });

    const pending = booted.provider.enable();
    await harness.flush();

    expect(await pending).toEqual(["0xabc"]);
    expect(only(harness.forwarded).method).toBe("eth_requestAccounts");
  });
});
