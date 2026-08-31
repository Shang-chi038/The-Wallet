import { useState } from "react";
import { motion } from "framer-motion";
import {
  ActionButton,
  AssetRow,
  ChangeBadge,
  Icon,
  ICON_PATHS,
  Pill,
  SectionLabel,
  assetColor,
} from "../components";
import { TextButton } from "../components/forms";
import {
  NAMED_COLLAPSED_SYMBOLS,
  describeChange,
  formatFiatForHero,
  selectOtherBucket,
  splitHeroValue,
} from "@/core/token/fiatDisplay";
import type { PortfolioChange } from "@/core/price/priceReader";
import { selectHeroPresentation } from "@/core/portfolio/heroPresentation";
import type { BitcoinPortfolioResult } from "@/core/messaging/walletApi";
import { BitcoinCard, BitcoinUnavailableCard } from "./BitcoinCard";

/**
 * Portfolio — the main screen.
 *
 * LAYOUT ORDER follows Rainbow: identity and network at the top, then the one
 * number the user opened the wallet for, then the actions that operate on it,
 * then holdings. Actions sit directly under the balance rather than in a menu
 * because send and receive are the two things people actually come here to do.
 */

export interface PortfolioHolding {
  /**
   * Stable identity: the contract address, or "native".
   *
   * NOT the symbol. Two rows can legitimately carry the same symbol once a user
   * imports a token whose contract calls itself "USDC", and keying React rows
   * on a value an attacker chooses is how one row silently renders another's
   * balance.
   */
  id: string;
  symbol: string;
  name: string;
  networkLabel: string;
  /**
   * Undefined when no price was available -- NOT zero. A wallet that renders
   * "$0.00" because a price feed timed out is telling the user their money is
   * gone, which is the one direction of error that causes bad decisions.
   */
  fiatValue: number | undefined;
  balanceLabel: string;
  /** User-imported: metadata is the contract's word, and it is never priced. */
  isImported?: boolean | undefined;
}

export interface PortfolioScreenProps {
  accountLabel: string;
  networkName: string;
  /** Undefined when prices are unavailable; the hero falls back to the balance. */
  totalFiat: number | undefined;
  /**
   * The change figure, or the reason there is none. Never a fabricated 0.00%,
   * and never a bare "missing" -- an empty wallet and an unpriced one need
   * different words. See `PortfolioChange`.
   */
  change: PortfolioChange;
  /**
   * Shown in the hero when there is no fiat total -- the native balance, e.g.
   * "0.4218 ETH". Still the number the user came to see, just denominated in
   * the asset instead of in dollars.
   *
   * UNDEFINED when there is no successful read to draw it from, which is not
   * the same as a balance of zero and must not look like one. The hero shows a
   * dash instead. This used to be `0 ETH` in that case, which told someone
   * whose RPC was unreachable that their money was gone -- in the largest type
   * on the screen, and with a `$0.00` above it whenever prices happened to
   * arrive. It is the exact failure the "no price is `undefined`, never `0`"
   * rule exists to prevent, one field further down.
   */
  fallbackHeroLabel: string | undefined;
  /**
   * Why there is no portfolio: "Can't reach Sepolia". Replaces the change note
   * under the hero, which otherwise reads "Nothing to track yet" -- a sentence
   * about an empty wallet, printed at the one moment it is certainly wrong.
   */
  portfolioError?: string | undefined;
  holdings: readonly PortfolioHolding[];
  bitcoinPortfolio?: BitcoinPortfolioResult | undefined;
  /**
   * Why there is no Bitcoin figure, when there is a Bitcoin account to have one
   * for. Rendered INSTEAD of the card, in the same place, rather than dropping
   * the section: a heading that disappears reads as the asset having been
   * removed from the wallet, which is the same harm as rendering 0 BTC.
   */
  bitcoinError?: string | undefined;
  isLocked?: boolean | undefined;
  isRefreshing?: boolean | undefined;
  onSend?: (() => void) | undefined;
  onReceive?: (() => void) | undefined;
  onReceiveBitcoin?: (() => void) | undefined;
  onRetryBitcoin?: (() => void) | undefined;
  onRetryPortfolio?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  onSelectAsset?: ((symbol: string) => void) | undefined;
  onSelectAccount?: (() => void) | undefined;
  onSelectNetwork?: (() => void) | undefined;
  /** "I hold a token this list does not show" -- the moment of need. */
  onImportToken?: (() => void) | undefined;
}

export function PortfolioScreen({
  accountLabel,
  networkName,
  totalFiat,
  change,
  fallbackHeroLabel,
  portfolioError,
  holdings,
  bitcoinPortfolio,
  bitcoinError,
  isLocked = false,
  isRefreshing = false,
  onSend,
  onReceive,
  onReceiveBitcoin,
  onRetryBitcoin,
  onRetryPortfolio,
  onOpenSettings,
  onSelectAsset,
  onSelectAccount,
  onSelectNetwork,
  onImportToken,
}: PortfolioScreenProps) {
  const [isOtherExpanded, setIsOtherExpanded] = useState(false);
  const indicator = change.status === "available" ? describeChange(change.percentChange) : undefined;

  /**
   * What to say when there is no percentage.
   *
   * Three different situations, three different sentences. "Prices unavailable"
   * is information the user needs when they hold something we could not value;
   * it is actively misleading printed under a $0.00 that is entirely correct.
   */
  // The hero's three states and the line under it are decided in
  // `selectHeroPresentation`, where the hermetic suite can reach them. A
  // ternary here is how `0 ETH` came to stand in for an unreachable RPC.
  const hero = selectHeroPresentation({
    totalFiat,
    nativeBalanceLabel: fallbackHeroLabel,
    change,
    isRefreshing,
    portfolioError,
  });
  /**
   * The proportion bar describes the PRICED portfolio -- the same set the hero
   * figure above it totals.
   *
   * Imported tokens are excluded rather than counted as missing prices, for the
   * same reason `portfolioService` leaves them out of the total: they have no
   * price by design, not by failure, and treating one as an outage would delete
   * the bar for as long as the user keeps the token. A genuinely unpriced
   * built-in still hides it, because then the widths really would describe a
   * portfolio the user does not have.
   */
  const priceable = holdings.filter((holding) => !holding.isImported);
  const isFullyPriced =
    priceable.length > 0 && priceable.every((holding) => holding.fiatValue !== undefined);
  const total = priceable.reduce((sum, holding) => sum + (holding.fiatValue ?? 0), 0);

  /**
   * The sub-1% "Other" bucket from screen 05. `selectOtherBucket` holds the
   * rules and the reasons; the three gates it applies are all about not hiding
   * money by accident.
   *
   * EXPANDABLE, not final. Collapsing is a tidiness feature, and a wallet that
   * permanently hides a holding because it is small has decided for the user
   * what their money is worth looking at.
   */
  const otherBucket = selectOtherBucket(holdings);

  /** Rows stay in the order the ENGINE supplied; the bucket decides membership. */
  const collapsedIds = new Set((otherBucket?.collapsed ?? []).map((holding) => holding.id));
  const isBucketCollapsed = otherBucket !== undefined && !isOtherExpanded;
  const listedHoldings = isBucketCollapsed
    ? holdings.filter((holding) => !collapsedIds.has(holding.id))
    : holdings;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col px-4 pt-4"
    >
      {/* Identity + network. Settings is a header icon, not a tab — four tabs
          plus a centre button is too crowded at popup width. */}
      <header className="mb-6 flex items-center justify-between">
        <Pill onClick={onSelectAccount}>
          <span className="font-medium">{accountLabel}</span>
          <Icon path={ICON_PATHS.chevronDown} size={12} />
        </Pill>
        <div className="flex items-center gap-2">
          <Pill onClick={onSelectNetwork}>
            <span>{networkName}</span>
            <Icon path={ICON_PATHS.chevronDown} size={12} />
          </Pill>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="flex h-8 w-8 items-center justify-center rounded-full text-(--color-slate) hover:bg-(--color-muted)"
          >
            <Icon path={ICON_PATHS.settings} size={15} />
          </button>
        </div>
      </header>

      {/* The hero. Serif, tabular, auto-abbreviated so a large naira balance
          stays legible instead of shrinking to fit. */}
      <section className="mb-6">
        <div className="numeric font-serif text-[36px] leading-none tracking-[-0.035em] text-(--color-ink)">
          {hero.figure.kind === "fiat" ? (
            (() => {
              // Cents render in the faint token so the eye lands on the
              // magnitude first — see docs/design-spec-notes.md.
              const { primary, cents } = splitHeroValue(
                formatFiatForHero(hero.figure.totalFiat, "USD"),
              );
              return (
                <>
                  {primary}
                  {cents ? <span className="text-(--color-faint)">{cents}</span> : null}
                </>
              );
            })()
          ) : hero.figure.kind === "native" ? (
            hero.figure.label
          ) : (
            // A dash, not a zero. See `selectHeroPresentation`.
            "—"
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          {indicator ? (
            <>
              <ChangeBadge arrow={indicator.arrow} label={indicator.label} tone={indicator.tone} />
              <span className="text-xs text-(--color-slate)">today</span>
            </>
          ) : (
            <span className="text-xs text-(--color-slate)">{hero.note}</span>
          )}
          {hero.canRetry && onRetryPortfolio ? (
            <button
              type="button"
              onClick={onRetryPortfolio}
              className="text-xs font-medium text-(--color-ink) underline underline-offset-2"
            >
              Try again
            </button>
          ) : null}
        </div>
      </section>

      {/* Actions, directly beneath the balance. */}
      <section className="mb-7 flex gap-3">
        <ActionButton
          label="Send"
          icon={<Icon path={ICON_PATHS.send} />}
          onClick={onSend}
          disabled={isLocked}
        />
        <ActionButton
          label="Receive"
          icon={<Icon path={ICON_PATHS.receive} />}
          onClick={onReceive}
          disabled={isLocked}
        />
        <ActionButton label="Buy" icon={<Icon path={ICON_PATHS.buy} />} disabled />
      </section>

      {/* Proportion bar: asset colours used for identity only, never for
          buttons or text. */}
      {isFullyPriced && total > 0 ? (
        <div className="mb-5 flex gap-0.5" aria-hidden="true">
          {(otherBucket?.visible ?? priceable).map((holding) => (
            <span
              key={holding.id}
              className="block h-1.5 rounded-full"
              style={{
                width: `${((holding.fiatValue ?? 0) / total) * 100}%`,
                minWidth: 2,
                background: assetColor(holding.symbol),
              }}
            />
          ))}
          {/* The bucket keeps its segment whether or not the list is expanded:
              the bar describes proportions, and expanding a row does not change
              what anything is worth. */}
          {otherBucket ? (
            <span
              className="block h-1.5 rounded-full"
              style={{
                width: `${(otherBucket.otherValue / total) * 100}%`,
                minWidth: 2,
                background: "var(--color-asset-other)",
              }}
            />
          ) : null}
        </div>
      ) : null}

      {bitcoinPortfolio || bitcoinError ? (
        <section className="mb-5">
          <SectionLabel>Bitcoin</SectionLabel>
          {bitcoinPortfolio ? (
            <BitcoinCard portfolio={bitcoinPortfolio} onClick={onReceiveBitcoin} />
          ) : (
            <BitcoinUnavailableCard reason={bitcoinError ?? ""} onRetry={onRetryBitcoin} />
          )}
        </section>
      ) : null}

      <section className="flex-1">
        <SectionLabel>Holdings</SectionLabel>
        {holdings.length === 0 ? (
          <EmptyHoldings />
        ) : (
          listedHoldings.map((holding) => (
            <AssetRow
              key={holding.id}
              symbol={holding.symbol}
              name={holding.name}
              // A native coin on its own chain would read "Ethereum /
              // Ethereum". Suppress the network line when it merely repeats the
              // asset name; it carries no information there.
              {...(holding.networkLabel === holding.name
                ? {}
                : { networkLabel: holding.networkLabel })}
              // With no price, the balance IS the primary figure. Falling back
              // to it keeps the row informative instead of showing a dash.
              primaryValue={
                holding.fiatValue === undefined
                  ? holding.balanceLabel
                  : formatFiatForHero(holding.fiatValue, "USD")
              }
              {...(holding.fiatValue === undefined
                ? {}
                : { secondaryValue: holding.balanceLabel })}
              {...(holding.isImported ? { badge: "Imported" } : {})}
              {...(onSelectAsset ? { onClick: () => onSelectAsset(holding.symbol) } : {})}
            />
          ))
        )}

        {otherBucket ? (
          <OtherHoldingsRow
            collapsed={otherBucket.collapsed}
            otherValue={otherBucket.otherValue}
            isExpanded={isOtherExpanded}
            onToggle={() => setIsOtherExpanded((expanded) => !expanded)}
          />
        ) : null}

        {/* Said once, under the list, only when it applies. An imported token
            shows its balance and no dollar figure, and a user who is not told
            why reads that as the wallet failing to load a price. */}
        {holdings.some((holding) => holding.isImported) ? (
          <p className="mt-3 text-[10px] leading-relaxed text-(--color-faint)">
            Tokens you added yourself are shown by balance only. This wallet does not price them,
            because a token can call itself anything and a price looked up by name would be the
            wrong price.
          </p>
        ) : null}

        {onImportToken ? (
          <div className="mt-4 border-t border-(--color-line) pt-3 text-center">
            <TextButton onClick={onImportToken}>Not seeing a token? Add it</TextButton>
          </div>
        ) : null}
      </section>
    </motion.div>
  );
}

/**
 * The collapsed sub-1% row — "Other · TRX · DAI" with a dashed +2 chip.
 *
 * It names the largest couple of assets rather than only counting them,
 * because "Other · 4 assets" is a row the user has to open to learn anything
 * from, and the whole point of the bucket is to avoid spending attention on
 * this part of the list.
 *
 * Expanded, it stays put as the way back. A "show less" that appears somewhere
 * else on the screen leaves the user hunting for the control they just used.
 */
function OtherHoldingsRow({
  collapsed,
  otherValue,
  isExpanded,
  onToggle,
}: {
  collapsed: readonly PortfolioHolding[];
  otherValue: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const named = [...collapsed]
    .sort((left, right) => (right.fiatValue ?? 0) - (left.fiatValue ?? 0))
    .slice(0, NAMED_COLLAPSED_SYMBOLS)
    .map((holding) => holding.symbol);
  const remainder = collapsed.length - named.length;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className="flex w-full items-center justify-between border-t border-(--color-line) py-3 text-left transition-colors hover:bg-(--color-muted)"
    >
      <span className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full text-[13px] text-(--color-btn-fg)"
          style={{ background: "var(--color-asset-other)" }}
          aria-hidden="true"
        >
          <Icon path={isExpanded ? ICON_PATHS.chevronUp : ICON_PATHS.chevronDown} size={13} />
        </span>
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <span className="text-sm text-(--color-ink)">
              {isExpanded ? "Show less" : ["Other", ...named].join(" · ")}
            </span>
            {!isExpanded && remainder > 0 ? (
              <span className="rounded-(--radius-pill) border border-dashed border-(--color-line) px-1.5 py-px text-[9px] tracking-[0.04em] text-(--color-slate)">
                +{remainder}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 text-[11px] text-(--color-slate)">
            {isExpanded
              ? `${collapsed.length} small holdings shown`
              : `Under 1% each · ${collapsed.length} assets`}
          </span>
        </span>
      </span>
      <span className="numeric text-sm text-(--color-slate)">
        {formatFiatForHero(otherValue, "USD")}
      </span>
    </button>
  );
}

function EmptyHoldings() {
  return (
    <div className="flex flex-col items-center gap-2 border-t border-(--color-line) py-10 text-center">
      <p className="font-serif text-lg text-(--color-ink)">Nothing here yet</p>
      <p className="max-w-[240px] text-xs leading-relaxed text-(--color-slate)">
        Receive some ETH or USDC to get started. Your address is ready to share.
      </p>
    </div>
  );
}
