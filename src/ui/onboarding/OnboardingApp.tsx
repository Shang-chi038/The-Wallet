import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  createBackupChallenge,
  verifyBackupResponse,
  type BackupChallenge,
} from "@/core/mnemonic/backupVerification";
import {
  getMnemonicWordCount,
  normalizeMnemonicPhrase,
  validateMnemonicPhrase,
} from "@/core/mnemonic/mnemonicPhrase";
import { MINIMUM_PASSWORD_LENGTH } from "@/core/wallet/passwordPolicy";
import {
  Callout,
  Field,
  PasswordInput,
  PhraseTextArea,
  PrimaryButton,
  SecondaryButton,
  TextButton,
  TextInput,
} from "../components/forms";
import { walletClient, WalletRequestError } from "../shared/walletClient";

/**
 * Onboarding.
 *
 * ===========================================================================
 * WHY THIS IS A FULL TAB
 * ===========================================================================
 * A popup closes on any outside click. During seed backup that means losing the
 * only copy of a phrase the user has not yet written down -- an unrecoverable
 * loss caused by a stray click. A tab also shows the extension origin in the
 * URL bar, which is what lets someone tell a real setup flow from a phishing
 * page imitating one.
 *
 * ===========================================================================
 * WHAT THIS PAGE HOLDS, AND FOR HOW LONG
 * ===========================================================================
 * The recovery phrase lives in this component's state for exactly as long as it
 * takes the user to write it down and prove they did. It is dropped the moment
 * setup completes. That is not a strong guarantee -- JavaScript cannot erase a
 * string from the heap, and this page is a renderer we do not control the GC of
 * -- which is precisely why the phrase is shown ONCE and never returned again
 * without a fresh password check (see WalletService.revealMnemonic).
 *
 * There is deliberately no copy-to-clipboard button. The clipboard is readable
 * by every other application on the machine and by any extension with clipboard
 * access, and it persists long after this tab is closed. Typing twelve words is
 * the cost of the backup being a backup.
 */

type Step =
  | { name: "choose" }
  | { name: "password"; mode: "create" | "restore" }
  | { name: "restore" }
  | { name: "backup" }
  | { name: "verify" }
  | { name: "done" };

export function OnboardingApp() {
  // Deep link from the popup's "forgot password" affordance, so that route
  // lands on restore instead of making the user find it again.
  const initialStep: Step =
    typeof window !== "undefined" && window.location.hash === "#restore"
      ? { name: "password", mode: "restore" }
      : { name: "choose" };

  const [step, setStep] = useState<Step>(initialStep);
  const [password, setPassword] = useState("");
  const [wordCount, setWordCount] = useState<12 | 24>(12);
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reportError = (caught: unknown, fallback: string) => {
    if (caught instanceof WalletRequestError) {
      setError(caught.reason === "vault_already_exists"
        ? "A wallet already exists on this device. Reset it from Settings before creating another."
        : caught.message);
      return;
    }
    setError(fallback);
  };

  const createWallet = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await walletClient.create({
        password,
        strength: wordCount === 24 ? 256 : 128,
      });
      setMnemonic(result.mnemonic);
      setPassword("");
      setStep({ name: "backup" });
    } catch (caught) {
      reportError(caught, "Could not create the wallet.");
    } finally {
      setBusy(false);
    }
  };

  const restoreWallet = async (phrase: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.import({ password, mnemonic: phrase });
      setPassword("");
      setMnemonic("");
      setStep({ name: "done" });
    } catch (caught) {
      reportError(caught, "Could not restore the wallet.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 p-8">
      <AnimatePresence mode="wait">
        <motion.div
          key={step.name}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-6"
        >
          {step.name === "choose" ? (
            <ChooseStep
              onCreate={() => setStep({ name: "password", mode: "create" })}
              onRestore={() => setStep({ name: "password", mode: "restore" })}
            />
          ) : null}

          {step.name === "password" ? (
            <PasswordStep
              mode={step.mode}
              password={password}
              onPasswordChange={setPassword}
              wordCount={wordCount}
              onWordCountChange={setWordCount}
              busy={busy}
              error={error}
              onBack={() => {
                setError(undefined);
                setStep({ name: "choose" });
              }}
              onContinue={() => {
                if (step.mode === "create") void createWallet();
                else setStep({ name: "restore" });
              }}
            />
          ) : null}

          {step.name === "restore" ? (
            <RestoreStep
              busy={busy}
              error={error}
              onBack={() => {
                setError(undefined);
                setStep({ name: "password", mode: "restore" });
              }}
              onSubmit={(phrase) => void restoreWallet(phrase)}
            />
          ) : null}

          {step.name === "backup" ? (
            <BackupStep mnemonic={mnemonic} onContinue={() => setStep({ name: "verify" })} />
          ) : null}

          {step.name === "verify" ? (
            <VerifyStep
              mnemonic={mnemonic}
              onBack={() => setStep({ name: "backup" })}
              onVerified={() => {
                // The phrase leaves this page's state the moment it is no
                // longer needed. Weak as erasure goes, and still worth doing:
                // it shortens the window in which a rendering bug or an
                // extension-page compromise could reach it.
                setMnemonic("");
                setStep({ name: "done" });
              }}
            />
          ) : null}

          {step.name === "done" ? <DoneStep /> : null}
        </motion.div>
      </AnimatePresence>
    </main>
  );
}

function Heading({ title, body }: { title: string; body: string }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-serif text-3xl tracking-tight text-(--color-ink)">{title}</h1>
      <p className="text-sm leading-relaxed text-(--color-slate)">{body}</p>
    </header>
  );
}

function ChooseStep({ onCreate, onRestore }: { onCreate: () => void; onRestore: () => void }) {
  return (
    <>
      <Heading
        title="Set up your wallet"
        body="Everything stays on this device. There is no account, no email, and no way for anyone -- including us -- to recover it for you."
      />
      <div className="flex flex-col gap-3">
        <PrimaryButton onClick={onCreate}>Create a new wallet</PrimaryButton>
        <SecondaryButton onClick={onRestore}>I already have a recovery phrase</SecondaryButton>
      </div>
    </>
  );
}

function PasswordStep({
  mode,
  password,
  onPasswordChange,
  wordCount,
  onWordCountChange,
  busy,
  error,
  onBack,
  onContinue,
}: {
  mode: "create" | "restore";
  password: string;
  onPasswordChange: (value: string) => void;
  wordCount: 12 | 24;
  onWordCountChange: (value: 12 | 24) => void;
  busy: boolean;
  error: string | undefined;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const tooShort = password.length > 0 && password.length < MINIMUM_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== password;
  const canContinue =
    !busy && password.length >= MINIMUM_PASSWORD_LENGTH && confirmation === password;

  return (
    <>
      <Heading
        title="Choose a password"
        body="This password encrypts your wallet on this device. It is not a recovery method -- if you forget it, only your recovery phrase can get you back in."
      />

      <div className="flex flex-col gap-4">
        <Field
          label="Password"
          hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters. Length matters far more than symbols -- a short passphrase of real words beats "Pa55w0rd!".`}
          error={tooShort ? `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.` : undefined}
        >
          <PasswordInput
            value={password}
            onChange={onPasswordChange}
            placeholder="Password"
            autoFocus
            autoComplete="new-password"
          />
        </Field>

        <Field label="Confirm password" error={mismatch ? "These do not match." : undefined}>
          <PasswordInput
            value={confirmation}
            onChange={setConfirmation}
            placeholder="Password again"
            autoComplete="new-password"
            onSubmit={() => {
              if (canContinue) onContinue();
            }}
          />
        </Field>

        {mode === "create" ? (
          <Field
            label="Recovery phrase length"
            hint="Twelve words is the standard and is what most wallets restore from. Twenty-four is stronger on paper and harder to write down accurately."
          >
            <div className="flex gap-2">
              {([12, 24] as const).map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => onWordCountChange(count)}
                  className="flex-1 rounded-(--radius-field) border px-3 py-2 text-sm"
                  style={{
                    borderColor:
                      wordCount === count ? "var(--color-ink)" : "var(--color-line)",
                    color: wordCount === count ? "var(--color-ink)" : "var(--color-slate)",
                  }}
                >
                  {count} words
                </button>
              ))}
            </div>
          </Field>
        ) : null}

        {error ? (
          <Callout tone="danger" title="Could not continue">
            {error}
          </Callout>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <PrimaryButton onClick={onContinue} disabled={!canContinue}>
          {busy ? "Creating..." : "Continue"}
        </PrimaryButton>
        <div className="text-center">
          <TextButton onClick={onBack}>Back</TextButton>
        </div>
      </div>
    </>
  );
}

function RestoreStep({
  busy,
  error,
  onBack,
  onSubmit,
}: {
  busy: boolean;
  error: string | undefined;
  onBack: () => void;
  onSubmit: (phrase: string) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const normalized = useMemo(() => normalizeMnemonicPhrase(phrase), [phrase]);
  const words = normalized === "" ? 0 : getMnemonicWordCount(normalized);

  /**
   * Validated in the browser before it is sent anywhere.
   *
   * BIP-39 phrases carry a checksum, so a mistyped or misremembered word is
   * detectable locally -- and telling the user immediately is far kinder than
   * silently creating a DIFFERENT wallet that happens to be valid and is empty.
   * That failure has no error message anywhere in the system; the user just
   * finds their funds missing and assumes the wallet lost them.
   */
  const isComplete = words === 12 || words === 15 || words === 18 || words === 21 || words === 24;
  const isValid = isComplete && validateMnemonicPhrase(normalized);
  const showChecksumError = isComplete && !isValid;

  return (
    <>
      <Heading
        title="Enter your recovery phrase"
        body="Twelve or twenty-four words, in order, separated by spaces. Capitalisation does not matter."
      />

      <div className="flex flex-col gap-4">
        <Field
          label="Recovery phrase"
          hint={words > 0 ? `${words} words entered` : undefined}
          error={
            showChecksumError
              ? "That phrase is not valid. One of the words is likely misspelled or out of order."
              : undefined
          }
        >
          <PhraseTextArea
            value={phrase}
            onChange={setPhrase}
            placeholder="abandon abandon abandon ..."
          />
        </Field>

        <Callout tone="warning" title="Only type this here">
          A real wallet asks for your recovery phrase during setup and never again. Check the
          address bar says this extension, not a website.
        </Callout>

        {error ? (
          <Callout tone="danger" title="Could not restore">
            {error}
          </Callout>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <PrimaryButton onClick={() => onSubmit(normalized)} disabled={!isValid || busy}>
          {busy ? "Restoring..." : "Restore wallet"}
        </PrimaryButton>
        <div className="text-center">
          <TextButton onClick={onBack}>Back</TextButton>
        </div>
      </div>
    </>
  );
}

function BackupStep({ mnemonic, onContinue }: { mnemonic: string; onContinue: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const words = mnemonic.split(" ");

  return (
    <>
      <Heading
        title="Write down your recovery phrase"
        body="These words ARE your wallet. Anyone who has them can take everything in it, and nobody can restore them for you if they are lost."
      />

      <Callout tone="danger" title="No copy button, on purpose">
        The clipboard is readable by other applications and persists after this tab closes. Write
        these words on paper, in order. Do not photograph them, and do not store them in a notes app.
      </Callout>

      {/* Blurred until the user asks. Someone may be setting this up in an
          office, on a call, or with a screen recorder running -- revealing the
          phrase the instant the page loads gives them no chance to decide the
          room is safe first. */}
      <div className="relative">
        <ol className="grid grid-cols-3 gap-2 rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-4">
          {words.map((word, index) => (
            <li
              key={`${index}-${word}`}
              className="flex items-baseline gap-2 font-mono text-sm text-(--color-ink)"
              style={{ filter: revealed ? "none" : "blur(6px)" }}
            >
              <span className="w-5 text-right text-[10px] text-(--color-faint)">{index + 1}</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        {!revealed ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="absolute inset-0 flex items-center justify-center rounded-(--radius-card) bg-(--color-bg)/40 text-sm font-medium text-(--color-ink)"
          >
            Tap to reveal
          </button>
        ) : null}
      </div>

      <PrimaryButton onClick={onContinue} disabled={!revealed}>
        I have written it down
      </PrimaryButton>
    </>
  );
}

/**
 * Backup verification.
 *
 * The point is not to test the user. It is to catch the case where they clicked
 * "I have written it down" without writing anything down -- which is common,
 * and only becomes visible years later when they need the phrase and do not
 * have it. Asking for three words at random positions is enough to make
 * skipping the step impossible without noticing.
 */
function VerifyStep({
  mnemonic,
  onBack,
  onVerified,
}: {
  mnemonic: string;
  onBack: () => void;
  onVerified: () => void;
}) {
  const [challenge] = useState<BackupChallenge>(() => createBackupChallenge({ phrase: mnemonic }));
  const [responses, setResponses] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState(false);

  const allAnswered = challenge.wordPositions.every(
    (position) => (responses[position] ?? "").trim() !== "",
  );

  const check = () => {
    if (verifyBackupResponse({ phrase: mnemonic, challenge, responses })) {
      onVerified();
      return;
    }
    setFailed(true);
  };

  return (
    <>
      <Heading
        title="Confirm your backup"
        body="Enter the words at these positions from the phrase you just wrote down."
      />

      <div className="flex flex-col gap-4">
        {challenge.wordPositions.map((position) => (
          <Field key={position} label={`Word ${position + 1}`}>
            <TextInput
              value={responses[position] ?? ""}
              onChange={(value) => {
                setFailed(false);
                setResponses((current) => ({ ...current, [position]: value }));
              }}
              placeholder={`Word ${position + 1}`}
              onSubmit={() => {
                if (allAnswered) check();
              }}
            />
          </Field>
        ))}

        {failed ? (
          <Callout tone="danger" title="That is not quite right">
            Check the phrase you wrote down against the numbered positions. You can go back and view
            it again.
          </Callout>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <PrimaryButton onClick={check} disabled={!allAnswered}>
          Confirm
        </PrimaryButton>
        <div className="text-center">
          <TextButton onClick={onBack}>Show me the phrase again</TextButton>
        </div>
      </div>
    </>
  );
}

function DoneStep() {
  return (
    <>
      <Heading
        title="Your wallet is ready"
        body="Open it from the extensions menu in your toolbar. Pin it there so it is one click away when a site asks to connect."
      />
      <Callout tone="neutral" title="What happens next">
        The wallet starts on a test network so you can try sending before real money is involved.
        Switch to Ethereum from the network picker when you are ready.
      </Callout>
      <PrimaryButton onClick={() => window.close()}>Done</PrimaryButton>
    </>
  );
}
