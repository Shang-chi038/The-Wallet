import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { BitcoinReceiveAddressResult } from "@/core/messaging/walletApi";
import { QrCode } from "../components/QrCode";
import { Callout, SecondaryButton, Spinner } from "../components/forms";
import { Icon, ICON_PATHS } from "../components";
import { walletClient } from "../shared/walletClient";

export interface BitcoinReceiveScreenProps {
  /**
   * The BIP-84 account to derive from, supplied rather than left to the
   * engine's default.
   *
   * The engine defaults to the selected account, so omitting this would
   * usually be right -- but this screen NAMES an account on the QR code, and a
   * label and an address that resolve independently can disagree. Asking for
   * the account this screen is labelled with makes them one decision.
   */
  accountIndex: number;
  accountLabel: string;
  onBack: () => void;
}

export function BitcoinReceiveScreen({
  accountIndex,
  accountLabel,
  onBack,
}: BitcoinReceiveScreenProps) {
  const [receiveInfo, setReceiveInfo] = useState<BitcoinReceiveAddressResult | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadAddress() {
      try {
        const result = await walletClient.getBitcoinReceiveAddress({ accountIndex });
        if (active) {
          setReceiveInfo(result);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load receive address.");
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }
    void loadAddress();
    return () => {
      active = false;
    };
    // Re-derives when the account changes: the address on screen must be the
    // one belonging to the account named beside it.
  }, [accountIndex]);

  const copy = async () => {
    if (!receiveInfo?.address) return;
    try {
      await navigator.clipboard.writeText(receiveInfo.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Address is visible and selectable on screen
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col px-4 pt-4 pb-6 overflow-y-auto"
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
        <div className="flex flex-col">
          <h1 className="font-serif text-lg text-(--color-ink)">Receive Bitcoin</h1>
          {/*
            Named, because the address changes with it. A wallet that shows one
            Bitcoin QR code under several accounts trains the user to believe
            there is only one, and the deposit they make from the wrong screen
            lands somewhere they will not look for it.
          */}
          <span className="text-xs text-(--color-slate)">{accountLabel}</span>
        </div>
      </header>

      {isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <Spinner label="" />
          <span className="mt-3 text-xs text-(--color-slate)">Generating fresh address...</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-red-500">{error}</p>
          <button
            type="button"
            onClick={onBack}
            className="mt-4 text-xs font-medium text-(--color-slate) underline"
          >
            Go back
          </button>
        </div>
      ) : receiveInfo ? (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-(--radius-card) border border-(--color-line) bg-white p-3">
            <QrCode
              value={`bitcoin:${receiveInfo.address}`}
              size={168}
              label={`QR code for ${receiveInfo.address}`}
            />
          </div>

          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-(--color-slate)">
              Address #{receiveInfo.addressIndex + 1} (Native SegWit)
            </span>
            <span className="font-mono text-[10px] text-(--color-slate)">
              {receiveInfo.derivationPath}
            </span>
            <p className="max-w-[280px] text-center font-mono text-[13px] leading-relaxed break-all text-(--color-ink) select-all">
              {receiveInfo.address}
            </p>
          </div>

          <div className="w-full">
            <SecondaryButton onClick={() => void copy()}>
              {copied ? "Copied" : "Copy address"}
            </SecondaryButton>
          </div>

          <div className="w-full rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3 text-xs text-(--color-slate) leading-relaxed">
            <p className="font-medium text-(--color-ink) mb-1">Privacy & Address Rotation</p>
            <p>
              A fresh address is generated for every deposit to protect your privacy.
              Previously generated addresses remain valid and spendable indefinitely.
            </p>
          </div>

          {receiveInfo.network.isTestnet && (
            <Callout tone="warning" title={`Only send on ${receiveInfo.network.name}`}>
              This is a test network ({receiveInfo.network.shortName}). Coins here have no
              value, and real mainnet BTC sent to this address cannot be recovered.
            </Callout>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}
