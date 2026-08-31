import { motion } from "framer-motion";
import type { ActivityResult, BitcoinActivityResult } from "@/core/messaging/walletApi";
import {
  selectActivityPresentation,
  type DegradedActivity,
  type UnifiedActivityRow,
} from "@/core/activity/activityPresentation";
import { AssetAvatar, SectionLabel } from "../components";
import { Callout, Spinner } from "../components/forms";
import { StuckTransactionNotice } from "./StuckTransactionNotice";

/**
 * Activity.
 *
 * ===========================================================================
 * AN EMPTY LIST IS AMBIGUOUS, SO IT IS NEVER SHOWN BARE
 * ===========================================================================
 * "You have no transactions" and "this endpoint has no index behind it" produce
 * the same empty array. Telling a user with a busy account that they have never
 * transacted is the worse of the two errors, and it is the one a wallet makes
 * by default. `ActivityResult.status` is what lets this screen say the right
 * thing instead of guessing.
 *
 * That decision is NOT made here. It lives in `selectActivityPresentation`,
 * because a ternary in JSX is unreachable from a suite with no DOM -- and this
 * exact rule was already lost once in a diff that merged Bitcoin into the list.
 * This component renders the answer; it does not compute it.
 *
 * ===========================================================================
 * PENDING ROWS COME FROM US, NOT THE INDEXER
 * ===========================================================================
 * An index cannot see a transaction until it is mined. A send that leaves no
 * trace for twelve seconds looks like a send that failed, and the natural
 * response to that is to send again. So the wallet's own record of what it
 * just broadcast appears immediately, marked pending, and is replaced by the
 * indexer's row once the two agree.
 */

export interface ActivityScreenProps {
  activity: ActivityResult | undefined;
  bitcoinActivity?: BitcoinActivityResult | undefined;
  isRefreshing: boolean;
  /** A replacement was broadcast: the list and the balances both moved. */
  onReplaced?: (() => void) | undefined;
}

export function ActivityScreen({
  activity,
  bitcoinActivity,
  isRefreshing,
  onReplaced,
}: ActivityScreenProps) {
  const presentation = selectActivityPresentation({
    activity,
    bitcoinActivity: bitcoinActivity ?? undefined,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col px-4 pt-6"
    >
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>Activity</SectionLabel>
        {isRefreshing ? <Spinner label="" /> : null}
      </div>

      {/* Above the list, because a stuck transaction is not history -- it is an
          unfinished action holding up every later one from this account. */}
      <StuckTransactionNotice onReplaced={onReplaced ?? (() => {})} />

      {presentation.kind === "loading" ? (
        <Centered title="Loading" body="Fetching your recent transactions." />
      ) : presentation.kind === "rows" ? (
        <>
          <div className="flex flex-col">
            {presentation.rows.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </div>
          {presentation.degraded ? (
            <div className="mt-3">
              <StatusNote degraded={presentation.degraded} />
            </div>
          ) : null}
        </>
      ) : presentation.kind === "degraded" ? (
        <div className="pt-4">
          <StatusNote degraded={presentation.degraded} />
        </div>
      ) : (
        <Centered
          title="No activity yet"
          body="Transactions will appear here once you send or receive."
        />
      )}
    </motion.div>
  );
}

/**
 * Says WHY the list is short, rather than leaving the user to assume it is
 * complete. A history that silently omits transactions is worse than one that
 * admits it cannot see them.
 */
function StatusNote({ degraded }: { degraded: DegradedActivity }) {
  const { status, chainName } = degraded;
  if (status === "unsupported_endpoint") {
    return (
      <Callout tone="neutral" title="History is unavailable on this endpoint">
        Your own pending sends still appear here. Full history needs an indexing service, which the
        RPC configured for {chainName} does not provide -- a reasonable trade if you chose that
        endpoint for privacy.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Could not reach the history service">
      Anything shown below is from this device. The chain itself is unaffected -- your balances and
      the ability to send are not.
    </Callout>
  );
}

function ActivityRow({ entry }: { entry: UnifiedActivityRow }) {
  const isPending = entry.status === "pending";
  const tone =
    entry.direction === "received"
      ? "var(--color-positive)"
      : entry.direction === "sent"
        ? "var(--color-ink)"
        : "var(--color-slate)";

  const body = (
    <>
      <span className="flex items-center gap-3">
        <span style={{ opacity: isPending ? 0.5 : 1 }}>
          <AssetAvatar symbol={entry.symbol} />
        </span>
        <span className="flex flex-col">
          <span className="text-sm text-(--color-ink)">{entry.headline}</span>
          <span className="mt-0.5 text-[11px] text-(--color-slate)">
            {isPending ? "Pending" : entry.timeLabel}
            {entry.counterparty ? ` - ${abbreviate(entry.counterparty)}` : ""}
          </span>
        </span>
      </span>
      {/* The sign carries direction independently of colour, so it survives
          both themes and colour-blindness -- the same rule the change badge
          follows. */}
      <span className="numeric text-sm" style={{ color: tone }}>
        {entry.amountLabel}
      </span>
    </>
  );

  const className =
    "flex w-full items-center justify-between border-t border-(--color-line) py-3 text-left";

  // A pending row has no explorer page yet -- the transaction is not in a block
  // -- so it is not a link. Linking to a 404 reads as the transaction having
  // vanished.
  if (!entry.explorerUrl || isPending) {
    return <div className={className}>{body}</div>;
  }

  return (
    <a
      href={entry.explorerUrl}
      target="_blank"
      rel="noreferrer noopener"
      className={`${className} transition-colors hover:bg-(--color-muted)`}
    >
      {body}
    </a>
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="font-serif text-lg text-(--color-ink)">{title}</p>
      <p className="max-w-[240px] text-xs leading-relaxed text-(--color-slate)">{body}</p>
    </div>
  );
}

function abbreviate(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
