import { randomBytes } from "@/core/crypto/randomSource";
import { encodeHex } from "@/core/crypto/encoding";
import type {
  ApprovalDecision,
  ApprovalPresentation,
  ApprovalRejectionReason,
  DraftApprovalPresentation,
} from "@/core/approval/approvalRequest";

/**
 * The pending-approval queue.
 *
 * ===========================================================================
 * THE ONE INVARIANT: EVERY REQUEST SETTLES
 * ===========================================================================
 * A dApp that calls `eth_requestAccounts` gets a promise. If that promise never
 * settles, the dApp's UI hangs forever with a spinner and no error -- the user
 * cannot tell whether they are waiting on the wallet, the network or a bug, and
 * the site has no way to recover. This is the single most common wallet
 * integration failure, and it is entirely avoidable.
 *
 * So every path out of here settles the promise:
 *
 *   user approves        -> resolve, approved
 *   user declines        -> resolve, user_rejected
 *   window closed        -> resolve, window_closed      (chrome.windows.onRemoved)
 *   timeout elapses      -> resolve, timed_out
 *   wallet locks         -> resolve, wallet_locked
 *   worker torn down     -> settled at the CONTENT SCRIPT, see below
 *
 * The last one is the case this file cannot handle from inside: if Chrome kills
 * the service worker, this map dies with it and no code here runs. That is why
 * the content script treats a closed message channel as a rejection too -- the
 * guarantee is enforced at both ends, because only one of them survives worker
 * teardown.
 *
 * Rejections are never `throw`n across the boundary as-is; the router maps them
 * all to EIP-1193 code 4001, which is how a dApp distinguishes "user said no"
 * from "something broke" and shows a cancel state instead of an error dialog.
 *
 * ===========================================================================
 * SPAM CONTAINMENT
 * ===========================================================================
 * A hostile page can call `eth_requestAccounts` in a loop. Without a cap that
 * is an unbounded queue of approval prompts the user must dismiss one by one --
 * a denial of service against their own browser, and a way to bury a real
 * request under decoys. Per-origin and global caps reject the excess
 * immediately rather than queueing it.
 */

/**
 * How long a request may wait for an answer.
 *
 * Five minutes is a compromise, and worth naming as one. Longer respects a user
 * who walked away mid-approval; shorter is honest about MV3, where the service
 * worker is not guaranteed to survive that long anyway. A request that expires
 * settles as a rejection, so the dApp always finds out.
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export const MAX_PENDING_APPROVALS_PER_ORIGIN = 3;
export const MAX_PENDING_APPROVALS_TOTAL = 12;

export class ApprovalQueueFullError extends Error {
  readonly code = "approval_queue_full";
  constructor(reason: string) {
    super(reason);
    this.name = "ApprovalQueueFullError";
  }
}

/**
 * The approval surface. Implemented by `approvalWindow.ts` against
 * chrome.windows; faked in tests, which is why the service takes it injected.
 */
export interface ApprovalPresenter {
  /** Show (or focus) the approval surface. Must be idempotent. */
  open(): Promise<void>;
  /** Close it. Called when the queue empties. Must be idempotent. */
  close(): Promise<void>;
}

/**
 * A queued request. `payload` is the resolved, ready-to-execute object and NEVER
 * leaves the service worker -- see the header of core/approval/approvalRequest.ts
 * for why the thing shown and the thing signed must be one object.
 */
interface PendingApproval {
  presentation: ApprovalPresentation;
  payload: unknown;
  settle: (decision: ApprovalDecision) => void;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface RequestApprovalParams<TPayload> {
  /** Everything but `approvalId`, which the service assigns. */
  presentation: DraftApprovalPresentation;
  payload: TPayload;
}

export interface ApprovalServiceOptions {
  presenter: ApprovalPresenter;
  timeoutMs?: number;
  now?: () => number;
  /** Notified whenever the queue length changes, for the toolbar badge. */
  onQueueChanged?: (pendingCount: number) => void;
}

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly presenter: ApprovalPresenter;
  private readonly timeoutMs: number;
  private readonly onQueueChanged: (pendingCount: number) => void;

  constructor({
    presenter,
    timeoutMs = APPROVAL_TIMEOUT_MS,
    onQueueChanged = () => {},
  }: ApprovalServiceOptions) {
    this.presenter = presenter;
    this.timeoutMs = timeoutMs;
    this.onQueueChanged = onQueueChanged;
  }

  /**
   * Queues a request and resolves when it is answered, one way or another.
   *
   * Note the return type: this NEVER rejects. A declined request is a
   * successful outcome of asking, and modelling it as a thrown error invites
   * callers to lump it in with genuine failures in a catch block -- which is
   * how "user cancelled" ends up reported to the user as "transaction failed".
   */
  async requestApproval<TPayload>({
    presentation,
    payload,
  }: RequestApprovalParams<TPayload>): Promise<ApprovalDecision> {
    this.assertCapacity(presentation.origin);

    const approvalId = `apr_${encodeHex(randomBytes(12))}`;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const expiryTimer = setTimeout(() => {
        this.settle(approvalId, { approved: false, reason: "timed_out" });
      }, this.timeoutMs);

      this.pending.set(approvalId, {
        presentation: { ...presentation, approvalId } as ApprovalPresentation,
        payload,
        settle: resolve,
        expiryTimer,
      });
    });

    this.onQueueChanged(this.pending.size);
    // Failing to open the window must not strand the request: settle it rather
    // than leave a queue entry nobody can ever see or answer.
    try {
      await this.presenter.open();
    } catch (error) {
      this.settle(approvalId, { approved: false, reason: "shutdown" });
      throw error;
    }
    return decision;
  }

  /** Presentations only. The payload never crosses to the approval window. */
  listPending(): ApprovalPresentation[] {
    return [...this.pending.values()]
      .map((entry) => entry.presentation)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  /** The payload for a queued approval, for the router to execute on approval. */
  getPayload<TPayload>(approvalId: string): TPayload | undefined {
    return this.pending.get(approvalId)?.payload as TPayload | undefined;
  }

  /** Called by the router when the user answers in the approval window. */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    return this.settle(approvalId, decision);
  }

  /**
   * Settles everything outstanding.
   *
   * Called on lock, on reset, and when the approval window closes. Locking the
   * wallet while a signature request is queued must not leave that request
   * hanging until it times out -- the user's intent was unambiguous.
   */
  rejectAll(reason: ApprovalRejectionReason): void {
    for (const approvalId of [...this.pending.keys()]) {
      this.settle(approvalId, { approved: false, reason });
    }
  }

  private settle(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;

    clearTimeout(entry.expiryTimer);
    this.pending.delete(approvalId);
    entry.settle(decision);

    this.onQueueChanged(this.pending.size);
    if (this.pending.size === 0) {
      // Deliberately not awaited: the dApp's answer must not wait on a window
      // animation, and a close failure cannot un-answer the request.
      void this.presenter.close();
    }
    return true;
  }

  private assertCapacity(origin: string): void {
    if (this.pending.size >= MAX_PENDING_APPROVALS_TOTAL) {
      throw new ApprovalQueueFullError(
        "Too many wallet requests are already waiting for an answer.",
      );
    }
    const fromOrigin = [...this.pending.values()].filter(
      (entry) => entry.presentation.origin === origin,
    ).length;
    if (fromOrigin >= MAX_PENDING_APPROVALS_PER_ORIGIN) {
      throw new ApprovalQueueFullError(
        "This site already has the maximum number of requests waiting for an answer.",
      );
    }
  }
}
