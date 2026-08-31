import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApprovalPresentation,
  ConnectApprovalPresentation,
} from "@/core/approval/approvalRequest";
import type { WalletStatusResult } from "@/core/messaging/walletApi";
import {
  describeOriginRisk,
  type OriginRisk,
} from "@/core/security/originRiskDescription";
import { walletClient, WalletRequestError } from "../shared/walletClient";
import { Callout, PasswordInput, PrimaryButton, SecondaryButton, Spinner } from "../components/forms";
import { ApprovalBody } from "./ApprovalBody";

/**
 * The approval window.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS FOR
 * ===========================================================================
 * It is the only place a website's request becomes the user's decision. Three
 * things have to be true of it, and they drive every choice below:
 *
 *   THE ORIGIN IS THE HEADLINE. Every prompt names the site asking, at the top,
 *   before anything else. A phishing site's whole strategy is getting a
 *   signature attributed to a site the user trusts, and the origin -- stamped
 *   by the content script, never supplied by the page -- is the only fact that
 *   defeats that.
 *
 *   NOTHING IS PRE-CONFIRMED. There is no default button, no Enter-to-approve,
 *   and Reject sits on the left where a reflexive click lands.
 *
 *   CLOSING IS DECLINING. The window's close button is a valid answer, and the
 *   service worker treats it as a rejection. That is why this component never
 *   needs to intercept unload: doing nothing is already safe.
 *
 * ===========================================================================
 * WHY THE QUEUE IS POLLED
 * ===========================================================================
 * A second request can arrive while the first is on screen. Polling is the
 * boring solution and the right one here: a push channel would need a port held
 * open to the service worker, and a held-open port keeps the worker alive --
 * which is exactly the thing "termination == wallet locked" depends on not
 * happening. Two seconds is imperceptible for a screen the user is reading.
 */

const QUEUE_POLL_INTERVAL_MS = 2_000;

type Phase = "loading" | "ready" | "empty";

export function ApprovalApp() {
  const [status, setStatus] = useState<WalletStatusResult | undefined>();
  const [approvals, setApprovals] = useState<ApprovalPresentation[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, pending] = await Promise.all([
        walletClient.getStatus(),
        walletClient.listApprovals(),
      ]);
      setStatus(nextStatus);
      setApprovals(pending.approvals);
      setPhase(pending.approvals.length === 0 ? "empty" : "ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet is not responding.");
      setPhase("empty");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), QUEUE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Oldest first. A newer request must never jump ahead of one the user is
  // already reading -- that is how a hostile site swaps the screen out from
  // under a click.
  const current = approvals[0];

  if (phase === "loading") {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Loading request" />
        </div>
      </Shell>
    );
  }

  if (!current) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="font-serif text-lg text-(--color-ink)">
            {error ? "Wallet unavailable" : "Nothing to approve"}
          </p>
          <p className="max-w-[260px] text-xs leading-relaxed text-(--color-slate)">
            {error ?? "This request was already answered. You can close this window."}
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <ApprovalPrompt
        key={current.approvalId}
        presentation={current}
        status={status}
        queueLength={approvals.length}
        onSettled={refresh}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-(--color-bg)">{children}</div>;
}

interface ApprovalPromptProps {
  presentation: ApprovalPresentation;
  status: WalletStatusResult | undefined;
  queueLength: number;
  onSettled: () => Promise<void>;
}

function ApprovalPrompt({ presentation, status, queueLength, onSettled }: ApprovalPromptProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<string[]>(() =>
    presentation.kind === "connect"
      ? (presentation as ConnectApprovalPresentation).defaultSelectedAddresses
      : [],
  );

  const accounts = status?.accounts ?? [];
  const isConnect = presentation.kind === "connect";

  // Once the wallet unlocks mid-approval, the account list arrives. Pre-tick the
  // selected account rather than leaving the user staring at an empty list with
  // a disabled button and nothing telling them what to do.
  useEffect(() => {
    if (!isConnect || selected.length > 0 || accounts.length === 0) return;
    const preferred = status?.selectedAddress ?? accounts[0]?.address;
    if (preferred) setSelected([preferred]);
  }, [isConnect, selected.length, accounts, status?.selectedAddress]);

  const settle = useCallback(
    async (approved: boolean) => {
      setBusy(true);
      setError(undefined);
      try {
        await walletClient.resolveApproval({
          approvalId: presentation.approvalId,
          approved,
          ...(isConnect ? { accounts: selected } : {}),
        });
        await onSettled();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not record your answer.");
      } finally {
        setBusy(false);
      }
    },
    [presentation.approvalId, isConnect, selected, onSettled],
  );

  const needsSetup = status?.hasVault === false;
  const needsUnlock = status?.hasVault === true && !status.isUnlocked;
  const canApprove = !needsSetup && !needsUnlock && (!isConnect || selected.length > 0);

  return (
    <div className="flex flex-1 flex-col">
      <OriginHeader presentation={presentation} queueLength={queueLength} />

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {needsSetup ? (
          <SetupRequired />
        ) : needsUnlock ? (
          <UnlockToContinue onUnlocked={onSettled} />
        ) : (
          <ApprovalBody
            presentation={presentation}
            accounts={accounts}
            selected={selected}
            onToggleAccount={(address) =>
              setSelected((current) =>
                current.includes(address)
                  ? current.filter((candidate) => candidate !== address)
                  : [...current, address],
              )
            }
          />
        )}
        {error ? (
          <div className="mt-3">
            <Callout tone="danger" title="Error">
              {error}
            </Callout>
          </div>
        ) : null}
      </div>

      {/* Reject on the LEFT, where a reflexive click lands, and never styled as
          the primary action. Approving a signature should take a deliberate
          movement across the button row. */}
      <footer className="flex gap-3 border-t border-(--color-line) bg-(--color-card) p-4">
        <div className="flex-1">
          <SecondaryButton onClick={() => void settle(false)} disabled={busy}>
            Reject
          </SecondaryButton>
        </div>
        <div className="flex-1">
          <PrimaryButton onClick={() => void settle(true)} disabled={busy || !canApprove}>
            {approveLabel(presentation.kind)}
          </PrimaryButton>
        </div>
      </footer>
    </div>
  );
}

function approveLabel(kind: ApprovalPresentation["kind"]): string {
  switch (kind) {
    case "connect":
      return "Connect";
    case "transaction":
      return "Confirm";
    case "switchChain":
      return "Switch";
    case "addChain":
      return "Add network";
    case "watchAsset":
      return "Add token";
    default:
      return "Sign";
  }
}

/**
 * The origin, first and unmissable.
 *
 * Rendered as plain text with `break-all` rather than truncated: a shortened
 * origin is exactly what a lookalike domain needs to pass unnoticed, so the
 * full string wraps instead of eliding.
 */
function OriginHeader({
  presentation,
  queueLength,
}: {
  presentation: ApprovalPresentation;
  queueLength: number;
}) {
  return (
    <header className="border-b border-(--color-line) bg-(--color-card) px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-(--color-slate)">
          {presentation.chain.name}
          {presentation.chain.isTestnet ? " - test network" : ""}
        </span>
        {queueLength > 1 ? (
          <span className="rounded-(--radius-pill) bg-(--color-muted) px-2 py-0.5 text-[10px] text-(--color-slate)">
            {queueLength - 1} more waiting
          </span>
        ) : null}
      </div>
      <p className="mt-1 font-mono text-sm break-all text-(--color-ink)">{presentation.origin}</p>
      <OriginWarning risk={presentation.originRisk} />
    </header>
  );
}

/**
 * What the wallet knows about this origin, directly under the origin itself.
 *
 * IN THE HEADER, not in the body. The body says what is being signed and
 * changes per request kind; this says who is asking, which is the question the
 * user is actually bad at and the one every drain depends on them getting
 * wrong. Putting it beside the address keeps the claim next to the evidence.
 *
 * It warns and nothing more -- the buttons below are untouched. A wallet that
 * blocked here would be wrong sometimes, and being wrong while refusing to let
 * someone move their own money is how a security feature gets switched off.
 */
function OriginWarning({ risk }: { risk: OriginRisk }) {
  const described = describeOriginRisk(risk);
  if (!described) return null;

  return (
    <div className="mt-2">
      <Callout tone={risk.level === "lookalike" ? "warning" : "danger"} title={described.title}>
        {described.body}
      </Callout>
    </div>
  );
}

function SetupRequired() {
  return (
    <div className="flex flex-col gap-3 pt-6">
      <p className="font-serif text-lg text-(--color-ink)">Set up your wallet first</p>
      <p className="text-xs leading-relaxed text-(--color-slate)">
        This site is asking to connect, but there is no wallet on this device yet. Create one, then
        try again from the site.
      </p>
      <PrimaryButton
        onClick={() => {
          void chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/onboarding/index.html") });
        }}
      >
        Create a wallet
      </PrimaryButton>
    </div>
  );
}

/**
 * Unlock, inline.
 *
 * The alternative -- refusing the request and telling the user to open the
 * popup -- loses the request, and the dApp shows an error for something the
 * user was willing to do. This window is a privileged extension page, so it can
 * unlock directly; the request stays queued while they type.
 */
function UnlockToContinue({ onUnlocked }: { onUnlocked: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    if (password === "" || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.unlock(password);
      setPassword("");
      await onUnlocked();
    } catch (caught) {
      setError(
        caught instanceof WalletRequestError && caught.reason === "incorrect_password"
          ? "That password is not correct."
          : "Could not unlock the wallet.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-6">
      <p className="font-serif text-lg text-(--color-ink)">Unlock to continue</p>
      <p className="text-xs leading-relaxed text-(--color-slate)">
        The request is waiting. Unlock the wallet to see what this site is asking for.
      </p>
      <PasswordInput
        value={password}
        onChange={setPassword}
        placeholder="Password"
        autoFocus
        onSubmit={() => void submit()}
      />
      {error ? (
        <span role="alert" className="text-xs text-(--color-danger)">
          {error}
        </span>
      ) : null}
      <PrimaryButton onClick={() => void submit()} disabled={busy || password === ""}>
        {busy ? "Unlocking..." : "Unlock"}
      </PrimaryButton>
    </div>
  );
}
