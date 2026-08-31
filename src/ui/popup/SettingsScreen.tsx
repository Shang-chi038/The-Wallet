import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { OriginGrant } from "@/core/messaging/originPermissions";
import type {
  ImportedTokenSummary,
  LockSettingsResult,
  TokenClaimsResult,
  WalletStatusResult,
} from "@/core/messaging/walletApi";
import { isValidPrivateKey } from "@/core/account/ethereumAddress";
import { describeActivityTime } from "@/core/activity/transactionHistory";
import { MINIMUM_PASSWORD_LENGTH } from "@/core/wallet/passwordPolicy";
import { Icon, ICON_PATHS } from "../components";
import {
  AddressChip,
  Callout,
  Field,
  PasswordInput,
  PhraseTextArea,
  PrimaryButton,
  SecondaryButton,
  Spinner,
  TextButton,
  TextInput,
} from "../components/forms";
import { walletClient, WalletRequestError } from "../shared/walletClient";

/**
 * Settings.
 *
 * ===========================================================================
 * A FULL ROUTE, NOT A SHEET
 * ===========================================================================
 * Settings used to be a bottom sheet with one button in it. Everything below
 * -- revealing a recovery phrase, changing a password, pasting a private key,
 * resetting the wallet -- is multi-step and irreversible, and a sheet that
 * closes on a tap outside it is the wrong container for any of them. Send and
 * receive are full routes for the same reason.
 *
 * ===========================================================================
 * UNLOCKED IS NOT AUTHORISED
 * ===========================================================================
 * Two of these screens ask for the password again even though the wallet is
 * plainly unlocked. That is not friction for its own sake: an unlocked wallet
 * on an unattended laptop must not hand over the seed to whoever walks past.
 * The engine enforces it by re-deriving the KDF (WalletService.revealMnemonic
 * and changePassword); this screen simply provides the field.
 *
 * ===========================================================================
 * WHAT THIS SCREEN HOLDS
 * ===========================================================================
 * A revealed phrase and a pasted private key live in component state for as
 * long as the sub-page is mounted and no longer -- navigating away unmounts it
 * and drops the reference. Weak as erasure goes (JavaScript cannot scrub a
 * string), which is exactly why the phrase is never returned without a fresh
 * password and why closing the popup ends the session.
 *
 * There is deliberately no copy button on the recovery phrase, matching
 * onboarding: the clipboard is readable by every other application on the
 * machine and outlives the window that filled it.
 */

type SettingsPage =
  | "index"
  | "revealPhrase"
  | "changePassword"
  | "autoLock"
  | "connectedSites"
  | "importAccount"
  | "tokens"
  | "addToken"
  | "resetWallet";

export interface SettingsScreenProps {
  status: WalletStatusResult;
  /** Back to the portfolio. */
  onBack: () => void;
  /** An account was added: re-read status, stay where we are. */
  onWalletChanged: () => void;
  /**
   * Lock or reset. The session is over, so the popup must leave settings as
   * well as refresh -- otherwise the next unlock lands the user back on a
   * settings sub-page they never asked to return to.
   */
  onSessionEnded: () => void;
}

export function SettingsScreen({
  status,
  onBack,
  onWalletChanged,
  onSessionEnded,
}: SettingsScreenProps) {
  const [page, setPage] = useState<SettingsPage>("index");
  const [connections, setConnections] = useState<OriginGrant[] | undefined>();
  const [lockSettings, setLockSettings] = useState<LockSettingsResult | undefined>();

  // Held here rather than in the connected-sites page so the index row can show
  // the count, and so a revoke updates both at once.
  const loadConnections = useCallback(async () => {
    try {
      const result = await walletClient.listConnections();
      setConnections(result.connections);
    } catch {
      // A count is not worth an error banner. The connected-sites page reports
      // its own failure, where there is something the user can act on.
      setConnections(undefined);
    }
  }, []);

  // Same shape as the connection count, and for the same reason: the index row
  // shows the current interval, so it has to be known before the sub-page is
  // opened.
  const loadLockSettings = useCallback(async () => {
    try {
      setLockSettings(await walletClient.getLockSettings());
    } catch {
      setLockSettings(undefined);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
    void loadLockSettings();
  }, [loadConnections, loadLockSettings]);

  const toIndex = () => setPage("index");

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col overflow-y-auto px-4 pt-4 pb-5"
    >
      {page === "index" ? (
        <SettingsIndex
          status={status}
          connectionCount={connections?.length}
          lockSettings={lockSettings}
          onBack={onBack}
          onOpen={setPage}
          onSessionEnded={onSessionEnded}
        />
      ) : null}

      {page === "revealPhrase" ? (
        <RevealPhrasePage status={status} onBack={toIndex} onSessionExpired={onSessionEnded} />
      ) : null}

      {page === "changePassword" ? (
        <ChangePasswordPage onBack={toIndex} onSessionExpired={onSessionEnded} />
      ) : null}

      {page === "autoLock" ? (
        <AutoLockPage
          settings={lockSettings}
          onBack={toIndex}
          onChanged={setLockSettings}
          onSessionExpired={onSessionEnded}
        />
      ) : null}

      {page === "connectedSites" ? (
        <ConnectedSitesPage
          connections={connections}
          onBack={toIndex}
          onRevoked={() => {
            void loadConnections();
          }}
          onReload={() => {
            void loadConnections();
          }}
        />
      ) : null}

      {page === "importAccount" ? (
        <ImportAccountPage
          onBack={toIndex}
          onImported={onWalletChanged}
          onSessionExpired={onSessionEnded}
        />
      ) : null}

      {page === "tokens" ? (
        <TokensPage
          onBack={toIndex}
          onAdd={() => setPage("addToken")}
          onChanged={onWalletChanged}
          onSessionExpired={onSessionEnded}
        />
      ) : null}

      {page === "addToken" ? (
        <AddTokenPage
          chainName={status.chain.name}
          onBack={() => setPage("tokens")}
          onAdded={() => {
            onWalletChanged();
            setPage("tokens");
          }}
          onSessionExpired={onSessionEnded}
        />
      ) : null}

      {page === "resetWallet" ? (
        <ResetWalletPage onBack={toIndex} onReset={onSessionEnded} />
      ) : null}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function SettingsIndex({
  status,
  connectionCount,
  lockSettings,
  onBack,
  onOpen,
  onSessionEnded,
}: {
  status: WalletStatusResult;
  connectionCount: number | undefined;
  lockSettings: LockSettingsResult | undefined;
  onBack: () => void;
  onOpen: (page: SettingsPage) => void;
  onSessionEnded: () => void;
}) {
  const importedCount = status.accounts.filter((account) => account.source === "privateKey").length;

  return (
    <>
      <PageHeader title="Settings" onBack={onBack} />

      <SectionLabel>Security</SectionLabel>
      <NavigationRow
        title="Recovery phrase"
        detail="Password required"
        onClick={() => onOpen("revealPhrase")}
      />
      <NavigationRow title="Change password" onClick={() => onOpen("changePassword")} />
      <NavigationRow
        title="Auto-lock"
        detail={
          lockSettings ? describeAutoLockInterval(lockSettings.autoLockAfterMinutes) : undefined
        }
        onClick={() => onOpen("autoLock")}
      />

      <SectionLabel>Connections</SectionLabel>
      <NavigationRow
        title="Connected sites"
        detail={connectionCount === undefined ? undefined : String(connectionCount)}
        onClick={() => onOpen("connectedSites")}
      />

      <SectionLabel>Accounts</SectionLabel>
      <NavigationRow
        title="Import an account"
        detail={importedCount > 0 ? `${importedCount} imported` : undefined}
        onClick={() => onOpen("importAccount")}
      />

      <SectionLabel>Tokens</SectionLabel>
      <NavigationRow title="Tokens you added" onClick={() => onOpen("tokens")} />

      <SectionLabel>Danger zone</SectionLabel>
      <NavigationRow title="Reset this wallet" tone="danger" onClick={() => onOpen("resetWallet")} />

      <div className="mt-6 flex flex-col gap-3">
        <SecondaryButton
          onClick={() => {
            void walletClient.lock().then(onSessionEnded);
          }}
        >
          Lock wallet
        </SecondaryButton>
        <p className="text-xs leading-relaxed text-(--color-slate)">
          Locking clears every secret from memory. You will need your password again.
        </p>
      </div>

      <div className="flex-1" />

      <FinePrint>
        This wallet runs entirely in this browser profile. There is no account and no server, so
        nobody -- including us -- can unlock it, move funds from it, or recover it for you.
        {extensionVersion() ? ` Version ${extensionVersion() ?? ""}.` : ""}
      </FinePrint>
    </>
  );
}

/**
 * The manifest version, when there is a manifest.
 *
 * `chrome.*` is undefined under `vite preview`, which is where the screens get
 * looked at during design work. A settings screen that throws there is a
 * settings screen nobody reviews.
 */
function extensionVersion(): string | undefined {
  if (typeof chrome === "undefined" || !chrome.runtime?.getManifest) return undefined;
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/**
 * How long the wallet stays unlocked while idle.
 *
 * The one screen here that is a PREFERENCE rather than an operation, so it
 * saves on selection rather than behind a "Save" button: there is nothing to
 * review and nothing to undo, and a two-step flow for a radio list is the kind
 * of friction that stops people setting it at all.
 *
 * It writes through immediately for a second reason. Someone who shortens the
 * interval is usually about to walk away from the machine, and a setting that
 * applied only from the next unlock would miss the exact session they were
 * worried about. The engine re-arms the alarm on write -- see the `onChanged`
 * hook in serviceWorker.ts.
 */
function AutoLockPage({
  settings,
  onBack,
  onChanged,
  onSessionExpired,
}: {
  settings: LockSettingsResult | undefined;
  onBack: () => void;
  onChanged: (settings: LockSettingsResult) => void;
  onSessionExpired: () => void;
}) {
  const [busyMinutes, setBusyMinutes] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function choose(minutes: number) {
    if (minutes === settings?.autoLockAfterMinutes) return;
    setBusyMinutes(minutes);
    setError(undefined);
    try {
      onChanged(await walletClient.updateLockSettings({ autoLockAfterMinutes: minutes }));
    } catch (caught) {
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, "That interval could not be saved."));
    } finally {
      setBusyMinutes(undefined);
    }
  }

  return (
    <>
      <PageHeader title="Auto-lock" onBack={onBack} />

      <p className="mb-4 text-xs leading-relaxed text-(--color-slate)">
        The wallet locks itself after this much time without use, and you will need your password
        again. Shorter is safer on a machine other people can reach.
      </p>

      {settings === undefined ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading" />
        </div>
      ) : (
        settings.choices.map((minutes) => (
          <ChoiceRow
            key={minutes}
            label={describeAutoLockInterval(minutes)}
            selected={minutes === settings.autoLockAfterMinutes}
            busy={minutes === busyMinutes}
            onClick={() => {
              void choose(minutes);
            }}
          />
        ))
      )}

      {error ? (
        <div className="mt-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}

      <FinePrint>
        The wallet also locks whenever the browser shuts the extension down, which it does on its
        own within a minute or two of inactivity -- so in practice it usually locks sooner than
        this. That is the browser erasing the keys from memory, and it is the strongest protection
        this wallet has.
      </FinePrint>
    </>
  );
}

/** Minutes, in words. "1 minute" reads better than "1 minutes". */
function describeAutoLockInterval(minutes: number): string {
  if (minutes === 1) return "1 minute";
  if (minutes === 60) return "1 hour";
  return `${minutes} minutes`;
}

/** A radio row: current value on the left, tick on the right. */
function ChoiceRow({
  label,
  selected,
  busy,
  onClick,
}: {
  label: string;
  selected: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-between gap-3 border-t border-(--color-line) py-3 text-left hover:bg-(--color-muted) disabled:opacity-60"
    >
      <span className="text-sm text-(--color-ink)">{label}</span>
      {busy ? (
        <Spinner label="Saving" />
      ) : selected ? (
        <span className="text-(--color-ink)">
          <Icon path={ICON_PATHS.check} size={15} />
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Recovery phrase
// ---------------------------------------------------------------------------

function RevealPhrasePage({
  status,
  onBack,
  onSessionExpired,
}: {
  status: WalletStatusResult;
  onBack: () => void;
  onSessionExpired: () => void;
}) {
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const hasImportedAccounts = status.accounts.some((account) => account.source === "privateKey");

  const reveal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await walletClient.revealMnemonic(password);
      // The password has done its job. Holding it any longer buys nothing and
      // widens the window in which a rendering bug could reach it.
      setPassword("");
      setMnemonic(result.mnemonic);
    } catch (caught) {
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, "Could not show the recovery phrase."));
    } finally {
      setBusy(false);
    }
  };

  if (mnemonic === "") {
    return (
      <>
        <PageHeader title="Recovery phrase" onBack={onBack} />

        <div className="flex flex-col gap-4">
          <Callout tone="danger" title="These words are your wallet">
            Anyone who reads them can take everything in it, on any device. Make sure nobody is
            watching your screen, and that no call is being recorded or shared.
          </Callout>

          <Field
            label="Password"
            hint="Being unlocked is not enough. The phrase is only shown to someone who can type the password now."
            error={error}
          >
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder="Password"
              autoFocus
              autoComplete="current-password"
              onSubmit={() => {
                if (password !== "" && !busy) void reveal();
              }}
            />
          </Field>

          <PrimaryButton onClick={() => void reveal()} disabled={password === "" || busy}>
            {busy ? "Checking..." : "Show recovery phrase"}
          </PrimaryButton>
        </div>
      </>
    );
  }

  const words = mnemonic.split(" ");

  return (
    <>
      <PageHeader title="Recovery phrase" onBack={onBack} />

      <div className="flex flex-col gap-4">
        <Callout tone="danger" title="No copy button, on purpose">
          The clipboard is readable by other applications and persists after this window closes.
          Write these words on paper, in order. Do not photograph them, and do not store them in a
          notes app.
        </Callout>

        {/* Blurred until asked for, the same as onboarding: opening this page is
            not the same act as deciding the room is safe. */}
        <div className="relative">
          <ol className="grid grid-cols-3 gap-2 rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3">
            {words.map((word, index) => (
              <li
                key={`${index}-${word}`}
                className="flex items-baseline gap-1.5 font-mono text-xs text-(--color-ink)"
                style={{ filter: revealed ? "none" : "blur(6px)" }}
              >
                <span className="w-4 text-right text-[9px] text-(--color-faint)">{index + 1}</span>
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

        {/* The distinction `WalletAccountSummary.source` exists to carry. A user
            who backs up this phrase and assumes an imported key is covered by it
            loses that key, and finds out years later. */}
        {hasImportedAccounts ? (
          <Callout tone="warning" title="This phrase does not cover everything">
            Accounts you imported from a private key are not derived from these words and cannot be
            restored with them. Back up each imported key separately.
          </Callout>
        ) : null}

        <PrimaryButton
          onClick={() => {
            // Dropped the moment it is no longer on screen.
            setMnemonic("");
            setRevealed(false);
            onBack();
          }}
        >
          Done
        </PrimaryButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

function ChangePasswordPage({
  onBack,
  onSessionExpired,
}: {
  onBack: () => void;
  onSessionExpired: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const tooShort = nextPassword.length > 0 && nextPassword.length < MINIMUM_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== nextPassword;
  const canSubmit =
    !busy &&
    currentPassword !== "" &&
    nextPassword.length >= MINIMUM_PASSWORD_LENGTH &&
    confirmation === nextPassword;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.changePassword({ currentPassword, nextPassword });
      setCurrentPassword("");
      setNextPassword("");
      setConfirmation("");
      setChanged(true);
    } catch (caught) {
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, "Could not change the password."));
    } finally {
      setBusy(false);
    }
  };

  if (changed) {
    return (
      <>
        <PageHeader title="Change password" onBack={onBack} />
        <div className="flex flex-col gap-4">
          <Callout tone="neutral" title="Password changed">
            The wallet is still unlocked. Your new password is what unlocks it from now on, on this
            device.
          </Callout>
          <PrimaryButton onClick={onBack}>Done</PrimaryButton>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Change password" onBack={onBack} />

      <div className="flex flex-col gap-4">
        {/* People conflate the two constantly, and the conflation is expensive
            in both directions: they either think a new password invalidates
            their written-down phrase, or they think changing it protects them
            after the phrase has leaked. Neither is true. */}
        <Callout tone="neutral" title="Your recovery phrase does not change">
          This password only unlocks the wallet on this device. The phrase you wrote down still
          restores it anywhere, and still needs to be kept secret.
        </Callout>

        <Field label="Current password">
          <PasswordInput
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="Current password"
            autoFocus
            autoComplete="current-password"
          />
        </Field>

        <Field
          label="New password"
          hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters. Length matters far more than symbols.`}
          error={tooShort ? `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.` : undefined}
        >
          <PasswordInput
            value={nextPassword}
            onChange={setNextPassword}
            placeholder="New password"
            autoComplete="new-password"
          />
        </Field>

        <Field label="Confirm new password" error={mismatch ? "These do not match." : undefined}>
          <PasswordInput
            value={confirmation}
            onChange={setConfirmation}
            placeholder="New password again"
            autoComplete="new-password"
            onSubmit={() => {
              if (canSubmit) void submit();
            }}
          />
        </Field>

        {error ? (
          <Callout tone="danger" title="Could not change the password">
            {error}
          </Callout>
        ) : null}

        <PrimaryButton onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "Changing..." : "Change password"}
        </PrimaryButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connected sites
// ---------------------------------------------------------------------------

function ConnectedSitesPage({
  connections,
  onBack,
  onRevoked,
  onReload,
}: {
  connections: OriginGrant[] | undefined;
  onBack: () => void;
  onRevoked: () => void;
  onReload: () => void;
}) {
  const [revoking, setRevoking] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const revoke = async (origin: string) => {
    setRevoking(origin);
    setError(undefined);
    try {
      await walletClient.revokeConnection(origin);
      onRevoked();
    } catch (caught) {
      setError(describeWalletError(caught, "Could not disconnect that site."));
    } finally {
      setRevoking(undefined);
    }
  };

  return (
    <>
      <PageHeader title="Connected sites" onBack={onBack} />

      {connections === undefined ? (
        <div className="flex flex-col gap-3 py-6">
          <div className="flex justify-center">
            <Spinner label="Loading" />
          </div>
          <div className="text-center">
            <TextButton onClick={onReload}>Try again</TextButton>
          </div>
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-(--color-slate)">
            No sites are connected. A site only ever sees the accounts you picked for it, and only
            after you approved that site by name.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {connections.map((grant) => (
            <div
              key={grant.origin}
              className="flex flex-col gap-2 border-t border-(--color-line) py-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  {/* Monospace and unabbreviated. The origin is the whole
                      security decision the user made, and a truncated one is
                      exactly what a lookalike domain needs to pass. */}
                  <span className="font-mono text-xs break-all text-(--color-ink)">
                    {grant.origin}
                  </span>
                  {/* Deliberately the activity list's formatter, so recency
                      reads identically in both places. `lastUsedAt` is written
                      by `grantOrigin` from this machine's clock, so the skew
                      floor that function applies is inert here. */}
                  <span className="text-[11px] text-(--color-slate)">
                    Last used {describeActivityTime(grant.lastUsedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(grant.origin)}
                  disabled={revoking === grant.origin}
                  className="shrink-0 text-xs font-medium text-(--color-danger) disabled:opacity-40"
                >
                  {revoking === grant.origin ? "Disconnecting..." : "Disconnect"}
                </button>
              </div>
              <div className="flex flex-col gap-0.5">
                {grant.accounts.map((address) => (
                  <AddressChip key={address} address={address} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="mt-4">
          <Callout tone="danger" title="Could not disconnect">
            {error}
          </Callout>
        </div>
      ) : null}

      <div className="flex-1" />

      <FinePrint>
        Disconnecting takes effect immediately and the site is told at once. It can ask to connect
        again, and you will be prompted by name if it does.
      </FinePrint>
    </>
  );
}

// ---------------------------------------------------------------------------
// Import an account
// ---------------------------------------------------------------------------

function ImportAccountPage({
  onBack,
  onImported,
  onSessionExpired,
}: {
  onBack: () => void;
  onImported: () => void;
  onSessionExpired: () => void;
}) {
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [importedAddress, setImportedAddress] = useState<string | undefined>();

  const trimmed = privateKey.trim();
  /**
   * Checked here before it is sent anywhere, the same way onboarding checks a
   * recovery phrase's checksum locally. A truncated paste is the common
   * mistake, and telling the user immediately is better than a round trip that
   * comes back with the same answer.
   *
   * This costs nothing in bundle terms: `ethereumAddress` is already in the
   * popup by way of ENS resolution on the send screen.
   */
  const looksValid = trimmed !== "" && isValidPrivateKey(trimmed);
  // Only complained about once the input is key-shaped. A truncated paste is
  // the common failure and this catches it at 60+ digits; an error that fired
  // on the first character would be on screen for the whole of a paste.
  const hexDigitCount = trimmed.replace(/^0x/i, "").length;
  const showFormatError = hexDigitCount >= 60 && !looksValid;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await walletClient.importPrivateKey(trimmed);
      // Dropped as soon as the engine has it.
      setPrivateKey("");
      setImportedAddress(result.account.address);
      onImported();
    } catch (caught) {
      // The one call here that genuinely requires an unlocked wallet, so the
      // one that reliably produces this.
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, "Could not import that key."));
    } finally {
      setBusy(false);
    }
  };

  if (importedAddress) {
    return (
      <>
        <PageHeader title="Import an account" onBack={onBack} />
        <div className="flex flex-col gap-4">
          <Callout tone="neutral" title="Account imported">
            <span className="font-mono break-all">{importedAddress}</span>
          </Callout>

          <Callout tone="warning" title="Back this key up separately">
            An imported account is not derived from your recovery phrase. Restoring from the phrase
            on another device will not bring it back.
          </Callout>

          <PrimaryButton onClick={onBack}>Done</PrimaryButton>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Import an account" onBack={onBack} />

      <div className="flex flex-col gap-4">
        {/* Said before the field, not after the import. Someone who learns this
            afterwards has already made the decision. */}
        <Callout tone="warning" title="Not covered by your recovery phrase">
          An imported key stands alone. Your recovery phrase will not restore it, so keep a
          separate backup of the key itself.
        </Callout>

        <Field
          label="Private key"
          hint="64 hexadecimal characters, with or without a leading 0x."
          error={
            showFormatError
              ? "That is not a valid private key. Check for a missing or extra character."
              : undefined
          }
        >
          {/* A textarea rather than a single-line input: it is monospace, it
              wraps so the whole key is visible, and autocorrect, autocapitalise
              and spellcheck are all off. A 64-character hex string "corrected"
              by the browser is a different key, and a different wallet, with no
              error to say so. */}
          <PhraseTextArea
            value={privateKey}
            onChange={setPrivateKey}
            placeholder="0x..."
          />
        </Field>

        <Callout tone="danger" title="Only paste a key you control">
          A private key is the account. Anyone who has it can move everything in that account, and
          a key sent to you by someone else is a trap -- they can empty it the moment you fund it.
        </Callout>

        {error ? (
          <Callout tone="danger" title="Could not import">
            {error}
          </Callout>
        ) : null}

        <PrimaryButton onClick={() => void submit()} disabled={!looksValid || busy}>
          {busy ? "Importing..." : "Import account"}
        </PrimaryButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The tokens the user added, and the way back out.
 *
 * Only imported ones are listed. The built-ins are not a list anybody manages
 * -- offering to remove USDC would imply the wallet might stop being able to
 * read it, which is not a thing that happens.
 */
function TokensPage({
  onBack,
  onAdd,
  onChanged,
  onSessionExpired,
}: {
  onBack: () => void;
  onAdd: () => void;
  onChanged: () => void;
  onSessionExpired: () => void;
}) {
  const [tokens, setTokens] = useState<ImportedTokenSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setTokens((await walletClient.listTokens()).tokens);
    } catch (caught) {
      setError(describeWalletError(caught, "Could not read your tokens."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (token: ImportedTokenSummary) => {
    setError(undefined);
    try {
      await walletClient.removeToken({ address: token.address, chainId: token.chainId });
      await load();
      onChanged();
    } catch (caught) {
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, "Could not remove that token."));
    }
  };

  return (
    <>
      <PageHeader title="Tokens you added" onBack={onBack} />

      {tokens === undefined ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-xs leading-relaxed text-(--color-slate)">
          You have not added any tokens. The wallet already reads the common ones on each network;
          add a token here if you hold one it does not show.
        </p>
      ) : (
        <div className="flex flex-col">
          {tokens.map((token) => (
            <div
              key={`${token.chainId}:${token.address}`}
              className="flex items-start justify-between gap-3 border-t border-(--color-line) py-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm text-(--color-ink)">
                  {token.symbol} <span className="text-(--color-slate)">{token.name}</span>
                </span>
                <span className="font-mono text-[11px] break-all text-(--color-slate)">
                  {token.address}
                </span>
                <span className="text-[11px] text-(--color-faint)">
                  {token.networkLabel} &middot; {token.decimals} decimals
                </span>
              </div>
              <button
                type="button"
                onClick={() => void remove(token)}
                className="shrink-0 text-xs font-medium text-(--color-danger)"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="mt-4">
          <Callout tone="danger" title="Something went wrong">
            {error}
          </Callout>
        </div>
      ) : null}

      <div className="mt-5">
        <PrimaryButton onClick={onAdd}>Add a token</PrimaryButton>
      </div>

      <div className="flex-1" />

      <FinePrint>
        Removing a token only stops this wallet showing it. Nothing moves, and nothing is lost --
        the balance stays on the chain and you can add the same address again.
      </FinePrint>
    </>
  );
}

/**
 * Adding one.
 *
 * ===========================================================================
 * LOOK UP, THEN ADD -- AND THE DECIMALS ARE THE REASON
 * ===========================================================================
 * The wallet reads `decimals()` off the contract and SHOWS it before anything
 * is stored, because that single number decides what every amount for this
 * token means. A contract claiming 6 while its balances are denominated in 18
 * turns a 1.00 send into a 1,000,000,000,000.00 one.
 *
 * The value displayed here is echoed back on import and checked against a fresh
 * read, so a contract cannot show the user one number and hand the wallet
 * another. That check is in the engine; this screen's job is to make sure a
 * human saw the number at all.
 */
function AddTokenPage({
  chainName,
  onBack,
  onAdded,
  onSessionExpired,
}: {
  chainName: string;
  onBack: () => void;
  onAdded: () => void;
  onSessionExpired: () => void;
}) {
  const [address, setAddress] = useState("");
  const [claims, setClaims] = useState<TokenClaimsResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const trimmed = address.trim();
  const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/.test(trimmed);

  const handle = async (run: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (caught) {
      if (isSessionExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(describeWalletError(caught, fallback));
    } finally {
      setBusy(false);
    }
  };

  const lookUp = () =>
    handle(async () => {
      setClaims(await walletClient.lookupToken({ address: trimmed }));
    }, "Could not read that contract.");

  const add = (found: TokenClaimsResult) =>
    handle(async () => {
      await walletClient.importToken({
        address: found.address,
        chainId: found.chainId,
        // The number the user just looked at, not one this screen chose.
        decimals: found.decimals,
      });
      onAdded();
    }, "Could not add that token.");

  if (claims) {
    return (
      <>
        <PageHeader title="Add a token" onBack={() => setClaims(undefined)} />

        <div className="flex flex-col gap-4">
          {/* Said before the values, not after. Someone who reads this
              afterwards has already agreed to them. */}
          <Callout tone="warning" title="These came from the contract">
            Everything below is what this contract says about itself. Anyone can deploy a contract
            using a familiar name, so check the address against the token&apos;s own website --
            never against a link that brought you here.
          </Callout>

          <div className="flex flex-col rounded-(--radius-card) border border-(--color-line) bg-(--color-card)">
            <ClaimRow label="Symbol" value={claims.symbol} />
            <ClaimRow label="Name" value={claims.name} />
            {/* The one that moves money, so it is spelled out rather than
                shown as a bare number. */}
            <ClaimRow
              label="Decimal places"
              value={String(claims.decimals)}
              note="Decides what 1.00 of this token means."
            />
            <ClaimRow label="Network" value={claims.networkLabel} />
            <ClaimRow label="Your balance" value={`${claims.balanceLabel} ${claims.symbol}`} />
          </div>

          <p className="font-mono text-[11px] break-all text-(--color-slate)">{claims.address}</p>

          {error ? (
            <Callout tone="danger" title="Could not add">
              {error}
            </Callout>
          ) : null}

          {claims.isKnown ? (
            <Callout tone="neutral" title="Already in your wallet">
              {claims.isBuiltIn
                ? "This wallet ships with this token, so there is nothing to add."
                : "You added this token already."}
            </Callout>
          ) : (
            <PrimaryButton onClick={() => void add(claims)} disabled={busy}>
              {busy ? "Adding..." : `Add ${claims.symbol}`}
            </PrimaryButton>
          )}

          <div className="text-center">
            <TextButton onClick={() => setClaims(undefined)}>Use a different address</TextButton>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Add a token" onBack={onBack} />

      <div className="flex flex-col gap-4">
        <Field
          label="Token contract address"
          hint={`On ${chainName}. The same token has a different address on every network, so an address copied from another chain will not work here.`}
          error={
            trimmed !== "" && !looksLikeAddress && trimmed.length >= 42
              ? "That is not a valid contract address."
              : undefined
          }
        >
          <PhraseTextArea value={address} onChange={setAddress} placeholder="0x..." />
        </Field>

        <Callout tone="warning" title="Get the address from the token itself">
          Take it from the project&apos;s own site or a block explorer. An address pasted from a
          message or a pop-up is how people end up holding a contract that merely borrowed a
          familiar name.
        </Callout>

        {error ? (
          <Callout tone="danger" title="Could not look that up">
            {error}
          </Callout>
        ) : null}

        <PrimaryButton onClick={() => void lookUp()} disabled={!looksLikeAddress || busy}>
          {busy ? "Reading contract..." : "Look up token"}
        </PrimaryButton>
      </div>
    </>
  );
}

function ClaimRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-(--color-line) px-3 py-2.5 last:border-b-0">
      <span className="flex flex-col">
        <span className="text-xs text-(--color-slate)">{label}</span>
        {note ? <span className="text-[10px] text-(--color-faint)">{note}</span> : null}
      </span>
      <span className="max-w-[55%] text-right text-sm break-words text-(--color-ink)">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

const RESET_CONFIRMATION = "RESET";

function ResetWalletPage({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const canSubmit = !busy && confirmation.trim().toUpperCase() === RESET_CONFIRMATION;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.reset();
      onReset();
    } catch (caught) {
      setError(describeWalletError(caught, "Could not reset the wallet."));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Reset this wallet" onBack={onBack} />

      <div className="flex flex-col gap-4">
        <Callout tone="danger" title="This erases the wallet from this device">
          The encrypted keys, every imported account and every site connection are deleted. Nothing
          about this can be undone, and no password will bring it back.
        </Callout>

        <p className="text-xs leading-relaxed text-(--color-slate)">
          Your funds are on the blockchain, not in this extension, so a wallet created from a
          recovery phrase can be restored anywhere with that phrase. If you do not have the phrase
          written down, resetting loses the funds permanently.
        </p>

        {/* A typed word, not a second button. A confirmation you can hit twice
            by reflex is not a confirmation. */}
        <Field
          label={`Type ${RESET_CONFIRMATION} to confirm`}
          error={error}
        >
          <TextInput
            value={confirmation}
            onChange={setConfirmation}
            placeholder={RESET_CONFIRMATION}
            autoFocus
            onSubmit={() => {
              if (canSubmit) void submit();
            }}
          />
        </Field>

        <PrimaryButton onClick={() => void submit()} disabled={!canSubmit} tone="danger">
          {busy ? "Resetting..." : "Reset this wallet"}
        </PrimaryButton>
        <div className="text-center">
          <TextButton onClick={onBack}>Keep my wallet</TextButton>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
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
      <h1 className="font-serif text-lg text-(--color-ink)">{title}</h1>
    </header>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-faint)">
      {children}
    </p>
  );
}

/**
 * One settings row.
 *
 * `danger` carries a colour AND sits under a section named "Danger zone",
 * because colour alone cannot carry severity for a colour-blind user -- the
 * same rule the change indicator and the callouts follow.
 */
function NavigationRow({
  title,
  detail,
  tone = "default",
  onClick,
}: {
  title: string;
  detail?: string | undefined;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-t border-(--color-line) py-3 text-left hover:bg-(--color-muted)"
    >
      <span
        className="text-sm"
        style={{ color: tone === "danger" ? "var(--color-danger)" : "var(--color-ink)" }}
      >
        {title}
      </span>
      <span className="flex items-center gap-1.5 text-(--color-faint)">
        {detail ? <span className="text-xs text-(--color-slate)">{detail}</span> : null}
        <Icon path={ICON_PATHS.chevronRight} size={13} />
      </span>
    </button>
  );
}

function FinePrint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 border-t border-(--color-line) pt-3 text-[10px] leading-relaxed text-(--color-faint)">
      {children}
    </p>
  );
}

/**
 * A settings action that comes back `vault_locked`.
 *
 * The worker was collected mid-flow -- which is likeliest on exactly these
 * screens, because the user is reading a warning and deciding whether the room
 * is safe rather than clicking. The session is over, so the popup must leave
 * settings: an inline error would strand the user on a form whose action cannot
 * succeed, with no unlock affordance anywhere on it.
 */
function isSessionExpired(caught: unknown): boolean {
  return caught instanceof WalletRequestError && caught.reason === "vault_locked";
}

/**
 * Engine failures, in words.
 *
 * Branches on `reason` -- the engine's own stable code -- and never on the
 * message text. Messages get reworded; a UI that string-matches them stops
 * recognising the case it was written for, silently, in a security flow.
 */
function describeWalletError(caught: unknown, fallback: string): string {
  if (!(caught instanceof WalletRequestError)) return fallback;
  switch (caught.reason) {
    case "incorrect_password":
      return "That password is not correct.";
    case "weak_password":
      return `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    case "invalid_private_key":
      return "That is not a valid private key.";
    case "token_not_readable":
      return "That address did not answer as a token contract. Check it is the token's contract address on this network -- not a wallet address, and not an address from a different chain.";
    case "token_metadata_changed":
      return "This contract reported different decimal places the second time it was asked. Nothing has been added.";
    case "duplicate_token":
      return "That token is already in your wallet.";
    case "invalid_token":
      return caught.message === "" ? "That token cannot be added." : caught.message;
    case "too_many_tokens":
      return caught.message;
    case "duplicate_account":
      // The engine's message names the address, which is the only part of this
      // the user cannot work out for themselves.
      return `${caught.message} Importing it again would add a second entry for the same funds.`;
    case "vault_locked":
      return "The wallet locked itself. Open it again and unlock to continue.";
    case "vault_not_found":
      return "There is no wallet on this device.";
    case "disconnected":
      return "The wallet is not responding. Close this window and open it again.";
    default:
      return caught.message === "" ? fallback : caught.message;
  }
}
