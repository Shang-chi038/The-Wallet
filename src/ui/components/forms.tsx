import type { ReactNode } from "react";
import { motion } from "framer-motion";

/**
 * Form primitives.
 *
 * Same rule as the display components: every colour resolves to a token from
 * styles/global.css, so both themes stay in sync by construction and no file
 * outside that stylesheet knows a hex value.
 */

export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  type = "button",
  tone = "default",
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  type?: "button" | "submit";
  tone?: "default" | "danger";
}) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...(disabled ? {} : { whileTap: { scale: 0.985 } })}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className="w-full rounded-(--radius-card) px-4 py-3 text-sm font-medium disabled:opacity-40"
      style={{
        background: tone === "danger" ? "var(--color-danger)" : "var(--color-btn-bg)",
        color: tone === "danger" ? "#FFFFFF" : "var(--color-btn-fg)",
      }}
    >
      {children}
    </motion.button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(disabled ? {} : { whileTap: { scale: 0.985 } })}
      className="w-full rounded-(--radius-card) border border-(--color-line) bg-(--color-card) px-4 py-3 text-sm font-medium text-(--color-ink) disabled:opacity-40"
    >
      {children}
    </motion.button>
  );
}

export function TextButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium text-(--color-slate) underline underline-offset-2 hover:text-(--color-ink)"
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-(--color-slate)">
        {label}
      </span>
      {children}
      {/* The error replaces the hint rather than stacking under it: two lines of
          guidance under one field is how people end up reading neither. */}
      {error ? (
        <span role="alert" className="text-xs text-(--color-danger)">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-(--color-slate)">{hint}</span>
      ) : null}
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-(--radius-field) border border-(--color-line) bg-(--color-card) px-3 py-2.5 text-sm text-(--color-ink) outline-none placeholder:text-(--color-faint) focus:border-(--color-slate)";

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  onSubmit,
  /**
   * `new-password` on creation, `current-password` on unlock.
   *
   * Not cosmetic: it is what stops a password manager offering to save the
   * unlock password as a new credential every time the wallet is opened, and
   * what makes it offer the right one on the unlock screen.
   */
  autoComplete = "current-password",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  onSubmit?: (() => void) | undefined;
  autoComplete?: "current-password" | "new-password";
}) {
  return (
    <input
      type="password"
      value={value}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onSubmit) onSubmit();
      }}
      className={INPUT_CLASS}
    />
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  onSubmit?: (() => void) | undefined;
}) {
  return (
    <input
      type="text"
      value={value}
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onSubmit) onSubmit();
      }}
      className={INPUT_CLASS}
    />
  );
}

export function PhraseTextArea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
}) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={3}
      // Autocomplete, autocorrect and spellcheck all OFF. A recovery phrase is
      // twelve dictionary words: autocorrect will happily "fix" one into
      // another valid word, and the resulting wallet is a different wallet with
      // no error message to say so.
      //
      // The settings screen's private-key field depends on these same
      // attributes for the same reason -- a "corrected" hex string is a
      // different key. Do not relax them for one call site.
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className="w-full resize-none rounded-(--radius-field) border border-(--color-line) bg-(--color-card) px-3 py-2.5 font-mono text-sm leading-relaxed text-(--color-ink) outline-none placeholder:text-(--color-faint) focus:border-(--color-slate)"
    />
  );
}

/**
 * Inline notice.
 *
 * `danger` and `warning` are visually distinct AND carry a text label, because
 * colour alone cannot carry severity for a colour-blind user -- the same rule
 * the change indicator follows.
 */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger" | "neutral";
  title?: string | undefined;
  children: ReactNode;
}) {
  const accent =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-asset-btc)"
        : "var(--color-slate)";
  return (
    <div
      className="rounded-(--radius-card) border-l-2 bg-(--color-muted) px-3 py-2.5"
      style={{ borderLeftColor: accent }}
    >
      {title ? (
        <p className="mb-0.5 text-xs font-semibold" style={{ color: accent }}>
          {title}
        </p>
      ) : null}
      <div className="text-xs leading-relaxed text-(--color-slate)">{children}</div>
    </div>
  );
}

/** Monospace address, truncated in the middle so both ends stay verifiable. */
export function AddressChip({ address, full = false }: { address: string; full?: boolean }) {
  const shown = full ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
  return (
    <span className="font-mono text-xs break-all text-(--color-ink)" title={address}>
      {shown}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-(--color-slate)">
      <motion.span
        aria-hidden="true"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
        className="block h-3 w-3 rounded-full border-2 border-(--color-line) border-t-(--color-slate)"
      />
      {label}
    </div>
  );
}
