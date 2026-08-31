import { AssetAvatar } from "../components";
import type { BitcoinPortfolioResult } from "@/core/messaging/walletApi";

export interface BitcoinCardProps {
  portfolio: BitcoinPortfolioResult;
  onClick?: (() => void) | undefined;
}

export function BitcoinCard({ portfolio, onClick }: BitcoinCardProps) {
  const isPriced = portfolio.fiatStatus === "priced" && portfolio.fiatValue !== undefined;
  const fiatDisplay = isPriced
    ? `$${portfolio.fiatValue!.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    : "—";

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`group flex items-center justify-between rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3 transition-colors ${
        onClick ? "cursor-pointer hover:bg-(--color-muted)" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <AssetAvatar symbol="BTC" size={32} />
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-sm text-(--color-ink)">Bitcoin</span>
            <span className="rounded bg-(--color-muted) px-1.5 py-0.5 text-[10px] font-medium text-(--color-slate)">
              {portfolio.network.shortName}
            </span>
          </div>
          <span className="text-xs text-(--color-slate)">
            {portfolio.usedAddressCount > 0
              ? `${portfolio.usedAddressCount} active ${portfolio.usedAddressCount === 1 ? "address" : "addresses"}`
              : "Native SegWit (BIP-84)"}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-end">
        <span className="font-medium text-sm text-(--color-ink)">
          {portfolio.balanceLabel}
        </span>
        <span className="text-xs text-(--color-slate)">
          {fiatDisplay}
        </span>
      </div>
    </div>
  );
}

export interface BitcoinUnavailableCardProps {
  /** Short and plain: "Can't contact mainnet". Never a host or a status code. */
  reason: string;
  onRetry?: (() => void) | undefined;
}

/**
 * The Bitcoin row when the indexer could not be reached.
 *
 * ===========================================================================
 * A DASH, NOT A ZERO, AND NEVER AN ABSENCE
 * ===========================================================================
 * Same rule the EVM side applies to a missing price: "no answer" and "nothing
 * held" are different facts and must not render alike. Bitcoin has no row to
 * omit -- it is one figure -- so the card stays and the figure becomes a dash.
 *
 * The reason takes the subtitle's place rather than sitting under it. It says
 * which network is unreachable, which is the whole of what the person reading
 * a balance card can act on; "Balance unavailable" above it only said the same
 * thing again in fewer words. The host, the status code and the timeout stay on
 * the error object for whoever is debugging -- see `IndexerUnavailableError`.
 */
export function BitcoinUnavailableCard({ reason, onRetry }: BitcoinUnavailableCardProps) {
  return (
    <div className="rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AssetAvatar symbol="BTC" size={32} />
          <div className="flex flex-col">
            <span className="font-semibold text-sm text-(--color-ink)">Bitcoin</span>
            <span className="text-xs text-(--color-slate)">{reason}</span>
          </div>
        </div>
        <span className="font-medium text-sm text-(--color-slate)">—</span>
      </div>

      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-[11px] font-medium text-(--color-ink) underline underline-offset-2"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
