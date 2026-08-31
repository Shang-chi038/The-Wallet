import {
  BRIDGE_NAMESPACE,
  isWalletRequest,
  PROVIDER_ERROR_CODES,
  type WalletResponse,
} from "@/core/messaging/protocol";
import { classifySender, UntrustedSenderError } from "@/core/messaging/senderTrust";
import type { MessageRouter } from "./messageRouter";

/**
 * chrome.runtime.onMessage wiring.
 *
 * The thinnest possible shell around `messageRouter`: classify the sender from
 * Chrome's own fields, hand the request to the router, send back what it
 * returns. Every decision worth testing happens on the other side of this file.
 *
 * ===========================================================================
 * `return true` IS LOAD-BEARING
 * ===========================================================================
 * An onMessage listener that returns a falsy value tells Chrome the response
 * channel can close IMMEDIATELY. Every handler here is async -- an unlock runs
 * a ~750ms KDF, a transaction waits on the user -- so a missing `return true`
 * closes the port before the answer exists and the caller's promise rejects
 * with "message port closed before a response was received".
 *
 * The inverse is just as bad and much easier to miss: returning `true` for a
 * message we are NOT going to answer holds the channel open forever, and the
 * sender hangs with no error. So the listener returns `true` only on the path
 * that is guaranteed to call `sendResponse`, and returns `false` for everything
 * it declines -- including our own provider-event broadcasts, which come back
 * through this same listener and must be ignored rather than answered.
 */

export interface MessageBridgeOptions {
  router: MessageRouter;
  /** Injected rather than read from chrome.* so this stays a pure wiring file. */
  extensionId?: string;
  extensionBaseUrl?: string;
}

export function registerMessageBridge({
  router,
  extensionId = chrome.runtime.id,
  extensionBaseUrl = chrome.runtime.getURL(""),
}: MessageBridgeOptions): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Not ours. Return false so other listeners -- and the sender -- are not
    // left waiting on a response this one will never send.
    if (!isWalletRequest(message)) return false;

    let classification;
    try {
      classification = classifySender({ sender, extensionId, extensionBaseUrl });
    } catch (error) {
      /**
       * We could not work out who sent this. Refuse, and do not guess.
       *
       * The tempting shortcut is to downgrade an unclassifiable sender to
       * "page" and let the allowlist sort it out. That inverts the failure
       * direction: a sender we do not understand becomes a sender we have
       * silently decided something about. Another extension messaging us
       * arrives with its own id and lands here, and treating it as anything but
       * refused is how a malicious extension reaches `wallet.revealMnemonic`.
       */
      sendResponse({
        namespace: BRIDGE_NAMESPACE,
        id: message.id,
        error: {
          code: PROVIDER_ERROR_CODES.unauthorized,
          message:
            error instanceof UntrustedSenderError
              ? error.message
              : "Message came from an unrecognised context.",
        },
      } satisfies WalletResponse);
      return false;
    }

    void router
      .route(message, classification)
      .then(sendResponse)
      .catch(() => {
        // `route` catches internally, so reaching here means the router itself
        // is broken. Still answer: an unanswered request is a hung dApp, and a
        // hung dApp is a worse failure than a reported error.
        sendResponse({
          namespace: BRIDGE_NAMESPACE,
          id: message.id,
          error: {
            code: PROVIDER_ERROR_CODES.internalError,
            message: "The wallet could not complete this request.",
          },
        } satisfies WalletResponse);
      });

    // Async work is in flight and sendResponse WILL be called on every path
    // above. This is the only branch allowed to keep the channel open.
    return true;
  });
}
