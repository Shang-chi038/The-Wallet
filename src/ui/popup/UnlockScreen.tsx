import { useState } from "react";
import { motion } from "framer-motion";
import { Icon, ICON_PATHS } from "../components";
import { PasswordInput, PrimaryButton, TextButton } from "../components/forms";
import { walletClient, WalletRequestError } from "../shared/walletClient";

/**
 * Unlock.
 *
 * ===========================================================================
 * WHY THE ERROR IS DELIBERATELY UNHELPFUL
 * ===========================================================================
 * A wrong password says only "that password is not correct". No hint about
 * length, no "close, check your caps lock", no attempt counter. Anything more
 * specific is a free oracle for whoever is holding the laptop that is not its
 * owner, and the person who genuinely forgot their password is not helped by a
 * hint either -- they are helped by the recovery phrase, which is why that
 * route is offered right below.
 *
 * The unlock itself is slow on purpose: ~750ms of memory-hard KDF. The spinner
 * exists so that latency reads as work rather than as a hung popup.
 */
export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    if (password === "" || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.unlock(password);
      setPassword("");
      onUnlocked();
    } catch (caught) {
      setError(
        caught instanceof WalletRequestError && caught.reason === "incorrect_password"
          ? "That password is not correct."
          : "Could not unlock the wallet.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col justify-center gap-5 px-6"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-(--color-muted) text-(--color-slate)">
          <Icon path={ICON_PATHS.lock} size={18} />
        </span>
        <h1 className="font-serif text-2xl text-(--color-ink)">Welcome back</h1>
        <p className="max-w-[240px] text-xs leading-relaxed text-(--color-slate)">
          Your wallet is locked. Unlock it to see your balances and approve requests.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder="Password"
          autoFocus
          onSubmit={() => void submit()}
        />
        {error ? (
          <span role="alert" className="text-xs text-(--color-danger)">
            {error}
          </span>
        ) : null}
      </div>

      <PrimaryButton onClick={() => void submit()} disabled={busy || password === ""}>
        {busy ? "Unlocking..." : "Unlock"}
      </PrimaryButton>

      <div className="text-center">
        <TextButton
          onClick={() => {
            // Full tab, not the popup: restoring means typing twelve words, and
            // a popup that closes on an outside click loses them mid-entry.
            void chrome.tabs.create({
              url: chrome.runtime.getURL("src/ui/onboarding/index.html#restore"),
            });
          }}
        >
          Forgot password? Restore with your recovery phrase
        </TextButton>
      </div>
    </motion.div>
  );
}
