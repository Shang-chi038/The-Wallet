import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  ActivityResult,
  BitcoinActivityResult,
  BitcoinPortfolioResult,
  PortfolioResult,
  WalletStatusResult,
} from "@/core/messaging/walletApi";
import { Icon, ICON_PATHS } from "../components";
import { AddressChip, PrimaryButton, SecondaryButton, Spinner } from "../components/forms";
import { walletClient, WalletRequestError } from "../shared/walletClient";
import { PortfolioScreen, type PortfolioHolding } from "./PortfolioScreen";
import { ActivityScreen } from "./ActivityScreen";
import { ReceiveScreen } from "./ReceiveScreen";
import { BitcoinReceiveScreen } from "./BitcoinReceiveScreen";
import { SendScreen } from "./SendScreen";
import { SettingsScreen } from "./SettingsScreen";
import { UnlockScreen } from "./UnlockScreen";

/**
 * Popup shell.
 *
 * ===========================================================================
 * THE POPUP IS A THIN CLIENT
 * ===========================================================================
 * It renders state and dispatches intents to the background service worker. It
 * never holds a seed, a private key, or a derived encryption key -- it has no
 * reference to one and no way to obtain one, because everything it can do goes
 * through `walletClient`, which speaks only in plain messages.
 *
 * That is why the balances below are fetched rather than computed here: reading
 * a balance needs an RPC client, an RPC client needs a chain, and none of that
 * belongs in a surface that a rendering bug could turn into a data leak.
 *
 * Navigation follows the screens spec: Portfolio, Add (raised centre),
 * Activity, with Settings promoted to a header icon. The bar is always visible
 * and never hides on scroll.
 */

type Tab = "portfolio" | "activity";
/**
 * Send and receive are full-screen ROUTES, not tabs.
 *
 * Both are multi-step and demand attention -- a send is being composed and
 * reviewed, a receive address is being read character by character. Leaving the
 * nav bar visible underneath invites a stray tap that discards the work, which
 * for a review in progress also means silently releasing its nonce.
 */
type Route = "main" | "send" | "receive" | "receiveBitcoin" | "settings";
/**
 * Settings is a ROUTE, not a sheet.
 *
 * It was a sheet while it held one button. It now holds seed reveal, password
 * change, private-key import and wallet reset -- every one of them multi-step
 * and irreversible, and a sheet that closes on a tap outside it is the wrong
 * container for any of them.
 */
type Sheet = "none" | "accounts" | "networks";

export function PopupApp() {
  const [status, setStatus] = useState<WalletStatusResult | undefined>();
  const [portfolio, setPortfolio] = useState<PortfolioResult | undefined>();
  const [bitcoinPortfolio, setBitcoinPortfolio] = useState<BitcoinPortfolioResult | undefined>();
  /**
   * WHY A FAILED BITCOIN READ NEEDS STATE OF ITS OWN
   * ------------------------------------------------
   * The last-good rule below keeps a stale figure on screen when a refresh
   * fails, which is right while the figure still belongs to the account and
   * network on screen. Across a network SWITCH it does not: the previous
   * network's result is filtered out, so a first read that fails on the new
   * network took the entire Bitcoin section away -- no card, no heading, no
   * explanation. "Bitcoin is not in this wallet" and "we could not reach the
   * indexer just now" then look identical, and the second one is the common
   * case the moment someone switches to mainnet, where the built-in indexer is
   * a public host that throttles.
   */
  const [bitcoinError, setBitcoinError] = useState<string | undefined>();
  /**
   * Why there is no EVM portfolio. Same split as the Bitcoin one above, and for
   * a sharper reason: Bitcoin's failure took a card away, this one filled the
   * hero with `0 ETH`.
   */
  const [portfolioError, setPortfolioError] = useState<string | undefined>();
  const [activity, setActivity] = useState<ActivityResult | undefined>();
  const [bitcoinActivity, setBitcoinActivity] = useState<BitcoinActivityResult | undefined>();
  const [tab, setTab] = useState<Tab>("portfolio");
  const [route, setRoute] = useState<Route>("main");
  const [sheet, setSheet] = useState<Sheet>("none");
  const [isRefreshing, setRefreshing] = useState(false);
  const [isLoadingActivity, setLoadingActivity] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadStatus = useCallback(async () => {
    try {
      const next = await walletClient.getStatus();
      setStatus(next);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet is not responding.");
      return undefined;
    }
  }, []);

  /**
   * ===========================================================================
   * TWO READS, TWO RENDERS. NEVER ONE AWAIT OVER BOTH.
   * ===========================================================================
   * `Promise.all`/`allSettled` across the chains is the obvious shape and it is
   * wrong here, because it makes the SLOWER chain the speed of the screen.
   *
   * The EVM portfolio is one message to the worker. The Bitcoin portfolio is a
   * BIP-44 gap scan: up to 40 address lookups against a public indexer, in
   * sequential batches. Awaiting both before setting either meant the Ethereum
   * balances sat behind "Refreshing..." for as long as the indexer took -- and
   * on an indexer that never answers, forever. A wallet that cannot show the
   * balance it has always shown because a SECOND, optional asset is slow has
   * been made worse by a feature the user did not ask to depend on.
   *
   * So each chain sets its own state as it lands, and each failure is contained
   * to its own asset. Feature separation (ground rule 3) is not only about
   * being able to switch Bitcoin off; it is about Bitcoin being unable to take
   * anything else down while it is on.
   */
  const loadPortfolio = useCallback(async (current: WalletStatusResult | undefined) => {
    if (!current?.isUnlocked || !current.selectedAddress) {
      setPortfolio(undefined);
      setPortfolioError(undefined);
      setBitcoinPortfolio(undefined);
      return;
    }
    const address = current.selectedAddress;
    /**
     * The Bitcoin account for the account on screen, not merely "Bitcoin is
     * on". An imported private key has no account in the phrase's tree, so the
     * facet omits the index and there is nothing to read -- as opposed to
     * account 0, which is what this used to read for every account at once.
     */
    const bitcoinAccountIndex = current.bitcoin?.accountIndex;

    const evm = (async () => {
      setRefreshing(true);
      try {
        setPortfolio(await walletClient.getPortfolio({ address }));
        setPortfolioError(undefined);
      } catch (error) {
        // Balances are read live on every open, so a failure here means "we
        // could not reach the chain just now", not "you have nothing". Clearing
        // the result is right -- a stale balance under a switched account or
        // chain is worse than none -- but for a long time it was the WHOLE
        // story, and the hero then rendered `0 ETH` from the fallback. The
        // reason is now carried alongside so the screen can show a dash and
        // say why, instead of quietly inventing a zero.
        setPortfolio(undefined);
        setPortfolioError(
          error instanceof WalletRequestError && error.reason === "rpc_unavailable"
            ? error.message
            : "Balances are unavailable",
        );
      } finally {
        setRefreshing(false);
      }
    })();

    const bitcoin = (async () => {
      // The facet is absent when the feature is off, and the index is absent
      // on an imported account. Either way there is nothing to show rather
      // than something to keep -- and clearing is what stops the previous
      // account's balance from surviving the switch.
      if (bitcoinAccountIndex === undefined) {
        setBitcoinPortfolio(undefined);
        setBitcoinError(undefined);
        return;
      }
      try {
        setBitcoinPortfolio(
          await walletClient.getBitcoinPortfolio({ accountIndex: bitcoinAccountIndex }),
        );
        setBitcoinError(undefined);
      } catch (error) {
        // An unreachable indexer carries a `code`, which is what gets its
        // message past the router to this page. That message is written to be
        // rendered -- it names the network and nothing else, because a balance
        // card is not the place for a hostname or a millisecond count. The
        // host and the cause stay on the error in the worker.
        //
        // Anything else is a wallet-side fault the user can do nothing about,
        // and gets a sentence that says exactly that much.
        setBitcoinError(
          error instanceof WalletRequestError && error.reason === "indexer_unavailable"
            ? error.message
            : "Bitcoin is unavailable",
        );
        // A rejected Bitcoin read is "we could not reach the indexer", not "you
        // hold nothing". The EVM portfolio degrades by dropping the row whose
        // read failed; Bitcoin is a single figure with no row to omit, so the
        // last good one stays on screen. Clearing it would take the card away
        // entirely, which reads as the balance having vanished -- the same harm
        // as rendering 0 BTC, in a different costume. Locking still clears it,
        // through the early return above.
      }
    })();

    await Promise.allSettled([evm, bitcoin]);
  }, []);

  const loadActivity = useCallback(async (current: WalletStatusResult | undefined) => {
    if (!current?.isUnlocked || !current.selectedAddress) {
      setActivity(undefined);
      setBitcoinActivity(undefined);
      return;
    }
    const address = current.selectedAddress;
    const bitcoinAccountIndex = current.bitcoin?.accountIndex;

    // Split for the same reason as the portfolio above: the Bitcoin history is
    // a per-address query fanned out over the scan result, and it must not hold
    // the Ethereum list behind a spinner.
    const evm = (async () => {
      setLoadingActivity(true);
      try {
        setActivity(await walletClient.getActivity({ address }));
      } catch {
        // The engine distinguishes "no index here" from "index unreachable" and
        // reports both as a status rather than an exception, so reaching this
        // means the worker itself is unavailable. The screen shows its loading
        // state rather than a scary error for something a retry will fix.
        setActivity(undefined);
      } finally {
        setLoadingActivity(false);
      }
    })();

    const bitcoin = (async () => {
      if (bitcoinAccountIndex === undefined) {
        setBitcoinActivity(undefined);
        return;
      }
      try {
        setBitcoinActivity(
          await walletClient.getBitcoinActivity({ accountIndex: bitcoinAccountIndex }),
        );
      } catch {
        // Last good list stays, as with the balance. Note the gap this leaves:
        // a FIRST load that fails renders an Ethereum-only list with nothing
        // saying Bitcoin is missing from it, because `BitcoinActivityResult`
        // reports a hardcoded "ok" and has no way to say otherwise yet.
      }
    })();

    await Promise.allSettled([evm, bitcoin]);
  }, []);

  const refresh = useCallback(async () => {
    const next = await loadStatus();
    // In parallel: a slow price feed must not hold up the activity list, and a
    // slow indexer must not hold up the balances.
    await Promise.all([loadPortfolio(next), loadActivity(next)]);
  }, [loadStatus, loadPortfolio, loadActivity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !status) {
    return (
      <Shell>
        <CenteredMessage title="Wallet unavailable" body={error} />
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Loading" />
        </div>
      </Shell>
    );
  }

  if (!status.hasVault) {
    return (
      <Shell>
        <NoWalletYet />
      </Shell>
    );
  }

  if (!status.isUnlocked) {
    return (
      <Shell>
        <UnlockScreen onUnlocked={() => void refresh()} />
      </Shell>
    );
  }

  const holdings: PortfolioHolding[] = (portfolio?.entries ?? []).map((entry) => ({
    // The contract address, never the symbol -- see PortfolioHolding.id.
    id: entry.tokenAddress ?? "native",
    symbol: entry.symbol,
    name: entry.name,
    networkLabel: entry.networkLabel,
    fiatValue: entry.fiatValue,
    balanceLabel: `${entry.balanceLabel} ${entry.symbol}`,
    isImported: entry.isImported,
  }));

  const nativeEntry = portfolio?.entries.find((entry) => entry.kind === "native");
  const selectedAccount = status.accounts.find(
    (account) => account.address === status.selectedAddress,
  );

  /**
   * ===========================================================================
   * BITCOIN IS SHOWN ONLY WHEN IT BELONGS TO THE ACCOUNT ON SCREEN
   * ===========================================================================
   * Two conditions, and they are different failures.
   *
   * `bitcoinAccountIndex === undefined` means the selected account has no
   * Bitcoin account at all -- it was imported as a private key, and the phrase
   * that Bitcoin derives from does not contain it.
   *
   * The account and network comparison catches the other half: a Bitcoin read
   * keeps its last good result on failure, deliberately, so that an
   * unreachable indexer does not read as an emptied wallet. Across a SWITCH
   * that same rule shows the previous account's balance under the new
   * account's name, or -- worse -- signet's balance under "Bitcoin Mainnet",
   * until the retry lands. Both results carry the account and the network they
   * were fetched for, so the check costs no extra state and cannot be
   * forgotten in one of the two places.
   */
  const bitcoinAccountIndex = status.bitcoin?.accountIndex;
  const bitcoinNetworkName = status.bitcoin?.network.network;
  const matchesSelectedBitcoin = (
    result: { accountIndex: number; network: { network: string } } | undefined,
  ) =>
    bitcoinAccountIndex !== undefined &&
    result?.accountIndex === bitcoinAccountIndex &&
    result.network.network === bitcoinNetworkName;
  const bitcoinPortfolioForAccount = matchesSelectedBitcoin(bitcoinPortfolio)
    ? bitcoinPortfolio
    : undefined;
  const bitcoinActivityForAccount = matchesSelectedBitcoin(bitcoinActivity)
    ? bitcoinActivity
    : undefined;

  if (route === "send") {
    return (
      <Shell>
        <SendScreen
          status={status}
          holdings={portfolio?.entries ?? []}
          onBack={() => {
            setRoute("main");
            void refresh();
          }}
          onSent={() => {
            setTab("activity");
            void refresh();
          }}
        />
      </Shell>
    );
  }

  if (route === "settings") {
    return (
      <Shell>
        <SettingsScreen
          status={status}
          onBack={() => setRoute("main")}
          onWalletChanged={() => void refresh()}
          onSessionEnded={() => {
            // Back to the portfolio as well as refreshed. Staying here would
            // put the user on a settings sub-page after the next unlock, or --
            // after a reset -- on one describing a wallet that no longer exists.
            setRoute("main");
            void refresh();
          }}
        />
      </Shell>
    );
  }

  if (route === "receive" && status.selectedAddress) {
    return (
      <Shell>
        <ReceiveScreen
          address={status.selectedAddress}
          accountLabel={selectedAccount?.label ?? "Account"}
          chain={status.chain}
          onBack={() => setRoute("main")}
        />
      </Shell>
    );
  }

  /**
   * Gated on the resolved Bitcoin account, not on `selectedAddress`: a Bitcoin
   * address is derived from the phrase, and which account of the phrase is the
   * question this index answers. The guard covers both ways the screen can
   * have nothing to ask for -- the worker restarting with the feature off
   * while the route is open, and an imported account that has no Bitcoin
   * account -- without which the screen mounts and its one request comes back
   * an error the user cannot act on.
   */
  if (route === "receiveBitcoin" && bitcoinAccountIndex !== undefined) {
    return (
      <Shell>
        <BitcoinReceiveScreen
          accountIndex={bitcoinAccountIndex}
          accountLabel={selectedAccount?.label ?? "Account"}
          onBack={() => setRoute("main")}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {status.pendingApprovalCount > 0 ? (
        <PendingApprovalBanner count={status.pendingApprovalCount} />
      ) : null}

      <div className="flex flex-1 flex-col overflow-y-auto">
        <AnimatePresence mode="wait">
          {tab === "portfolio" ? (
            <PortfolioScreen
              key="portfolio"
              accountLabel={selectedAccount?.label ?? "Account"}
              networkName={status.chain.name}
              totalFiat={portfolio?.totalFiatValue}
              change={portfolio?.change ?? { status: "unavailable", reason: "nothing_held" }}
              /**
               * `0 ETH` only when the engine actually said zero. With no
               * portfolio at all there is no number to state, and the screen
               * shows a dash rather than the one figure most likely to be
               * misread as an emptied wallet.
               */
              fallbackHeroLabel={
                nativeEntry
                  ? `${nativeEntry.balanceLabel} ${nativeEntry.symbol}`
                  : portfolio
                    ? `0 ${status.chain.nativeCurrencySymbol}`
                    : undefined
              }
              {...(portfolio === undefined ? { portfolioError } : {})}
              onRetryPortfolio={() => void refresh()}
              holdings={holdings}
              bitcoinPortfolio={bitcoinPortfolioForAccount}
              {...(bitcoinPortfolioForAccount === undefined && bitcoinAccountIndex !== undefined
                ? { bitcoinError }
                : {})}
              onRetryBitcoin={() => void refresh()}
              isRefreshing={isRefreshing}
              onSend={() => setRoute("send")}
              onReceive={() => setRoute("receive")}
              onReceiveBitcoin={() => setRoute("receiveBitcoin")}
              onSelectAccount={() => setSheet("accounts")}
              onSelectNetwork={() => setSheet("networks")}
              onOpenSettings={() => setRoute("settings")}
              onImportToken={() => setRoute("settings")}
            />
          ) : (
            <ActivityScreen
              key="activity"
              activity={activity}
              bitcoinActivity={bitcoinActivityForAccount}
              isRefreshing={isLoadingActivity}
              onReplaced={() => void refresh()}
            />
          )}
        </AnimatePresence>
      </div>

      <NavBar tab={tab} onChange={setTab} onReceive={() => setRoute("receive")} />

      <AnimatePresence>
        {sheet === "accounts" ? (
          <Sheet key="accounts" title="Accounts" onClose={() => setSheet("none")}>
            {status.accounts.map((account) => (
              <SheetRow
                key={account.address}
                title={account.label}
                subtitle={<AddressChip address={account.address} />}
                selected={account.address === status.selectedAddress}
                onClick={() => {
                  void walletClient.selectAccount(account.address).then(() => {
                    setSheet("none");
                    return refresh();
                  });
                }}
              />
            ))}
            <div className="p-3">
              <SecondaryButton
                onClick={() => {
                  void walletClient.addAccount().then(() => {
                    setSheet("none");
                    return refresh();
                  });
                }}
              >
                Add account
              </SecondaryButton>
            </div>
          </Sheet>
        ) : null}

        {sheet === "networks" ? (
          <Sheet key="networks" title="Networks" onClose={() => setSheet("none")}>
            {/*
              One sheet, two subsystems, and the headings are what keep them
              apart. Ethereum and Bitcoin networks are switched independently
              -- picking signet does not move the EVM chain, and nothing about
              Sepolia implies a Bitcoin testnet -- so each section carries its
              own tick. Splitting them across two sheets would instead make
              "which network am I on" a question with two answers in two
              places, on a screen whose entire job is answering it.
            */}
            <SheetSection>Ethereum</SheetSection>
            {status.availableChains.map((chain) => (
              <SheetRow
                key={chain.chainId}
                title={chain.name}
                subtitle={
                  <span className="text-[11px] text-(--color-slate)">
                    {chain.isTestnet ? "Test network" : "Main network"} - chain {chain.chainId}
                  </span>
                }
                selected={chain.chainId === status.chain.chainId}
                onClick={() => {
                  void walletClient.switchChain(chain.chainId).then(() => {
                    setSheet("none");
                    return refresh();
                  });
                }}
              />
            ))}

            {/*
              Absent when the feature is off, rather than a disabled section:
              a build with no indexer configured has no Bitcoin anything, and
              greying out a control that cannot exist invites the user to hunt
              for the setting that enables it.
            */}
            {status.bitcoin ? (
              <>
                <SheetSection>Bitcoin</SheetSection>
                {status.bitcoin.availableNetworks.map((network) => (
                  <SheetRow
                    key={network.network}
                    title={network.name}
                    subtitle={
                      <span className="text-[11px] text-(--color-slate)">
                        {/*
                          Named in terms of the money, not the topology. "Test
                          network" is the fact that matters when someone is
                          deciding where to send a deposit; "signet" is a word
                          that only helps people who already knew.
                        */}
                        {network.isTestnet
                          ? "Test network - coins have no value"
                          : "Real bitcoin"}
                      </span>
                    }
                    selected={network.network === status.bitcoin?.network.network}
                    onClick={() => {
                      void walletClient
                        .switchBitcoinNetwork({ network: network.network })
                        .then(() => {
                          setSheet("none");
                          return refresh();
                        });
                    }}
                  />
                ))}
              </>
            ) : null}
          </Sheet>
        ) : null}
      </AnimatePresence>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-[600px] w-[380px] flex-col overflow-hidden bg-(--color-bg)">
      {children}
    </div>
  );
}

/**
 * A request is waiting in a window that may be behind the browser. The badge on
 * the toolbar icon says the same thing from outside; this says it to someone
 * who has already opened the popup and would otherwise see no sign of it.
 */
function PendingApprovalBanner({ count }: { count: number }) {
  return (
    <button
      type="button"
      onClick={() => window.close()}
      className="flex w-full items-center justify-between border-b border-(--color-line) bg-(--color-muted) px-4 py-2 text-left"
    >
      <span className="text-xs text-(--color-ink)">
        {count === 1 ? "1 request is waiting" : `${count} requests are waiting`}
      </span>
      <Icon path={ICON_PATHS.chevronRight} size={14} />
    </button>
  );
}

function NoWalletYet() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-5 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-serif text-2xl text-(--color-ink)">Welcome</h1>
        <p className="max-w-[250px] text-xs leading-relaxed text-(--color-slate)">
          Create a new wallet or restore one from a recovery phrase. It takes about a minute.
        </p>
      </div>
      <PrimaryButton
        onClick={() => {
          // A full tab, never the popup. Setup shows a recovery phrase, and a
          // popup that closes on an outside click can take the only copy of it
          // with it. The tab also shows the extension origin in the URL bar,
          // which is how a user tells a real setup flow from a page imitating one.
          void chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/onboarding/index.html") });
        }}
      >
        Get started
      </PrimaryButton>
    </div>
  );
}

function CenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="font-serif text-lg text-(--color-ink)">{title}</p>
      <p className="max-w-[240px] text-xs leading-relaxed text-(--color-slate)">{body}</p>
    </div>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <motion.button
        type="button"
        aria-label="Close"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-10 bg-black/25"
      />
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 420, damping: 38 }}
        className="absolute inset-x-0 bottom-0 z-20 max-h-[70%] overflow-y-auto rounded-t-2xl border-t border-(--color-line) bg-(--color-card)"
      >
        <header className="flex items-center justify-between px-4 py-3">
          <h2 className="font-serif text-base text-(--color-ink)">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-(--color-slate)"
            aria-label="Close"
          >
            Done
          </button>
        </header>
        {children}
      </motion.div>
    </>
  );
}

function SheetSection({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-(--color-slate) uppercase">
      {children}
    </h3>
  );
}

function SheetRow({
  title,
  subtitle,
  selected,
  onClick,
}: {
  title: string;
  subtitle: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between border-t border-(--color-line) px-4 py-3 text-left hover:bg-(--color-muted)"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm text-(--color-ink)">{title}</span>
        {subtitle}
      </span>
      {/* A tick, not just a highlight. Selection carried by colour alone
          disappears for a colour-blind user and in high-contrast modes. */}
      {selected ? <span className="text-sm text-(--color-ink)">&#10003;</span> : null}
    </button>
  );
}

/**
 * Always visible, never hides on scroll -- per the spec. Three targets keeps
 * each one comfortably wide at 380px; a fourth would crowd them.
 */
function NavBar({
  tab,
  onChange,
  onReceive,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
  onReceive: () => void;
}) {
  return (
    <nav className="flex items-end border-t border-(--color-line) bg-(--color-card) px-2 pb-3 pt-2">
      <NavItem
        label="Portfolio"
        icon={ICON_PATHS.portfolio}
        active={tab === "portfolio"}
        onClick={() => onChange("portfolio")}
      />
      <div className="flex flex-1 justify-center">
        {/* The raised centre action. Receive rather than a generic "add":
            it is the only one of the three that is useful on an empty wallet,
            which is exactly when a new user is looking for it. */}
        <motion.button
          type="button"
          onClick={onReceive}
          whileTap={{ scale: 0.92 }}
          aria-label="Receive"
          className="-mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-(--color-btn-bg) text-(--color-btn-fg) shadow-[0_4px_14px_rgba(15,23,41,0.22)]"
        >
          <Icon path={ICON_PATHS.receive} size={20} />
        </motion.button>
      </div>
      <NavItem
        label="Activity"
        icon={ICON_PATHS.activity}
        active={tab === "activity"}
        onClick={() => onChange("activity")}
      />
    </nav>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="flex flex-1 flex-col items-center gap-1 py-1"
      style={{ color: active ? "var(--color-ink)" : "var(--color-faint)" }}
    >
      <Icon path={icon} size={18} />
      <span className="text-[9px] tracking-[0.04em]">{label}</span>
    </button>
  );
}
