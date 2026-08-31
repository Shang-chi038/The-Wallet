import { useCallback, useEffect, useState } from "react";
import type {
  PrepareSendResult,
  StuckTransactionResult,
} from "@/core/messaging/walletApi";
import { Callout, PrimaryButton, SecondaryButton, Spinner } from "../components/forms";
import { walletClient, WalletRequestError } from "../shared/walletClient";

/**
 * "This has not gone through" -- and the two things that can be done about it.
 *
 * ===========================================================================
 * WHY IT IS A BANNER AND NOT A ROW ACTION
 * ===========================================================================
 * A stuck transaction is not a history entry the user might like to inspect;
 * it is an unfinished action blocking every later one from the same account.
 * Putting it above the list, with the buttons on it, matches what it is. Buried
 * behind a tap on a pending row it would be found by the people who already
 * know what a nonce is.
 *
 * ===========================================================================
 * REVIEW BEFORE BROADCAST, THE SAME AS A SEND
 * ===========================================================================
 * Both buttons cost real money -- a replacement pays a HIGHER fee than the
 * transaction it replaces, and a cancel pays a full fee to move nothing. So
 * neither one broadcasts on the first tap: `prepareReplacement` builds it,
 * this screen shows the fee, and `submitSend` sends the object that was shown.
 *
 * ===========================================================================
 * WHAT THE COPY HAS TO GET RIGHT
 * ===========================================================================
 * "Cancel" is the word users look for and it is not what the chain does. There
 * is no cancellation: the wallet sends an empty transaction claiming the same
 * nonce, and whichever is mined first wins. A user who believes the original
 * was withdrawn will not understand the fee they still pay, and will not
 * understand the small chance that the original lands anyway.
 */

type Stage =
  | { name: "list" }
  | { name: "review"; prepared: PrepareSendResult; mode: ReplacementMode; nonce: number }
  | { name: "sent"; mode: ReplacementMode };

type ReplacementMode = "speedUp" | "cancel";

export interface StuckTransactionNoticeProps {
  /** Called after a replacement is broadcast, so the activity list re-reads. */
  onReplaced: () => void;
}

export function StuckTransactionNotice({ onReplaced }: StuckTransactionNoticeProps) {
  const [transactions, setTransactions] = useState<StuckTransactionResult[]>([]);
  const [stage, setStage] = useState<Stage>({ name: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setTransactions((await walletClient.listStuckTransactions()).transactions);
    } catch {
      // Silence is right here. This is an extra affordance on a screen that
      // works without it, and an error banner about a feature the user did not
      // ask for would be noise on top of whatever else is already wrong.
      setTransactions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function beginReplacement(nonce: number, mode: ReplacementMode) {
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await walletClient.prepareReplacement({ nonce, mode });
      setStage({ name: "review", prepared, mode, nonce });
    } catch (caught) {
      setError(describeFailure(caught));
      // The list is the thing most likely to be out of date -- the usual cause
      // of a refusal here is that the transaction went through while the user
      // was reading. Re-reading it makes the screen agree with the message.
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function confirm(prepared: PrepareSendResult, mode: ReplacementMode) {
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.submitSend(prepared.preparationId);
      setStage({ name: "sent", mode });
      await load();
      onReplaced();
    } catch (caught) {
      setError(describeFailure(caught));
      setStage({ name: "list" });
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (transactions.length === 0 && stage.name !== "sent") return null;

  if (stage.name === "sent") {
    return (
      <div className="mb-4">
        <Callout tone="neutral" title={stage.mode === "cancel" ? "Cancel sent" : "Replacement sent"}>
          {stage.mode === "cancel"
            ? "An empty transaction is now competing for the same slot. Whichever is mined first wins, so the original can still go through."
            : "The same transaction is now on the network at a higher fee. It replaces the original rather than adding to it."}
        </Callout>
      </div>
    );
  }

  if (stage.name === "review") {
    const { presentation } = stage.prepared;
    return (
      <div className="mb-4 flex flex-col gap-3 rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3">
        <p className="font-serif text-base text-(--color-ink)">
          {stage.mode === "cancel" ? "Cancel this transaction?" : "Send it again, faster?"}
        </p>

        <p className="text-xs leading-relaxed text-(--color-slate)">
          {stage.mode === "cancel"
            ? "This does not withdraw the original -- nothing can. It sends an empty transaction claiming the same slot, and whichever is mined first wins. You pay this fee either way."
            : "This is the same transaction at a higher fee, claiming the same slot. It replaces the original rather than adding a second one."}
        </p>

        <Row label="Estimated fee" value={presentation.expectedFeeLabel} />
        <Row label="Maximum fee" value={presentation.maximumFeeLabel} />
        <Row label="Slot (nonce)" value={String(presentation.nonce)} />

        {error ? <Callout tone="danger">{error}</Callout> : null}

        <div className="flex gap-2">
          <SecondaryButton onClick={() => setStage({ name: "list" })} disabled={busy}>
            Back
          </SecondaryButton>
          <PrimaryButton onClick={() => void confirm(stage.prepared, stage.mode)} disabled={busy}>
            {busy ? "Sending..." : stage.mode === "cancel" ? "Send cancel" : "Send replacement"}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3">
      <p className="font-serif text-base text-(--color-ink)">
        {transactions.length === 1
          ? "A transaction has not gone through"
          : `${transactions.length} transactions have not gone through`}
      </p>
      <p className="text-xs leading-relaxed text-(--color-slate)">
        The network has not picked {transactions.length === 1 ? "it" : "them"} up. Usually the fee
        was below what the network was charging at the time. Waiting longer is free; the options
        below are not.
      </p>
      {/* The same transaction is also a pending row in the list below, for a
          while. Two views of one thing looks like two transactions to someone
          already worried that they sent twice -- so the wallet says which it
          is, rather than leaving them to work it out. */}
      <p className="text-[11px] leading-relaxed text-(--color-faint)">
        {transactions.length === 1 ? "It is" : "They are"} also listed below as pending. That is the
        same transaction, not another one.
      </p>

      {transactions.map((transaction) => (
        <div
          key={transaction.nonce}
          className="flex flex-col gap-2 border-t border-(--color-line) pt-3"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="numeric text-sm text-(--color-ink)">{transaction.description}</span>
            <span className="text-[10px] text-(--color-faint)">slot {transaction.nonce}</span>
          </div>

          {transaction.isBlocked ? (
            /* Nonces are sequential, so this one cannot be mined until the
               older one is. Offering to pay more for it would take the money
               and change nothing the user can see. */
            <p className="text-[11px] leading-relaxed text-(--color-slate)">
              Waiting on the older transaction above. Nothing can be done with this one until that
              one clears -- paying more for it would not move it any sooner.
            </p>
          ) : (
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => void beginReplacement(transaction.nonce, "cancel")}
                disabled={busy}
              >
                Cancel it
              </SecondaryButton>
              <PrimaryButton
                onClick={() => void beginReplacement(transaction.nonce, "speedUp")}
                disabled={busy}
              >
                Speed up
              </PrimaryButton>
            </div>
          )}
        </div>
      ))}

      {busy ? <Spinner label="Preparing" /> : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-(--color-slate)">{label}</span>
      <span className="numeric text-xs text-(--color-ink)">{value}</span>
    </div>
  );
}

/**
 * Engine failures, in words. Branches on `reason`, never on message text --
 * the same rule the settings screen follows.
 */
function describeFailure(caught: unknown): string {
  if (caught instanceof WalletRequestError) {
    if (caught.reason === "vault_locked") {
      return "The wallet locked itself. Unlock it and try again.";
    }
    if (caught.message !== "") return caught.message;
  }
  return "That could not be prepared. The transaction may have gone through already.";
}
