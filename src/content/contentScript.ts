/**
 * Content script -- the isolated-world half of the page bridge.
 *
 * ===========================================================================
 * TRUST BOUNDARY
 * ===========================================================================
 * This file runs in the extension's isolated world but talks to a hostile
 * party: the page. Every message arriving from the page is attacker-controlled
 * input. It is never authenticated, never trusted, and never carries authority.
 *
 * It holds NO secrets and makes NO decisions. It validates message shape,
 * stamps the true origin -- which the page cannot forge as seen from here --
 * and forwards to the service worker, where every authorisation decision is
 * actually made.
 *
 * ===========================================================================
 * THIS FILE OWNS HALF OF THE "NO REQUEST EVER HANGS" GUARANTEE
 * ===========================================================================
 * The approval queue in the service worker settles every request it knows
 * about. But it cannot settle a request when Chrome has already killed the
 * worker -- the queue died with it, and no code there will ever run again.
 *
 * That case surfaces HERE, as a closed message port, and it is the reason the
 * `sendMessage` callback checks `chrome.runtime.lastError` and answers the page
 * itself. Both ends enforce the guarantee because only one of them survives
 * worker teardown, and a dApp left waiting forever on a promise is the worst
 * failure mode this bridge has: no error, no timeout, just a spinner the user
 * cannot explain.
 */

const BRIDGE_NAMESPACE = "wallet:inpage";
const RESPONSE_NAMESPACE = `${BRIDGE_NAMESPACE}:response`;
const EVENT_NAMESPACE = `${BRIDGE_NAMESPACE}:event`;

/** EIP-1193 codes. Kept literal so this file imports nothing at document_start. */
const USER_REJECTED = 4001;
const DISCONNECTED = 4900;

interface BridgeMessage {
  namespace: typeof BRIDGE_NAMESPACE;
  id: string;
  method: string;
  params?: unknown;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BridgeMessage>;
  return (
    candidate.namespace === BRIDGE_NAMESPACE &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.method === "string" &&
    candidate.method.length > 0
  );
}

function postToPage(payload: object): void {
  // Targeted at our own origin rather than "*". A wildcard target would deliver
  // responses -- including account addresses -- to whatever happens to be
  // listening, and this window can be embedded.
  window.postMessage(payload, window.location.origin);
}

function respond(id: string, body: { result: unknown } | { error: { code: number; message: string } }): void {
  postToPage({ namespace: RESPONSE_NAMESPACE, id, ...body });
}

window.addEventListener("message", (event: MessageEvent) => {
  // Reject anything not posted by this exact window. Without this, an embedded
  // iframe could post messages we would forward as if they came from the
  // top-level origin the user is actually looking at -- and the approval prompt
  // would name that top-level origin while an ad frame did the asking.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!isBridgeMessage(event.data)) return;

  const { id, method, params } = event.data;

  try {
    chrome.runtime.sendMessage(
      {
        namespace: BRIDGE_NAMESPACE,
        id,
        method,
        params,
        // The origin is attached HERE, by the extension, from the real
        // document. A page-supplied origin field would be trivially spoofable
        // and must never be honoured: it is what every approval prompt and
        // every per-origin grant is anchored to.
        origin: window.location.origin,
      },
      (response: unknown) => {
        if (chrome.runtime.lastError || response === undefined) {
          /**
           * The port closed without an answer. In practice this means the
           * service worker was terminated while the request was in flight --
           * most often while an approval window sat open.
           *
           * Reported as 4001 rather than a generic failure: from the dApp's
           * point of view nothing was authorised, and 4001 is the code that
           * makes it show a cancelled state instead of an error dialog the user
           * has to dismiss before retrying.
           */
          respond(id, {
            error: {
              code: USER_REJECTED,
              message: "The wallet closed this request before it was answered.",
            },
          });
          return;
        }

        const message = response as { result?: unknown; error?: { code: number; message: string } };
        if (message.error) respond(id, { error: message.error });
        else respond(id, { result: message.result });
      },
    );
  } catch {
    /**
     * `sendMessage` throws synchronously when the extension context is gone --
     * the user updated, reloaded or disabled the wallet while this page was
     * open. The content script is now an orphan that can never reach the
     * worker again, so 4900 (disconnected) is the honest answer, and it tells
     * the dApp to stop retrying rather than to prompt again.
     */
    respond(id, {
      error: { code: DISCONNECTED, message: "The wallet extension was reloaded. Refresh the page." },
    });
  }
});

/**
 * Provider events pushed from the service worker.
 *
 * Relayed verbatim: the payload was computed per origin by the broadcaster,
 * which already decided this page may see it. This half only changes transport
 * -- extension messaging in, postMessage out -- and adds nothing.
 */
chrome.runtime.onMessage.addListener((message: unknown) => {
  const candidate = message as { namespace?: string; event?: string; params?: unknown };
  if (candidate?.namespace !== EVENT_NAMESPACE || typeof candidate.event !== "string") return;
  postToPage({
    namespace: EVENT_NAMESPACE,
    event: candidate.event,
    params: candidate.params,
  });
  // No response is sent and none is expected, so the listener returns
  // undefined: returning true here would hold the sender's port open forever.
});

/**
 * Marks this file a module rather than a global script, matching `provider.ts`.
 *
 * Nothing here is exported and nothing should be -- this file is an entry
 * point, not a library. The declaration exists because without it TypeScript
 * treats the file as an ambient script, which puts every constant above into
 * the global scope and makes the file impossible to `import` from a test. The
 * bridge is the boundary a hostile page talks to, so it being reachable by the
 * hermetic suite matters more than the line is ugly. See `tests/messageBridge.test.ts`.
 */
export {};
