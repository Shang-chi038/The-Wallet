import type { ReactNode } from "react";
import { motion } from "framer-motion";

/**
 * UI primitives.
 *
 * Every colour here resolves to a token from styles/global.css. Nothing
 * hardcodes a hex, so both themes stay in sync by construction.
 */

const ASSET_COLORS: Record<string, string> = {
  BTC: "var(--color-asset-btc)",
  USDT: "var(--color-asset-usdt)",
  USDC: "var(--color-asset-usdc)",
  ETH: "var(--color-asset-eth)",
};

export function assetColor(symbol: string): string {
  return ASSET_COLORS[symbol.toUpperCase()] ?? "var(--color-asset-other)";
}

/**
 * Currency glyphs, per screens_6.html.
 *
 * The spec uses the asset's own currency sign rather than a letter, which is
 * both more informative and solves a problem a lettermark cannot: USDC and USDT
 * both begin with "U", so `symbol.charAt(0)` would render two different assets
 * identically and leave COLOUR as the only distinguishing signal — exactly what
 * the design rule forbids, and invisible to a colour-blind user.
 *
 * Assets with no currency sign (TRX, DAI) fall back to a letter, as the spec
 * also does.
 */
const ASSET_GLYPHS: Record<string, string> = {
  BTC: "\u20BF", // ₿
  USDT: "\u20AE", // ₮
  USDC: "$",
  ETH: "\u039E", // Ξ
};

export function assetGlyph(symbol: string): string {
  const upper = symbol.toUpperCase();
  return ASSET_GLYPHS[upper] ?? upper.charAt(0);
}

/**
 * Per-glyph optical sizing, as a fraction of the avatar diameter.
 *
 * Not incidental: ₿ ₮ Ξ and $ have very different optical weights at the same
 * point size, and the spec tunes each one individually. A single ratio makes ₮
 * look bloated next to $.
 */
const GLYPH_SIZE_RATIO: Record<string, number> = {
  BTC: 0.5,
  USDT: 0.46,
  USDC: 0.42,
  ETH: 0.46,
};

export function glyphSizeRatio(symbol: string): number {
  return GLYPH_SIZE_RATIO[symbol.toUpperCase()] ?? 0.42;
}

/**
 * Lettermark avatar.
 *
 * Placeholder for real asset logos, as the spec notes. Kept as a single
 * component so swapping in `logoUrl` later touches one file.
 */
export function AssetAvatar({ symbol, size = 26 }: { symbol: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex flex-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * glyphSizeRatio(symbol),
        background: assetColor(symbol),
      }}
    >
      {assetGlyph(symbol)}
    </span>
  );
}

export function Pill({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
}) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      {...(onClick ? { onClick, type: "button" as const } : {})}
      className="flex items-center gap-1 whitespace-nowrap rounded-full border border-(--color-line) bg-(--color-card) px-2.5 py-1.5 text-[11px] text-(--color-ink)"
    >
      {children}
    </Component>
  );
}

/**
 * Primary action button, Rainbow-style: a circular icon above a small label,
 * laid out in a horizontal row directly beneath the balance.
 */
export function ActionButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(disabled ? {} : { whileTap: { scale: 0.94 } })}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="flex flex-1 flex-col items-center gap-2 disabled:opacity-40"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-(--color-btn-bg) text-(--color-btn-fg)">
        {icon}
      </span>
      <span className="text-[11px] font-medium text-(--color-ink)">{label}</span>
    </motion.button>
  );
}

/**
 * Asset row.
 *
 * Assets are listed flat and sorted by value, per the spec. The network label
 * follows the one-chain-names-it / many-chains-count-them rule.
 */
export function AssetRow({
  symbol,
  name,
  networkLabel,
  primaryValue,
  secondaryValue,
  /**
   * Short marker beside the asset name.
   *
   * Exists for imported tokens. Two rows can legitimately read "USDC" -- the
   * one this wallet ships and one whose contract merely says so -- and the row
   * is the only place a user can tell them apart.
   */
  badge,
  onClick,
}: {
  symbol: string;
  name: string;
  networkLabel?: string | undefined;
  primaryValue: string;
  secondaryValue?: string | undefined;
  badge?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between border-t border-(--color-line) py-3 text-left transition-colors hover:bg-(--color-muted)"
    >
      <span className="flex items-center gap-3">
        <AssetAvatar symbol={symbol} />
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <span className="text-sm text-(--color-ink)">{name}</span>
            {badge ? (
              <span className="rounded-(--radius-pill) border border-(--color-line) px-1.5 py-px text-[9px] tracking-[0.04em] text-(--color-slate)">
                {badge}
              </span>
            ) : null}
          </span>
          {networkLabel ? (
            <span className="mt-0.5 text-[11px] text-(--color-slate)">{networkLabel}</span>
          ) : null}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="numeric text-sm text-(--color-ink)">{primaryValue}</span>
        {secondaryValue ? (
          <span className="numeric mt-0.5 text-[11px] text-(--color-slate)">{secondaryValue}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Change indicator.
 *
 * Renders the arrow and the signed figure as well as the colour, so direction
 * survives both themes and colour-blindness.
 */
export function ChangeBadge({
  arrow,
  label,
  tone,
}: {
  arrow: string;
  label: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? "var(--color-positive)"
      : tone === "negative"
        ? "var(--color-danger)"
        : "var(--color-slate)";
  return (
    <span className="numeric flex items-center gap-1 text-xs" style={{ color }}>
      <span aria-hidden="true">{arrow}</span>
      {label}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-(--color-slate)">
      {children}
    </h2>
  );
}

export function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export const ICON_PATHS = {
  send: "M12 19V5M5 12l7-7 7 7",
  receive: "M12 5v14M5 12l7 7 7-7",
  buy: "M12 5v14M5 12h14",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
  portfolio: "M3 3v18h18M7 14l4-4 4 4 5-5",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  check: "M20 6L9 17l-5-5",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 18l6-6-6-6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 018 0v4",
} as const;
