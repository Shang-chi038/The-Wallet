import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type {
  PortfolioEntryResult,
  PrepareSendResult,
  RecipientResolution,
  WalletStatusResult,
} from "@/core/messaging/walletApi";
import { parseTokenAmount } from "@/core/token/tokenAmount";
import { abbreviateEnsName } from "@/core/ens/ensName";
import { Icon, ICON_PATHS, AssetAvatar } from "../components";
import {
  AddressChip,
  Callout,
  Field,
  PrimaryButton,
  SecondaryButton,
  Spinner,
  TextButton,
  TextInput,
} from "../components/forms";
import { walletClient } from "../shared/walletClient";

/**
 * Send.
 *
 * ===========================================================================
 * TWO STEPS, AND THE SECOND ONE IS NOT A FORMALITY
 * ===========================================================================
 * Compose, then review. The review step exists because the transaction is
 * ASSEMBLED by the service worker -- fee, gas, nonce and affordability all
 * resolved against the live chain -- and what the user confirms is that
 * assembled object, retrieved by id. Nothing is rebuilt on confirm.
 *
 * That is the same guarantee a dApp approval gets, through the same code. The
 * consent surface differs; the object being consented to does not.
 *
 * ===========================================================================
 * ABANDONING A REVIEW MUST RELEASE ITS NONCE
 * ===========================================================================
 * Preparing allocates a nonce. Every way out of the review -- Back, closing the
 * popup, navigating away -- calls `cancelSend`, because a nonce that is never
 * released strands every later transaction from that account behind a gap the
 * chain will never fill, and the wallet simply appears frozen.
 */

/** Long enough that typing an address does not fire a lookup per keystroke. */
const RECIPIENT_DEBOUNCE_MS = 350;

type Step = "compose" | "review" | "sent";

export interface SendScreenProps {
  status: WalletStatusResult;
  holdings: readonly PortfolioEntryResult[];
  onBack: () => void;
  onSent: () => void;
}

export function SendScreen({ status, holdings, onBack, onSent }: SendScreenProps) {
  const [step, setStep] = useState<Step>("compose");
  const [selectedSymbol, setSelectedSymbol] = useState<string | undefined>(
    holdings[0]?.symbol,
  );
  const [recipientInput, setRecipientInput] = useState("");
  const [resolution, setResolution] = useState<RecipientResolution | undefined>();
  const [isResolving, setResolving] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [prepared, setPrepared] = useState<PrepareSendResult | undefined>();
  const [transactionHash, setTransactionHash] = useState<string | undefined>();
  const [explorerUrl, setExplorerUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const asset = holdings.find((holding) => holding.symbol === selectedSymbol) ?? holdings[0];

  /**
   * Releases a preparation's nonce when the component goes away.
   *
   * The popup is closed by clicking anywhere outside it, which unmounts this
   * without any explicit navigation. Without this cleanup a user who opens the
   * review and then clicks away has silently claimed a nonce nothing will use.
   */
  const preparedIdRef = useRef<string | undefined>(undefined);
  preparedIdRef.current = prepared?.preparationId;
  useEffect(
    () => () => {
      const preparationId = preparedIdRef.current;
      if (preparationId) void walletClient.cancelSend(preparationId);
    },
    [],
  );

  // Recipient resolution, debounced. An address never touches the network; only
  // something shaped like a name causes a lookup.
  useEffect(() => {
    const value = recipientInput.trim();
    if (value === "") {
      setResolution(undefined);
      setResolving(false);
      return;
    }
    setResolving(true);
    const timer = setTimeout(() => {
      void walletClient
        .resolveRecipient(value)
        .then(setResolution)
        .catch(() =>
          setResolution({ kind: "invalid", message: "Could not check that recipient." }),
        )
        .finally(() => setResolving(false));
    }, RECIPIENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [recipientInput]);

  const amountBaseUnits = useMemo(() => {
    if (!asset || amountInput.trim() === "") return undefined;
    try {
      // Parsed as fixed-point against the asset's own decimals. No float is
      // involved at any point -- a 0.1 typed by the user becomes exact base
      // units, not 0.1 rounded through a double.
      const parsed = parseTokenAmount(amountInput.trim(), asset.decimals);
      return parsed > 0n ? parsed : undefined;
    } catch {
      // Mid-typing input ("0.", "1e", "") is not an error to report -- it is
      // simply not yet an amount. The Review button stays disabled and the
      // field says nothing, because a validation message that appears on every
      // keystroke is one people learn to ignore.
      return undefined;
    }
  }, [amountInput, asset]);

  const exceedsBalance =
    amountBaseUnits !== undefined && asset !== undefined
      ? amountBaseUnits > BigInt(asset.amountBaseUnits)
      : false;

  const recipientAddress =
    resolution?.kind === "address" || resolution?.kind === "name"
      ? resolution.address
      : undefined;

  const canContinue =
    !busy && recipientAddress !== undefined && amountBaseUnits !== undefined && !exceedsBalance;

  const fillMax = useCallback(async () => {
    if (!asset) return;
    setBusy(true);
    setError(undefined);
    try {
      const max = await walletClient.getSendMax(
        asset.tokenAddress ? { tokenAddress: asset.tokenAddress } : {},
      );
      // The engine's figure, not the displayed balance: for the native currency
      // it already has the worst-case fee reserved out of it. Sending the full
      // balance produces a transaction that cannot pay for itself.
      setAmountInput(max.amountLabel === "0" ? "" : max.amountLabel);
      if (max.amountLabel === "0") {
        setError("There is not enough here to cover the network fee.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not work out the maximum.");
    } finally {
      setBusy(false);
    }
  }, [asset]);

  const goToReview = async () => {
    if (!asset || !recipientAddress || amountBaseUnits === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await walletClient.prepareSend({
        recipient: recipientAddress,
        ...(asset.tokenAddress ? { tokenAddress: asset.tokenAddress } : {}),
        amountBaseUnits: amountBaseUnits.toString(),
      });
      setPrepared(result);
      setStep("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare this transaction.");
    } finally {
      setBusy(false);
    }
  };

  const backToCompose = async () => {
    const preparationId = prepared?.preparationId;
    setPrepared(undefined);
    setStep("compose");
    // Nonce back to the pool before anything else.
    if (preparationId) await walletClient.cancelSend(preparationId);
  };

  const confirm = async () => {
    if (!prepared) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await walletClient.submitSend(prepared.preparationId);
      setTransactionHash(result.transactionHash);
      setExplorerUrl(result.explorerUrl);
      setPrepared(undefined);
      setStep("sent");
      onSent();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transaction was not sent.");
      // The preparation is consumed either way, so returning to compose is the
      // only honest next step -- a retry has to be re-priced against the chain
      // as it is now, not as it was when this review opened.
      setPrepared(undefined);
      setStep("compose");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col px-4 pt-4 pb-4"
    >
      <header className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => (step === "review" ? void backToCompose() : onBack())}
          aria-label="Back"
          className="flex h-8 w-8 items-center justify-center rounded-full text-(--color-slate) hover:bg-(--color-muted)"
        >
          <span className="rotate-180">
            <Icon path={ICON_PATHS.chevronRight} size={16} />
          </span>
        </button>
        <h1 className="font-serif text-lg text-(--color-ink)">
          {step === "sent" ? "Sent" : step === "review" ? "Review" : "Send"}
        </h1>
        <span className="ml-auto text-[11px] text-(--color-slate)">{status.chain.name}</span>
      </header>

      {step === "compose" && holdings.length === 0 ? (
        /* Balances have not loaded -- a slow RPC, or an account with nothing in
           it. Either way there is no asset to pick, and an empty picker above a
           disabled button explains nothing. */
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="font-serif text-lg text-(--color-ink)">Nothing to send yet</p>
          <p className="max-w-[240px] text-xs leading-relaxed text-(--color-slate)">
            This account holds no assets on {status.chain.name}, or balances are still loading.
            Receive something first.
          </p>
        </div>
      ) : null}

      {step === "compose" && holdings.length > 0 ? (
        <ComposeStep
          holdings={holdings}
          asset={asset}
          onSelectAsset={setSelectedSymbol}
          recipientInput={recipientInput}
          onRecipientChange={setRecipientInput}
          resolution={resolution}
          isResolving={isResolving}
          amountInput={amountInput}
          onAmountChange={setAmountInput}
          exceedsBalance={exceedsBalance}
          onMax={() => void fillMax()}
          busy={busy}
          error={error}
          canContinue={canContinue}
          onContinue={() => void goToReview()}
        />
      ) : null}

      {step === "review" && prepared ? (
        <ReviewStep
          prepared={prepared}
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onBack={() => void backToCompose()}
        />
      ) : null}

      {step === "sent" && transactionHash ? (
        <SentStep transactionHash={transactionHash} explorerUrl={explorerUrl} onDone={onBack} />
      ) : null}
    </motion.div>
  );
}

interface ComposeStepProps {
  holdings: readonly PortfolioEntryResult[];
  asset: PortfolioEntryResult | undefined;
  onSelectAsset: (symbol: string) => void;
  recipientInput: string;
  onRecipientChange: (value: string) => void;
  resolution: RecipientResolution | undefined;
  isResolving: boolean;
  amountInput: string;
  onAmountChange: (value: string) => void;
  exceedsBalance: boolean;
  onMax: () => void;
  busy: boolean;
  error: string | undefined;
  canContinue: boolean;
  onContinue: () => void;
}

function ComposeStep({
  holdings,
  asset,
  onSelectAsset,
  recipientInput,
  onRecipientChange,
  resolution,
  isResolving,
  amountInput,
  onAmountChange,
  exceedsBalance,
  onMax,
  busy,
  error,
  canContinue,
  onContinue,
}: ComposeStepProps) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Field label="Asset">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {holdings.map((holding) => (
            <button
              key={holding.symbol}
              type="button"
              onClick={() => onSelectAsset(holding.symbol)}
              className="flex flex-none items-center gap-2 rounded-(--radius-pill) border px-3 py-1.5"
              style={{
                borderColor:
                  holding.symbol === asset?.symbol ? "var(--color-ink)" : "var(--color-line)",
              }}
            >
              <AssetAvatar symbol={holding.symbol} size={18} />
              <span className="text-xs text-(--color-ink)">{holding.symbol}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="To"
        error={
          resolution?.kind === "invalid"
            ? resolution.message
            : resolution?.kind === "unresolved"
              ? resolution.reason === "names_unavailable"
                ? "Names cannot be looked up on this network."
                : "That name has no address set."
              : undefined
        }
      >
        <TextInput
          value={recipientInput}
          onChange={onRecipientChange}
          placeholder="0x... or name.eth"
          autoFocus
        />
      </Field>

      {isResolving ? <Spinner label="Checking recipient" /> : null}
      {resolution?.kind === "name" ? <ResolvedName resolution={resolution} /> : null}

      <Field
        label="Amount"
        hint={asset ? `Balance ${asset.balanceLabel} ${asset.symbol}` : undefined}
        error={exceedsBalance ? "That is more than this account holds." : undefined}
      >
        <div className="flex items-center gap-2">
          <TextInput value={amountInput} onChange={onAmountChange} placeholder="0.0" />
          <button
            type="button"
            onClick={onMax}
            className="flex-none rounded-(--radius-field) border border-(--color-line) px-3 py-2.5 text-xs text-(--color-ink)"
          >
            Max
          </button>
        </div>
      </Field>

      {error ? (
        <Callout tone="danger" title="Cannot continue">
          {error}
        </Callout>
      ) : null}

      <div className="mt-auto">
        <PrimaryButton onClick={onContinue} disabled={!canContinue}>
          {busy ? "Preparing..." : "Review"}
        </PrimaryButton>
      </div>
    </div>
  );
}

/**
 * A resolved name, showing the NORMALISED form and the address it maps to.
 *
 * Both are shown because neither alone is enough: the name is what the user
 * meant, and the address is the only part that is self-verifying. When
 * normalisation changed what was typed the difference is called out -- usually
 * innocent case folding, but it is also what a homograph substitution looks
 * like from here, and the user is the only one who can tell which.
 */
function ResolvedName({
  resolution,
}: {
  resolution: Extract<RecipientResolution, { kind: "name" }>;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-(--radius-card) bg-(--color-muted) px-3 py-2">
      <span className="text-xs text-(--color-ink)">
        {abbreviateEnsName(resolution.normalizedName)}
      </span>
      <AddressChip address={resolution.address} full />
      {resolution.wasNormalized ? (
        <span className="text-[11px] text-(--color-slate)">
          Resolved as {resolution.normalizedName} -- check this is the name you meant.
        </span>
      ) : null}
    </div>
  );
}

function ReviewStep({
  prepared,
  busy,
  error,
  onConfirm,
  onBack,
}: {
  prepared: PrepareSendResult;
  busy: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const { presentation } = prepared;
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="rounded-(--radius-card) bg-(--color-muted) px-3 py-4 text-center">
        <p className="numeric font-serif text-2xl text-(--color-ink)">{prepared.transferLabel}</p>
      </div>

      {presentation.recipient ? <Row label="To" value={presentation.recipient} mono /> : null}
      {/* Both fee figures, always. Showing only the maximum makes the wallet
          look expensive; showing only the expected cost hides the real worst
          case. Naming both is the only honest presentation. */}
      <Row label="Estimated fee" value={presentation.expectedFeeLabel} />
      <Row label="Maximum fee" value={presentation.maximumFeeLabel} />
      <Row label="Network" value={presentation.chain.name} />
      <Row label="Nonce" value={String(presentation.nonce)} />

      {!presentation.isFeeEstimated ? (
        <Callout tone="warning" title="Fee is approximate">
          This account could not be simulated, so the fee above is a typical figure rather than a
          measurement of this transaction.
        </Callout>
      ) : null}

      {presentation.isBlindSigning ? (
        <Callout tone="danger" title="The wallet cannot read this">
          This transaction&apos;s data could not be decoded, so no one can tell you exactly what it
          will do.
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" title="Not sent">
          {error}
        </Callout>
      ) : null}

      <div className="mt-auto flex flex-col gap-2">
        <PrimaryButton onClick={onConfirm} disabled={busy}>
          {busy ? "Sending..." : "Confirm and send"}
        </PrimaryButton>
        <div className="text-center">
          <TextButton onClick={onBack}>Back</TextButton>
        </div>
      </div>
    </div>
  );
}

function SentStep({
  transactionHash,
  explorerUrl,
  onDone,
}: {
  transactionHash: string;
  explorerUrl: string | undefined;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="font-serif text-xl text-(--color-ink)">On its way</p>
        <p className="max-w-[250px] text-xs leading-relaxed text-(--color-slate)">
          It will appear in Activity as soon as it is included in a block. That usually takes a few
          seconds.
        </p>
        <p className="max-w-[280px] font-mono text-[11px] break-all text-(--color-slate)">
          {transactionHash}
        </p>
        {explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-(--color-slate) underline underline-offset-2"
          >
            View on the block explorer
          </a>
        ) : null}
      </div>
      <SecondaryButton onClick={onDone}>Done</SecondaryButton>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-(--color-line) pb-2">
      <span className="text-xs text-(--color-slate)">{label}</span>
      <span
        className={`text-right text-xs break-all text-(--color-ink) ${mono ? "font-mono" : "numeric"}`}
      >
        {value}
      </span>
    </div>
  );
}
