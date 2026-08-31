import { vi } from "vitest";

/**
 * The page bridge, in memory, with no browser and no chrome.*
 *
 * `contentScript.ts` and `provider.ts` are the only two files that carry
 * attacker-controlled input across the trust boundary, and they were the only
 * two with no tests -- because both are side-effecting modules that reach for
 * `window` and `chrome.runtime` the moment they are imported, which is exactly
 * the shape the hermetic suite has no environment for.
 *
 * So this harness supplies that environment. It builds one fake `window` that
 * both halves share, the way they share a real one (a MAIN-world script and an
 * ISOLATED-world content script live in different JavaScript realms but post
 * messages through the same window object), plus a fake `chrome.runtime` whose
 * failure modes -- a closed port, an invalidated context -- can be asked for
 * rather than waited for.
 *
 * WHAT THIS DELIBERATELY DOES NOT FAKE: the origin. `event.origin` and
 * `window.location.origin` are supplied by the browser and are the one thing a
 * page cannot forge, which is why every grant in this wallet is anchored to
 * them. A test posts a message claiming any origin it likes; the harness
 * reports the true one, and the assertion is that the bridge believes the
 * harness rather than the message.
 */

/**
 * Restated here rather than imported.
 *
 * The bridge files import nothing at all -- they run at `document_start` and
 * must not pull a module graph in with them -- so there is no shared constant
 * to reach for. Duplicating the wire format means a test fails if someone
 * renames a namespace on one side only, which is the break this would
 * otherwise ship silently: a provider posting into a namespace no content
 * script is listening on looks exactly like a wallet that is not installed.
 */
export const BRIDGE_NAMESPACE = "wallet:inpage";
export const RESPONSE_NAMESPACE = `${BRIDGE_NAMESPACE}:response`;
export const EVENT_NAMESPACE = `${BRIDGE_NAMESPACE}:event`;

/** The document the bridge believes it is running in. */
export const PAGE_ORIGIN = "https://app.example";
/** Any other origin. Used for messages that must never be honoured. */
export const OTHER_ORIGIN = "https://evil.example";

/** EIP-1193 codes the bridge produces on its own, without the worker. */
export const USER_REJECTED = 4001;
export const DISCONNECTED = 4900;

type Listener = (event: never) => unknown;

export interface PostedMessage {
  data: Record<string, unknown>;
  targetOrigin: string;
}

/** What the content script handed to `chrome.runtime.sendMessage`. */
export interface ForwardedMessage {
  namespace?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  origin?: unknown;
  [key: string]: unknown;
}

export interface FakeWindow {
  location: { origin: string };
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  dispatchEvent(event: unknown): boolean;
  postMessage(data: Record<string, unknown>, targetOrigin: string): void;
  ethereum?: unknown;
}

export interface BridgeHarness {
  /** The window both halves of the bridge share. */
  window: FakeWindow;
  /** Every `window.postMessage` the bridge made, with the target origin it chose. */
  posts: PostedMessage[];
  /** Every message the content script forwarded to the service worker. */
  forwarded: ForwardedMessage[];
  /**
   * What each `chrome.runtime.onMessage` listener RETURNED.
   *
   * Recorded because the return value is load-bearing and invisible: `true`
   * holds the sender's port open awaiting a response that this listener never
   * sends, and CLAUDE.md records the trap in both directions.
   */
  workerEventReturnValues: unknown[];

  /** How the fake service worker answers. Reassign to change the reply. */
  respondWith: (message: ForwardedMessage) => unknown;
  /** Chrome killed the worker mid-request: the port closes with no answer. */
  simulateClosedPort: boolean;
  /** The extension was reloaded: `sendMessage` throws synchronously. */
  simulateContextInvalidated: boolean;
  /**
   * The worker takes the request and says nothing yet -- an approval is open
   * and the user is reading it. The port stays alive, so this is NOT the
   * closed-port case; it is how a test holds exactly one request pending.
   */
  simulateNoReply: boolean;

  loadContentScript(): Promise<void>;
  loadProvider(): Promise<void>;

  /**
   * A message arriving from the page.
   *
   * `source` and `origin` default to the values a same-window post really
   * produces; a test overrides them to speak as an iframe or another origin.
   */
  postFromPage(
    data: unknown,
    options?: { source?: unknown; origin?: string },
  ): void;
  /** A provider event pushed down from the service worker. */
  pushWorkerEvent(message: unknown): void;

  /** Posts in the response namespace, newest last. */
  responses(): Record<string, unknown>[];
  /** Posts in the event namespace, newest last. */
  events(): Record<string, unknown>[];

  /** Run the bridge until no message and no callback is left in flight. */
  flush(): Promise<void>;
  /** Forget what has been recorded so far, keeping the loaded modules. */
  clearRecords(): void;
  cleanup(): void;
}

export function createBridgeHarness(
  options: { origin?: string } = {},
): BridgeHarness {
  const origin = options.origin ?? PAGE_ORIGIN;

  const listeners = new Map<string, Set<Listener>>();
  const posts: PostedMessage[] = [];
  const forwarded: ForwardedMessage[] = [];
  const workerEventReturnValues: unknown[] = [];

  /**
   * Delivery is QUEUED, not synchronous.
   *
   * `window.postMessage` is asynchronous in a real browser, and a bridge that
   * only works when delivery is re-entrant would pass a synchronous harness
   * and deadlock in Chrome. Queuing also makes "what is in flight right now"
   * something a test can inspect between turns.
   */
  const deliveryQueue: (() => void)[] = [];
  const callbackQueue: (() => void)[] = [];

  function dispatch(type: string, event: unknown): void {
    // Copied before iterating: a listener may add or remove listeners, and in
    // the provider's case one of them does.
    for (const listener of [...(listeners.get(type) ?? [])]) {
      (listener as (value: unknown) => unknown)(event);
    }
  }

  const fakeWindow: FakeWindow = {
    location: { origin },

    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? new Set<Listener>();
      existing.add(listener);
      listeners.set(type, existing);
    },

    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },

    dispatchEvent(event) {
      const candidate = event as { type?: unknown };
      if (typeof candidate.type === "string") dispatch(candidate.type, event);
      return true;
    },

    postMessage(data, targetOrigin) {
      posts.push({ data, targetOrigin });
      /**
       * Delivered to EVERY message listener on this window, including the
       * sender's own -- which is what a real browser does, and is the reason
       * each half has to recognise the other half's traffic and ignore it.
       * A harness that routed only to "the other side" would hide a provider
       * that tried to answer its own requests.
       */
      deliveryQueue.push(() => {
        dispatch("message", { data, origin, source: fakeWindow });
      });
    },
  };

  const harness: BridgeHarness = {
    window: fakeWindow,
    posts,
    forwarded,
    workerEventReturnValues,

    respondWith(message) {
      // `connect` is only emitted once a chain id comes back, so the default
      // reply answers eth_chainId with one. Everything else resolves to null.
      if (message.method === "eth_chainId") return { result: "0x1" };
      return { result: null };
    },
    simulateClosedPort: false,
    simulateContextInvalidated: false,
    simulateNoReply: false,

    async loadContentScript() {
      await import("@/content/contentScript");
    },

    async loadProvider() {
      await import("@/inpage/provider");
    },

    postFromPage(data, postOptions = {}) {
      const source = "source" in postOptions ? postOptions.source : fakeWindow;
      const eventOrigin = postOptions.origin ?? origin;
      deliveryQueue.push(() => {
        dispatch("message", { data, origin: eventOrigin, source });
      });
    },

    pushWorkerEvent(message) {
      for (const listener of [...(workerMessageListeners ?? [])]) {
        workerEventReturnValues.push(listener(message));
      }
    },

    responses() {
      return posts
        .filter((post) => post.data?.["namespace"] === RESPONSE_NAMESPACE)
        .map((post) => post.data);
    },

    events() {
      return posts
        .filter((post) => post.data?.["namespace"] === EVENT_NAMESPACE)
        .map((post) => post.data);
    },

    async flush() {
      for (let turn = 0; turn < 100; turn += 1) {
        const deliveries = deliveryQueue.splice(0);
        const callbacks = callbackQueue.splice(0);

        if (deliveries.length === 0 && callbacks.length === 0) {
          // Nothing queued. Give any promise chain still unwinding several
          // microtask turns to produce more work before declaring the bridge
          // settled -- a full round trip suspends more than once.
          for (let settle = 0; settle < 10; settle += 1) await Promise.resolve();
          if (deliveryQueue.length === 0 && callbackQueue.length === 0) return;
          continue;
        }

        for (const deliver of deliveries) deliver();
        for (const invoke of callbacks) invoke();
        await Promise.resolve();
      }
      throw new Error("bridge harness: message delivery never settled");
    },

    clearRecords() {
      posts.length = 0;
      forwarded.length = 0;
      workerEventReturnValues.length = 0;
    },

    cleanup() {
      listeners.clear();
      workerMessageListeners = undefined;
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "chrome");
    },
  };

  let workerMessageListeners: Set<(message: unknown) => unknown> | undefined;

  const fakeChrome = {
    runtime: {
      lastError: undefined as { message: string } | undefined,

      sendMessage(message: unknown, callback: (response: unknown) => void): void {
        if (harness.simulateContextInvalidated) {
          // What Chrome does when the extension has been reloaded, updated or
          // disabled while this page stayed open: a synchronous throw, not a
          // callback with an error.
          throw new Error("Extension context invalidated.");
        }

        const forwardedMessage = message as ForwardedMessage;
        forwarded.push(forwardedMessage);

        // Taken, not answered. The callback is simply never queued, which is
        // what an open approval window looks like from here.
        if (harness.simulateNoReply) return;

        callbackQueue.push(() => {
          if (harness.simulateClosedPort) {
            /**
             * `lastError` exists only for the duration of the callback in real
             * Chrome, and reading it is what marks it handled. Set and cleared
             * around the call so a bridge that checked it too late would fail
             * here rather than in production.
             */
            fakeChrome.runtime.lastError = {
              message: "The message port closed before a response was received.",
            };
            callback(undefined);
            fakeChrome.runtime.lastError = undefined;
            return;
          }
          callback(harness.respondWith(forwardedMessage));
        });
      },

      onMessage: {
        addListener(listener: (message: unknown) => unknown): void {
          workerMessageListeners ??= new Set();
          workerMessageListeners.add(listener);
        },
        removeListener(listener: (message: unknown) => unknown): void {
          workerMessageListeners?.delete(listener);
        },
      },
    },
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals["window"] = fakeWindow;
  globals["chrome"] = fakeChrome;

  // Both files are side-effecting singletons that register their listeners at
  // import time, so every test needs its own copy of the module graph rather
  // than the one the previous test already wired to a discarded window.
  vi.resetModules();

  return harness;
}
