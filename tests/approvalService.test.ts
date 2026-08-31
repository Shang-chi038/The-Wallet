import { describe, expect, it, vi } from "vitest";
import { NO_ORIGIN_RISK } from "@/core/security/originRisk";
import {
  ApprovalQueueFullError,
  ApprovalService,
  MAX_PENDING_APPROVALS_PER_ORIGIN,
  MAX_PENDING_APPROVALS_TOTAL,
  type ApprovalPresenter,
} from "@/background/approvalService";
import type { DraftApprovalPresentation } from "@/core/approval/approvalRequest";

/**
 * The invariant under test is one sentence long: EVERY REQUEST SETTLES.
 *
 * A dApp whose promise never resolves shows a spinner forever, with no error
 * and no way to recover. Each test below is one of the ways that could happen.
 */

function createPresenter(): ApprovalPresenter & { openCount: number; closeCount: number } {
  return {
    openCount: 0,
    closeCount: 0,
    async open() {
      this.openCount += 1;
    },
    async close() {
      this.closeCount += 1;
    },
  };
}

function draft(origin = "https://app.example"): DraftApprovalPresentation {
  return {
    kind: "connect",
    origin,
    originRisk: NO_ORIGIN_RISK,
    createdAt: 0,
    chain: {
      chainId: 1,
      name: "Ethereum",
      shortName: "ETH",
      isTestnet: false,
      nativeCurrencySymbol: "ETH",
      nativeCurrencyDecimals: 18,
      blockExplorerUrl: "",
    },
    defaultSelectedAddresses: [],
    isReconnect: false,
  };
}

describe("every request settles", () => {
  it("resolves as approved when the user says yes", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    const pending = service.requestApproval({ presentation: draft(), payload: undefined });

    const queued = service.listPending()[0];
    expect(queued).toBeDefined();
    service.resolve(queued!.approvalId, { approved: true, accounts: ["0xabc"] });

    await expect(pending).resolves.toEqual({ approved: true, accounts: ["0xabc"] });
  });

  it("resolves as a rejection when the user says no", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    const pending = service.requestApproval({ presentation: draft(), payload: undefined });
    service.resolve(service.listPending()[0]!.approvalId, {
      approved: false,
      reason: "user_rejected",
    });
    await expect(pending).resolves.toEqual({ approved: false, reason: "user_rejected" });
  });

  /** The window's close button is a valid answer, and it means no. */
  it("resolves as a rejection when the approval window is closed", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    const pending = service.requestApproval({ presentation: draft(), payload: undefined });
    service.rejectAll("window_closed");
    await expect(pending).resolves.toEqual({ approved: false, reason: "window_closed" });
  });

  it("resolves as a rejection when the wallet locks", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    const pending = service.requestApproval({ presentation: draft(), payload: undefined });
    service.rejectAll("wallet_locked");
    await expect(pending).resolves.toEqual({ approved: false, reason: "wallet_locked" });
  });

  it("resolves as a rejection when the request expires", async () => {
    vi.useFakeTimers();
    try {
      const service = new ApprovalService({ presenter: createPresenter(), timeoutMs: 1_000 });
      const pending = service.requestApproval({ presentation: draft(), payload: undefined });
      vi.advanceTimersByTime(1_001);
      await expect(pending).resolves.toEqual({ approved: false, reason: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A queue entry nobody can see is a queue entry nobody can answer. If the
   * window fails to open, the request must not be left in it.
   */
  it("settles the request when the approval window cannot be opened", async () => {
    const service = new ApprovalService({
      presenter: {
        async open() {
          throw new Error("no window manager");
        },
        async close() {},
      },
    });
    await expect(
      service.requestApproval({ presentation: draft(), payload: undefined }),
    ).rejects.toThrow("no window manager");
    expect(service.getPendingCount()).toBe(0);
  });
});

describe("spam containment", () => {
  it("caps how many requests one origin may queue", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    for (let index = 0; index < MAX_PENDING_APPROVALS_PER_ORIGIN; index += 1) {
      void service.requestApproval({ presentation: draft(), payload: undefined });
      await Promise.resolve();
    }
    await expect(
      service.requestApproval({ presentation: draft(), payload: undefined }),
    ).rejects.toBeInstanceOf(ApprovalQueueFullError);
  });

  /**
   * A per-origin cap alone is not enough: a hostile page can host many
   * subdomains, and each is a separate origin.
   */
  it("caps the queue globally across origins", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    for (let index = 0; index < MAX_PENDING_APPROVALS_TOTAL; index += 1) {
      void service.requestApproval({
        presentation: draft(`https://site${index}.example`),
        payload: undefined,
      });
      await Promise.resolve();
    }
    await expect(
      service.requestApproval({ presentation: draft("https://one-more.example"), payload: undefined }),
    ).rejects.toBeInstanceOf(ApprovalQueueFullError);
  });
});

describe("payload isolation", () => {
  /**
   * The thing shown to the user and the thing signed must be one object, and
   * the object must never cross to the UI. `listPending` is what the approval
   * window receives, so anything visible there is visible to that page.
   */
  it("never exposes the payload through listPending", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    void service.requestApproval({
      presentation: draft(),
      payload: { secretTransaction: "do not leak" },
    });
    await Promise.resolve();

    const serialised = JSON.stringify(service.listPending());
    expect(serialised).not.toContain("do not leak");
  });

  it("hands the payload back to the router by id", async () => {
    const service = new ApprovalService({ presenter: createPresenter() });
    void service.requestApproval({ presentation: draft(), payload: { amount: 42 } });
    await Promise.resolve();

    const queued = service.listPending()[0]!;
    expect(service.getPayload<{ amount: number }>(queued.approvalId)).toEqual({ amount: 42 });
  });
});

describe("window lifecycle", () => {
  it("opens once per request and closes when the queue empties", async () => {
    const presenter = createPresenter();
    const service = new ApprovalService({ presenter });

    void service.requestApproval({ presentation: draft(), payload: undefined });
    await Promise.resolve();
    void service.requestApproval({ presentation: draft(), payload: undefined });
    await Promise.resolve();
    expect(presenter.openCount).toBe(2);
    expect(presenter.closeCount).toBe(0);

    for (const queued of service.listPending()) {
      service.resolve(queued.approvalId, { approved: false, reason: "user_rejected" });
    }
    expect(presenter.closeCount).toBe(1);
  });

  it("reports the queue length so the toolbar badge can track it", async () => {
    const sizes: number[] = [];
    const service = new ApprovalService({
      presenter: createPresenter(),
      onQueueChanged: (count) => sizes.push(count),
    });
    void service.requestApproval({ presentation: draft(), payload: undefined });
    await Promise.resolve();
    service.rejectAll("user_rejected");
    expect(sizes).toEqual([1, 0]);
  });
});
