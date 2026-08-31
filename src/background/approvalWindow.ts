import type { ApprovalPresenter } from "./approvalService";

/**
 * chrome.windows adapter for the approval surface.
 *
 * ===========================================================================
 * WHY A WINDOW AND NOT THE TOOLBAR POPUP
 * ===========================================================================
 * The extension's action popup closes on ANY click outside it, including a
 * click the user did not mean to make. For an approval prompt that is
 * unacceptable twice over: a stray click silently cancels a transaction the
 * user was mid-way through reading, and -- worse -- a page that can provoke a
 * focus change can dismiss the prompt out from under them. A `type: "popup"`
 * window persists until it is deliberately closed.
 *
 * It also has a title bar showing the extension's own origin, which is the only
 * signal a user has that they are looking at the real wallet and not a
 * pixel-perfect HTML imitation drawn by the page requesting the signature.
 *
 * ===========================================================================
 * ONE WINDOW, NOT ONE PER REQUEST
 * ===========================================================================
 * A window per request lets a hostile page spawn a wall of them. A single
 * window that walks the queue is bounded by construction, and matches what
 * users already expect from other wallets.
 *
 * No permission is required for chrome.windows -- the `tabs` permission gates
 * reading sensitive tab properties, which we never do. See manifest.config.ts.
 */

/** Sized to the popup's own layout so the approval UI is not letterboxed. */
export const APPROVAL_WINDOW_WIDTH = 400;
export const APPROVAL_WINDOW_HEIGHT = 640;

export const APPROVAL_PAGE_PATH = "src/ui/approval/index.html";

export interface ApprovalWindowPresenterOptions {
  /**
   * Called when the window disappears WITHOUT us asking it to -- the user hit
   * the close button, or the browser tore it down. The queue must treat that as
   * a rejection: a closed window is an unanswered request, and an unanswered
   * request that never settles is the hang this whole subsystem exists to
   * prevent.
   */
  onDismissed: () => void;
}

export function createApprovalWindowPresenter({
  onDismissed,
}: ApprovalWindowPresenterOptions): ApprovalPresenter {
  let approvalWindowId: number | undefined;
  /**
   * Windows WE closed. Without this, `close()` would fire onRemoved, which
   * would call onDismissed, which would reject an approval that had just been
   * granted -- and if a new request arrived in the gap, it would be rejected
   * before the user ever saw it.
   */
  const deliberatelyClosed = new Set<number>();

  chrome.windows.onRemoved.addListener((windowId) => {
    if (deliberatelyClosed.delete(windowId)) return;
    if (windowId !== approvalWindowId) return;
    approvalWindowId = undefined;
    onDismissed();
  });

  return {
    async open() {
      if (approvalWindowId !== undefined) {
        try {
          await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
          return;
        } catch {
          // The window is gone but onRemoved has not run yet (or ran during a
          // worker restart). Fall through and create a fresh one.
          approvalWindowId = undefined;
        }
      }

      const created = await chrome.windows.create({
        url: chrome.runtime.getURL(APPROVAL_PAGE_PATH),
        type: "popup",
        width: APPROVAL_WINDOW_WIDTH,
        height: APPROVAL_WINDOW_HEIGHT,
        focused: true,
        ...(await computeTopRightPosition()),
      });
      approvalWindowId = created.id;
    },

    async close() {
      const windowId = approvalWindowId;
      if (windowId === undefined) return;
      approvalWindowId = undefined;
      deliberatelyClosed.add(windowId);
      try {
        await chrome.windows.remove(windowId);
      } catch {
        // Already gone. Nothing to do, and nothing to report: the queue is
        // empty either way.
        deliberatelyClosed.delete(windowId);
      }
    },
  };
}

/**
 * Places the window near the toolbar button rather than at the OS default.
 *
 * Cosmetic, but it is the difference between a prompt that reads as part of the
 * extension the user just interacted with and one that appears at a random
 * screen position looking like something a website spawned.
 */
async function computeTopRightPosition(): Promise<{ top: number; left: number } | object> {
  try {
    const focused = await chrome.windows.getLastFocused();
    if (focused.left === undefined || focused.top === undefined || focused.width === undefined) {
      return {};
    }
    return {
      top: Math.max(focused.top + 24, 0),
      left: Math.max(focused.left + focused.width - APPROVAL_WINDOW_WIDTH - 24, 0),
    };
  } catch {
    return {};
  }
}
