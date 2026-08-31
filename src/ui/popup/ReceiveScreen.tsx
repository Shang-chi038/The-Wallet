import { useState } from "react";
import { motion } from "framer-motion";
import type { ChainSummary } from "@/core/messaging/walletApi";
import { QrCode } from "../components/QrCode";
import { Callout, SecondaryButton } from "../components/forms";
import { Icon, ICON_PATHS } from "../components";

/**
 * Receive.
 *
 * ===========================================================================
 * THE ADDRESS IS THE RECORD; THE QR IS A CONVENIENCE
 * ===========================================================================
 * The full checksummed address is always rendered as selectable text, in
 * monospace, broken across lines so every character is visible. That is not
 * belt-and-braces styling -- it is the guard that makes a home-grown QR encoder
 * acceptable in a wallet. If the picture were ever wrong, the text is what the
 * user can check, and what a careful sender will compare against.
 *
 * ===========================================================================
 * THE NETWORK WARNING
 * ===========================================================================
 * An Ethereum address is the same 20 bytes on every EVM chain, so the same QR
 * is valid on all of them -- and assets sent on the wrong chain are, in
 * practice, gone. The chain is therefore named prominently rather than shown as
 * a quiet label, and a testnet says so in plain words: someone sending real
 * funds to a testnet address has lost them.
 */

export interface ReceiveScreenProps {
  address: string;
  accountLabel: string;
  chain: ChainSummary;
  onBack: () => void;
}

export function ReceiveScreen({ address, accountLabel, chain, onBack }: ReceiveScreenProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      // Reset so the affordance is available again rather than stuck on
      // "Copied", which reads as though a second copy did nothing.
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused. The address is on screen and
      // selectable, so there is nothing to recover from and nothing to report.
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col px-4 pt-4"
    >
      <header className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-8 w-8 items-center justify-center rounded-full text-(--color-slate) hover:bg-(--color-muted)"
        >
          <span className="rotate-180">
            <Icon path={ICON_PATHS.chevronRight} size={16} />
          </span>
        </button>
        <h1 className="font-serif text-lg text-(--color-ink)">Receive</h1>
      </header>

      <div className="flex flex-col items-center gap-4">
        <div className="rounded-(--radius-card) border border-(--color-line) bg-white p-3">
          <QrCode value={address} size={168} label={`QR code for ${address}`} />
        </div>

        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-(--color-slate)">{accountLabel}</span>
          {/* Selectable, monospace, fully visible. Never truncated: a shortened
              address is exactly what a substitution attack needs to pass. */}
          <p className="max-w-[280px] text-center font-mono text-[13px] leading-relaxed break-all text-(--color-ink) select-all">
            {address}
          </p>
        </div>

        <div className="w-full">
          <SecondaryButton onClick={() => void copy()}>
            {copied ? "Copied" : "Copy address"}
          </SecondaryButton>
        </div>

        <Callout
          tone={chain.isTestnet ? "warning" : "neutral"}
          title={`Only send on ${chain.name}`}
        >
          {chain.isTestnet
            ? `This is a test network. Coins here have no value, and real funds sent to this address on ${chain.name} cannot be recovered.`
            : `This address works on ${chain.name}. Assets sent on a different network usually cannot be recovered.`}
        </Callout>
      </div>
    </motion.div>
  );
}
