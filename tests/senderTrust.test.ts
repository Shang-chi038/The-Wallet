import { describe, expect, it } from "vitest";
import {
  classifySender,
  UntrustedSenderError,
  type MessageSenderFacts,
} from "@/core/messaging/senderTrust";
import { isMethodAllowedForSender } from "@/core/messaging/protocol";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const BASE_URL = `chrome-extension://${EXTENSION_ID}/`;

function classify(sender: MessageSenderFacts) {
  return classifySender({ sender, extensionId: EXTENSION_ID, extensionBaseUrl: BASE_URL });
}

describe("privileged senders", () => {
  it("classifies the popup as privileged", () => {
    expect(classify({ id: EXTENSION_ID, url: `${BASE_URL}src/ui/popup/index.html` })).toEqual({
      kind: "privileged",
      origin: BASE_URL,
    });
  });

  it("classifies the onboarding page as privileged", () => {
    expect(classify({ id: EXTENSION_ID, url: `${BASE_URL}src/ui/onboarding/index.html` }).kind).toBe(
      "privileged",
    );
  });
});

describe("page senders", () => {
  it("classifies a content script as a page", () => {
    expect(
      classify({
        id: EXTENSION_ID,
        tab: { id: 7 },
        url: "https://app.example.com/swap",
        origin: "https://app.example.com",
      }),
    ).toEqual({ kind: "page", origin: "https://app.example.com" });
  });

  it("derives the origin from the URL when Chrome omits the origin field", () => {
    expect(
      classify({ id: EXTENSION_ID, tab: { id: 7 }, url: "https://app.example.com/swap?x=1" }).origin,
    ).toBe("https://app.example.com");
  });

  /**
   * A sub-frame is not our UI, even at our own URL.
   *
   * Nothing of ours is web-accessible, so a website cannot embed one of our
   * pages today. This pins the guarantee to the classifier rather than to the
   * manifest staying the way it is: an extension page nested inside a tab
   * somebody else controls is a page.
   */
  it("treats a sub-frame at an extension URL as a page", () => {
    expect(
      classify({ id: EXTENSION_ID, tab: { id: 7 }, frameId: 3, url: `${BASE_URL}popup.html` }).kind,
    ).toBe("page");
  });

  /**
   * `new URL("about:blank").origin` is the STRING "null". Every opaque-origin
   * context reports the same value, so using it as a permission key would make
   * one grant cover all of them. It must collapse to undefined instead.
   */
  it.each(["about:blank", "data:text/html,<p>hi", "blob:https://x.example/abc", "file:///tmp/x"])(
    "yields no origin for %o rather than a shared key",
    (url) => {
      const result = classify({ id: EXTENSION_ID, tab: { id: 7 }, url });
      expect(result.kind).toBe("page");
      expect(result.origin).toBeUndefined();
    },
  );

  it("never yields the literal string 'null' as an origin", () => {
    for (const url of ["about:blank", "data:text/plain,x"]) {
      expect(classify({ id: EXTENSION_ID, tab: { id: 7 }, url }).origin).not.toBe("null");
    }
  });
});

/**
 * Onboarding is a full TAB, not the popup -- a popup closes on an outside click,
 * which during seed backup destroys the only copy of the recovery phrase.
 *
 * Chrome sets `sender.tab` for any frame in a tab, extension pages included, so
 * a classifier that treated a tab as proof of a website called the wallet's own
 * setup page a stranger. The symptom was `wallet.create` coming back as
 * "Unsupported method" -- the allowlist behaving perfectly, on a misclassified
 * sender -- and it made the wallet impossible to set up at all.
 */
describe("our own pages, in tabs", () => {
  it("classifies the onboarding tab as privileged", () => {
    expect(
      classify({
        id: EXTENSION_ID,
        tab: { id: 4 },
        frameId: 0,
        url: `${BASE_URL}src/ui/onboarding/index.html`,
      }),
    ).toEqual({ kind: "privileged", origin: BASE_URL });
  });

  it("classifies the tabless popup as privileged, as it always did", () => {
    expect(classify({ id: EXTENSION_ID, url: `${BASE_URL}src/ui/popup/index.html` })).toEqual({
      kind: "privileged",
      origin: BASE_URL,
    });
  });

  /**
   * The rule that must not loosen with it: a real content script still reports
   * the PAGE's url, so leading on the URL cannot promote one.
   */
  it("still classifies a content script in the top frame as a page", () => {
    expect(
      classify({
        id: EXTENSION_ID,
        tab: { id: 4 },
        frameId: 0,
        url: "https://app.example.com/swap",
        origin: "https://app.example.com",
      }),
    ).toEqual({ kind: "page", origin: "https://app.example.com" });
  });
});

describe("rejected senders", () => {
  /**
   * The attack this stops: another installed extension messaging us and being
   * mistaken for our own popup, which would put wallet.revealMnemonic within
   * its reach.
   */
  it("refuses a message from a different extension", () => {
    expect(() =>
      classify({ id: "someotherextensionidsomeotherextid", url: "chrome-extension://other/x.html" }),
    ).toThrow(UntrustedSenderError);
  });

  it("refuses a sender with no id at all", () => {
    expect(() => classify({ url: `${BASE_URL}popup.html` })).toThrow(UntrustedSenderError);
  });

  it("refuses a tabless sender that is not an extension page", () => {
    expect(() => classify({ id: EXTENSION_ID, url: "https://app.example.com" })).toThrow(
      UntrustedSenderError,
    );
  });

  it("refuses a tabless sender with no URL", () => {
    expect(() => classify({ id: EXTENSION_ID })).toThrow(UntrustedSenderError);
  });

  /** A URL merely containing our id, rather than starting with our origin. */
  it("refuses a lookalike extension URL", () => {
    expect(() =>
      classify({ id: EXTENSION_ID, url: `https://evil.example.com/${BASE_URL}popup.html` }),
    ).toThrow(UntrustedSenderError);
  });
});

/**
 * End-to-end on the boundary: classification feeding the allowlist. This is the
 * combination that actually protects the wallet, so it is asserted directly
 * rather than left implied by the two halves passing separately.
 */
describe("classification feeding the allowlist", () => {
  const pageSender: MessageSenderFacts = {
    id: EXTENSION_ID,
    tab: { id: 7 },
    url: "https://evil.example.com",
    origin: "https://evil.example.com",
  };
  const popupSender: MessageSenderFacts = {
    id: EXTENSION_ID,
    url: `${BASE_URL}src/ui/popup/index.html`,
  };

  it("a hostile site cannot reach wallet lifecycle", () => {
    const { kind } = classify(pageSender);
    for (const method of ["wallet.unlock", "wallet.revealMnemonic", "wallet.reset"]) {
      expect(isMethodAllowedForSender(method, kind)).toBe(false);
    }
  });

  it("a hostile site can still reach the ordinary provider surface", () => {
    const { kind } = classify(pageSender);
    expect(isMethodAllowedForSender("eth_requestAccounts", kind)).toBe(true);
    expect(isMethodAllowedForSender("personal_sign", kind)).toBe(true);
  });

  it("the popup can reach wallet lifecycle", () => {
    const { kind } = classify(popupSender);
    for (const method of ["wallet.unlock", "wallet.revealMnemonic", "wallet.reset"]) {
      expect(isMethodAllowedForSender(method, kind)).toBe(true);
    }
  });
});
