import type { SenderKind } from "./protocol";

/**
 * Classifying who sent a message.
 *
 * `isMethodAllowedForSender` is the authorisation decision; THIS is the input
 * it depends on. Get this wrong and the allowlist protects nothing, so the
 * rules are spelled out rather than inferred at the call site.
 *
 * The shape below mirrors the fields of `chrome.runtime.MessageSender` we rely
 * on, so this stays pure and testable. The real sender object is passed in
 * directly by the router.
 */
export interface MessageSenderFacts {
  /**
   * Set by Chrome whenever the sending frame lives in a TAB.
   *
   * Content scripts always have one — and so does any extension page opened
   * with `chrome.tabs.create`, which is how onboarding runs. Its presence is
   * therefore NOT sufficient to conclude "web page"; see `classifySender`.
   */
  tab?: { id?: number | undefined } | undefined;
  /**
   * 0 for a top-level frame, positive for a child frame. Chrome only sets it
   * alongside `tab`, and populates it itself, so a frame cannot misreport its
   * own nesting.
   */
  frameId?: number | undefined;
  /** The extension that sent it. Chrome populates this; a page cannot forge it. */
  id?: string | undefined;
  /** Full URL of the sending context. */
  url?: string | undefined;
  /** Present on content-script messages from Chrome 80+. */
  origin?: string | undefined;
}

export interface ClassifySenderParams {
  sender: MessageSenderFacts;
  /** Our own `chrome.runtime.id`. */
  extensionId: string;
  /** Our own base URL, i.e. `chrome-extension://<id>/`. */
  extensionBaseUrl: string;
}

export interface SenderClassification {
  kind: SenderKind;
  /** The true origin, taken from Chrome's own fields — never the message body. */
  origin: string | undefined;
}

export class UntrustedSenderError extends Error {
  readonly code = "untrusted_sender";
  constructor(reason: string) {
    super(reason);
    this.name = "UntrustedSenderError";
  }
}

/**
 * Decides whether a message came from our own UI or from a web page.
 *
 * THE RULES, IN ORDER, AND WHY EACH ONE EXISTS
 *
 * 1. `sender.id` must be our own extension id. Chrome populates this itself.
 *    Another installed extension messaging us arrives with ITS id, and must
 *    never be treated as our popup — a malicious extension calling
 *    `wallet.revealMnemonic` would otherwise walk straight through.
 *
 * 2. A TOP-LEVEL frame whose URL is under our own extension origin is
 *    PRIVILEGED, whether or not it sits in a tab.
 *
 *    THE TAB IS NOT THE DISCRIMINATOR, and assuming it was is what broke
 *    onboarding. Chrome sets `sender.tab` for any frame in a tab, and
 *    onboarding is deliberately a full tab rather than the popup — a popup
 *    closes on an outside click, which during seed backup destroys the only
 *    copy of the phrase. So the wallet classified its own setup page as a
 *    website and refused `wallet.create`: correct behaviour by the allowlist,
 *    for a sender that was never a website.
 *
 *    Leading on the URL is safe because CHROME populates it, exactly as it
 *    populates `sender.tab`. A page cannot report a `chrome-extension://` URL
 *    it is not actually running at.
 *
 * 3. The frame check is what the old tab-first ordering was really reaching
 *    for. A website cannot navigate its top frame to one of our pages — no
 *    HTML of ours is in `web_accessible_resources`, deliberately — but if that
 *    ever changed, one of our pages embedded as a SUB-frame of a hostile page
 *    would report an extension URL from inside a tab the attacker controls.
 *    Requiring frame 0 closes that now, rather than depending on a manifest
 *    staying the way it is.
 *
 * 4. Anything still holding a tab is a content script, so it is PAGE.
 *
 * Anything that does not fit is refused rather than downgraded to PAGE. A
 * sender we cannot classify is a sender we do not understand, and guessing is
 * how the interesting bugs happen.
 */
export function classifySender({
  sender,
  extensionId,
  extensionBaseUrl,
}: ClassifySenderParams): SenderClassification {
  if (!sender.id || sender.id !== extensionId) {
    throw new UntrustedSenderError(
      "Message did not originate from this extension.",
    );
  }

  // `frameId` is set only alongside `tab`, so undefined means "not in a tab"
  // (the popup, the approval window) and 0 means the top frame of one (the
  // onboarding tab). Both are ours; a sub-frame is not.
  const isTopLevelFrame = sender.frameId === undefined || sender.frameId === 0;
  if (isTopLevelFrame && sender.url && sender.url.startsWith(extensionBaseUrl)) {
    return { kind: "privileged", origin: extensionBaseUrl };
  }

  if (sender.tab !== undefined) {
    // A content script, or one of our pages somewhere it has no business being.
    // The origin comes from Chrome's own field, falling back to parsing the URL
    // it reports — never from anything in the payload.
    return { kind: "page", origin: sender.origin ?? originFromUrl(sender.url) };
  }

  throw new UntrustedSenderError(
    "Message came from an unrecognised context with no tab and no extension URL.",
  );
}

/**
 * Extracts a usable origin, or undefined.
 *
 * TWO TRAPS, both of which would create a shared permission key:
 *
 * 1. `new URL("about:blank").origin` returns the STRING "null", not undefined.
 *    Every opaque-origin context — about:blank, sandboxed iframes, data: URLs —
 *    reports the same "null". Used as a permission key, one grant would cover
 *    all of them, on every site.
 *
 * 2. Non-web schemes (file:, blob:, chrome:) are not origins we are willing to
 *    grant to at all.
 *
 * Both collapse to undefined, which the router treats as "no origin" and
 * refuses, rather than as a key.
 */
function originFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.origin === "null" ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}
