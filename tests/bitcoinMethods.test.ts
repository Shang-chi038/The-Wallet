import { describe, expect, it } from "vitest";
import {
  createHarness,
  expectError,
  expectResult,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
} from "./support/routerHarness";
import type {
  BitcoinActivityResult,
  BitcoinPortfolioResult,
  BitcoinReceiveAddressResult,
  WalletStatusResult,
} from "@/core/messaging/walletApi";

describe("Bitcoin Methods & Wire Protocol", () => {
  it("includes bitcoin facet in wallet.getStatus when unlocked", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      { method: "wallet.getStatus" },
      PRIVILEGED_SENDER,
    );
    const status = expectResult<WalletStatusResult>(response);

    expect(status.bitcoin).toBeDefined();
    expect(status.bitcoin?.network.network).toBe("signet");
    expect(status.bitcoin?.network.shortName).toBe("Signet");
    expect(status.bitcoin?.accountCount).toBe(1);
  });

  /**
   * The feature-off path, which is what an absent `VITE_BITCOIN_INDEXER_URL`
   * produces in `serviceWorker.ts`. Worth a test of its own because "off" is
   * two separate promises -- the facet is gone AND the methods refuse -- and a
   * later change could keep one while breaking the other, leaving a popup that
   * renders a Bitcoin card whose every request comes back 4200.
   */
  describe("with Bitcoin disabled", () => {
    it("omits the bitcoin facet from wallet.getStatus", async () => {
      const harness = createHarness({ bitcoin: false });
      await harness.createAndUnlockWallet();

      const response = await harness.route(
        { method: "wallet.getStatus" },
        PRIVILEGED_SENDER,
      );
      const status = expectResult<WalletStatusResult>(response);

      expect(status.bitcoin).toBeUndefined();
      expect("bitcoin" in status).toBe(false);
      // The rest of the wallet is untouched: disabling Bitcoin must not cost
      // the user anything they already had.
      expect(status.isUnlocked).toBe(true);
      expect(status.accounts.length).toBeGreaterThan(0);
      expect(status.chain).toBeDefined();
    });

    it("reports every Bitcoin method as unsupported, even to a privileged sender", async () => {
      const harness = createHarness({ bitcoin: false });
      await harness.createAndUnlockWallet();

      for (const method of [
        "wallet.getBitcoinPortfolio",
        "wallet.getBitcoinReceiveAddress",
        "wallet.getBitcoinActivity",
        "wallet.switchBitcoinNetwork",
      ] as const) {
        const response = await harness.route(
          { method, params: { accountIndex: 0, network: "signet" } },
          PRIVILEGED_SENDER,
        );
        expect(expectError(response).code, `${method} should be unsupported`).toBe(4200);
      }
    });

    it("still answers an ordinary Ethereum read", async () => {
      const harness = createHarness({ bitcoin: false });
      await harness.createAndUnlockWallet();

      const response = await harness.route(
        { method: "wallet.getPortfolio" },
        PRIVILEGED_SENDER,
      );
      expect("error" in response).toBe(false);
    });
  });

  it("blocks page senders from calling Bitcoin methods (4200 unsupportedMethod)", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const pResponse = await harness.route(
      { method: "wallet.getBitcoinPortfolio", params: { accountIndex: 0 } },
      PAGE_SENDER,
    );
    expect(expectError(pResponse).code).toBe(4200);

    const rResponse = await harness.route(
      { method: "wallet.getBitcoinReceiveAddress", params: { accountIndex: 0 } },
      PAGE_SENDER,
    );
    expect(expectError(rResponse).code).toBe(4200);

    const aResponse = await harness.route(
      { method: "wallet.getBitcoinActivity", params: { accountIndex: 0 } },
      PAGE_SENDER,
    );
    expect(expectError(aResponse).code).toBe(4200);
  });

  it("returns VaultLockedError when calling Bitcoin methods while locked", async () => {
    const harness = createHarness();
    // Do not unlock
    const response = await harness.route(
      { method: "wallet.getBitcoinPortfolio", params: { accountIndex: 0 } },
      PRIVILEGED_SENDER,
    );
    const err = expectError(response);
    expect(err.data?.reason).toBe("vault_locked");
  });

  it("returns Bitcoin portfolio with balance, label, and pricing", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    // Mock BTC price
    harness.prices.set("BTC", { price: 60_000, change24hPercent: 2.5 });

    // Mock UTXO funds on the first signet receive address (tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl)
    const signetAddr = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
    harness.bitcoin.addressStats.set(signetAddr, {
      chainFundedSats: 200_000_000n, // 2 BTC
      chainSpentSats: 50_000_000n, // 0.5 BTC
      chainTxCount: 2,
    });

    const response = await harness.route(
      { method: "wallet.getBitcoinPortfolio", params: { accountIndex: 0 } },
      PRIVILEGED_SENDER,
    );
    const portfolio = expectResult<BitcoinPortfolioResult>(response);

    expect(portfolio.confirmedSats).toBe("150000000"); // 1.5 BTC
    expect(portfolio.unconfirmedSats).toBe("0");
    expect(portfolio.totalSats).toBe("150000000");
    expect(portfolio.balanceLabel).toBe("1.5 BTC");
    expect(portfolio.fiatStatus).toBe("priced");
    expect(portfolio.fiatValue).toBe(90_000); // 1.5 * 60,000
    expect(portfolio.usedAddressCount).toBe(1);
  });

  it("returns next unused receive address for deposit", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const response = await harness.route(
      { method: "wallet.getBitcoinReceiveAddress", params: { accountIndex: 0 } },
      PRIVILEGED_SENDER,
    );
    const result = expectResult<BitcoinReceiveAddressResult>(response);

    expect(result.address.startsWith("tb1q")).toBe(true);
    expect(result.addressIndex).toBe(0);
    expect(result.derivationPath).toBe("m/84'/1'/0'/0/0");
    expect(result.network.network).toBe("signet");
  });

  it("returns merged Bitcoin activity entries", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const signetAddr = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
    harness.bitcoin.addressStats.set(signetAddr, {
      chainFundedSats: 100_000_000n,
      chainTxCount: 1,
    });

    harness.bitcoin.transactions.set(signetAddr, [
      {
        txid: "tx-btc-incoming",
        version: 2,
        locktime: 0,
        vin: [
          {
            txid: "prev-tx",
            vout: 0,
            prevout: { scriptpubkey_address: "tb1qsender", value: 100_002_000n },
            sequence: 0xffffffff,
          },
        ],
        vout: [{ scriptpubkey_address: signetAddr, value: 100_000_000n }],
        size: 140,
        weight: 560,
        fee: 2000n,
        status: { confirmed: true, block_height: 100000, block_time: 1700000000 },
      },
    ]);

    const response = await harness.route(
      { method: "wallet.getBitcoinActivity", params: { accountIndex: 0 } },
      PRIVILEGED_SENDER,
    );
    const activity = expectResult<BitcoinActivityResult>(response);

    expect(activity.status).toBe("ok");
    expect(activity.entries.length).toBe(1);
    expect(activity.entries[0]?.direction).toBe("received");
    expect(activity.entries[0]?.amountSats).toBe("100000000");
    expect(activity.entries[0]?.amountLabel).toBe("1 BTC");
    expect(activity.entries[0]?.status).toBe("confirmed");
  });

  /**
   * ==========================================================================
   * ONE BITCOIN ACCOUNT PER WALLET ACCOUNT
   * ==========================================================================
   * The bug these cover: `accountIndex` defaulted to 0 in all three handlers
   * and the popup never sent one, so every account in the switcher -- and
   * every imported key -- showed the SAME receive address and the same
   * balance. Funding "Account 2" funded Account 1, silently.
   *
   * The addresses below are known-answer vectors for the BIP-39 `abandon...
   * about` phrase, computed independently from the derivation path rather than
   * captured from this code. If account 1 ever equals account 0 again the
   * assertion is on the exact address, not on "they differ".
   */
  describe("per-account derivation", () => {
    const ACCOUNT_0_FIRST_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
    const ACCOUNT_1_FIRST_ADDRESS = "tb1qp7shgcwx3mpzgxjvff0d77vuhchcldzfy60x6s";

    async function addAndSelectSecondAccount(harness: ReturnType<typeof createHarness>) {
      await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER);
      const status = expectResult<WalletStatusResult>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      );
      const second = status.accounts[1];
      expect(second).toBeDefined();
      await harness.route(
        { method: "wallet.selectAccount", params: { address: second!.address } },
        PRIVILEGED_SENDER,
      );
      return second!;
    }

    it("derives the second account's own receive address, not the first's", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const first = expectResult<BitcoinReceiveAddressResult>(
        await harness.route(
          { method: "wallet.getBitcoinReceiveAddress" },
          PRIVILEGED_SENDER,
        ),
      );
      expect(first.address).toBe(ACCOUNT_0_FIRST_ADDRESS);
      expect(first.derivationPath).toBe("m/84'/1'/0'/0/0");

      await addAndSelectSecondAccount(harness);

      const second = expectResult<BitcoinReceiveAddressResult>(
        await harness.route(
          { method: "wallet.getBitcoinReceiveAddress" },
          PRIVILEGED_SENDER,
        ),
      );
      expect(second.address).toBe(ACCOUNT_1_FIRST_ADDRESS);
      expect(second.derivationPath).toBe("m/84'/1'/1'/0/0");
      expect(second.address).not.toBe(first.address);
    });

    /**
     * The half that actually loses money: two accounts sharing an address also
     * share a BALANCE, so a deposit to one shows up under both and the total
     * the user reads is double what they hold.
     */
    it("does not show one account's balance under another", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();
      harness.bitcoin.addressStats.set(ACCOUNT_1_FIRST_ADDRESS, {
        chainFundedSats: 100_000_000n,
        chainSpentSats: 0n,
        chainTxCount: 1,
      });

      const firstAccount = expectResult<BitcoinPortfolioResult>(
        await harness.route({ method: "wallet.getBitcoinPortfolio" }, PRIVILEGED_SENDER),
      );
      expect(firstAccount.accountIndex).toBe(0);
      expect(firstAccount.totalSats).toBe("0");

      await addAndSelectSecondAccount(harness);

      const secondAccount = expectResult<BitcoinPortfolioResult>(
        await harness.route({ method: "wallet.getBitcoinPortfolio" }, PRIVILEGED_SENDER),
      );
      expect(secondAccount.accountIndex).toBe(1);
      expect(secondAccount.totalSats).toBe("100000000");
    });

    it("reports the selected account's Bitcoin index and the number that exist", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const before = expectResult<WalletStatusResult>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      );
      expect(before.bitcoin?.accountIndex).toBe(0);
      expect(before.bitcoin?.accountCount).toBe(1);

      await addAndSelectSecondAccount(harness);

      const after = expectResult<WalletStatusResult>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      );
      expect(after.bitcoin?.accountIndex).toBe(1);
      expect(after.bitcoin?.accountCount).toBe(2);
    });

    /**
     * An imported key is not in the phrase's tree. Falling back to account 0
     * would show the FIRST account's bitcoin under it -- an invitation to
     * deposit into a key the user believes they are not looking at, and the
     * same balance repeated under every imported account at once.
     */
    describe("with an imported private key selected", () => {
      async function importAndSelect(harness: ReturnType<typeof createHarness>) {
        const imported = expectResult<{ account: { address: string } }>(
          await harness.route(
            {
              method: "wallet.importPrivateKey",
              params: { privateKey: `0x${"11".repeat(32)}` },
            },
            PRIVILEGED_SENDER,
          ),
        );
        await harness.route(
          { method: "wallet.selectAccount", params: { address: imported.account.address } },
          PRIVILEGED_SENDER,
        );
      }

      it("omits the Bitcoin account index from wallet.getStatus", async () => {
        const harness = createHarness();
        await harness.createAndUnlockWallet();
        await importAndSelect(harness);

        const status = expectResult<WalletStatusResult>(
          await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
        );
        // The facet stays -- the feature is still on, and the phrase still has
        // one account. What is absent is an index for THIS account.
        expect(status.bitcoin).toBeDefined();
        expect(status.bitcoin?.accountCount).toBe(1);
        expect(status.bitcoin?.accountIndex).toBeUndefined();
      });

      it("refuses a Bitcoin read rather than answering for account 0", async () => {
        const harness = createHarness();
        await harness.createAndUnlockWallet();
        await importAndSelect(harness);

        for (const method of [
          "wallet.getBitcoinPortfolio",
          "wallet.getBitcoinReceiveAddress",
          "wallet.getBitcoinActivity",
        ] as const) {
          const response = await harness.route({ method }, PRIVILEGED_SENDER);
          expect(expectError(response).code, method).toBe(-32602);
        }
      });
    });

    /**
     * An out-of-range index derives a perfectly valid address that nothing in
     * this wallet will scan again, so anything sent to it is invisible money.
     * Same reasoning as `wallet.getPortfolio` refusing an address it does not
     * own.
     */
    it("rejects an account index the wallet has not derived", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const response = await harness.route(
        { method: "wallet.getBitcoinReceiveAddress", params: { accountIndex: 7 } },
        PRIVILEGED_SENDER,
      );
      expect(expectError(response).code).toBe(-32602);
    });
  });

  it("allows switching Bitcoin networks", async () => {
    const harness = createHarness();
    await harness.createAndUnlockWallet();

    const switchRes = await harness.route(
      { method: "wallet.switchBitcoinNetwork", params: { network: "mainnet" } },
      PRIVILEGED_SENDER,
    );
    expect(expectResult<{ network: string }>(switchRes).network).toBe("mainnet");

    const statusRes = await harness.route(
      { method: "wallet.getStatus" },
      PRIVILEGED_SENDER,
    );
    const status = expectResult<WalletStatusResult>(statusRes);
    expect(status.bitcoin?.network.network).toBe("mainnet");
    expect(status.bitcoin?.network.shortName).toBe("BTC");
  });

  /**
   * ==========================================================================
   * THE NETWORK PICKER
   * ==========================================================================
   * `wallet.switchBitcoinNetwork` shipped with no UI, so these cover what
   * putting one in front of it requires: a list to offer, a choice that
   * changes the DERIVATION and not merely the label, and balances that do not
   * cross between networks.
   */
  describe("network selection", () => {
    /**
     * BIP-84's own published test vector for `abandon... about`, and the
     * strongest assertion available here: coin type is part of the path, so a
     * switch that changed the indexer but not the derivation would keep
     * answering `tb1...` and this catches it by name rather than by shape.
     */
    const MAINNET_FIRST_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const SIGNET_FIRST_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";

    async function switchTo(
      harness: ReturnType<typeof createHarness>,
      network: string,
    ) {
      const response = await harness.route(
        { method: "wallet.switchBitcoinNetwork", params: { network } },
        PRIVILEGED_SENDER,
      );
      expect(expectResult<{ network: string }>(response).network).toBe(network);
    }

    it("offers every built-in network, so the picker cannot list one the engine refuses", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const status = expectResult<WalletStatusResult>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      );
      const offered = status.bitcoin?.availableNetworks ?? [];

      expect(offered.map((entry) => entry.network)).toEqual([
        "mainnet",
        "signet",
        "testnet4",
      ]);
      // The popup labels the row "Test network - coins have no value" off this
      // flag alone, so it has to cross the wire correctly for all three.
      expect(offered.find((entry) => entry.network === "mainnet")?.isTestnet).toBe(false);
      expect(offered.find((entry) => entry.network === "signet")?.isTestnet).toBe(true);
      expect(offered.find((entry) => entry.network === "testnet4")?.isTestnet).toBe(true);

      // Every offered network is one the engine will actually accept.
      for (const entry of offered) {
        await switchTo(harness, entry.network);
      }
    });

    it("changes the derivation, not just the label", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const onSignet = expectResult<BitcoinReceiveAddressResult>(
        await harness.route(
          { method: "wallet.getBitcoinReceiveAddress" },
          PRIVILEGED_SENDER,
        ),
      );
      expect(onSignet.address).toBe(SIGNET_FIRST_ADDRESS);
      expect(onSignet.derivationPath).toBe("m/84'/1'/0'/0/0");

      await switchTo(harness, "mainnet");

      const onMainnet = expectResult<BitcoinReceiveAddressResult>(
        await harness.route(
          { method: "wallet.getBitcoinReceiveAddress" },
          PRIVILEGED_SENDER,
        ),
      );
      // Coin type 0', not 1'. A wallet that kept the testnet path on mainnet
      // would hand out addresses the user's own scan will never find again.
      expect(onMainnet.address).toBe(MAINNET_FIRST_ADDRESS);
      expect(onMainnet.derivationPath).toBe("m/84'/0'/0'/0/0");
      expect(onMainnet.network.isTestnet).toBe(false);
    });

    /**
     * The failure this prevents is the one worth having a test for: a mainnet
     * balance shown while the wallet is on signet, or the reverse. The scan
     * cache is keyed per network, and "keyed per network" is exactly the sort
     * of thing that survives a refactor by looking right.
     */
    it("does not carry a balance across a network switch", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();
      harness.bitcoin.addressStats.set(SIGNET_FIRST_ADDRESS, {
        chainFundedSats: 250_000_000n,
        chainSpentSats: 0n,
        chainTxCount: 1,
      });

      const onSignet = expectResult<BitcoinPortfolioResult>(
        await harness.route({ method: "wallet.getBitcoinPortfolio" }, PRIVILEGED_SENDER),
      );
      expect(onSignet.totalSats).toBe("250000000");
      expect(onSignet.network.network).toBe("signet");

      await switchTo(harness, "mainnet");

      const onMainnet = expectResult<BitcoinPortfolioResult>(
        await harness.route({ method: "wallet.getBitcoinPortfolio" }, PRIVILEGED_SENDER),
      );
      expect(onMainnet.totalSats).toBe("0");
      // Carried on the result so the popup can drop a figure fetched for a
      // network it is no longer showing.
      expect(onMainnet.network.network).toBe("mainnet");

      // And back: the signet figure is still signet's.
      await switchTo(harness, "signet");
      const backOnSignet = expectResult<BitcoinPortfolioResult>(
        await harness.route({ method: "wallet.getBitcoinPortfolio" }, PRIVILEGED_SENDER),
      );
      expect(backOnSignet.totalSats).toBe("250000000");
    });

    it("rejects a network it does not know, rather than falling back to one", async () => {
      const harness = createHarness();
      await harness.createAndUnlockWallet();

      const response = await harness.route(
        { method: "wallet.switchBitcoinNetwork", params: { network: "mainet" } },
        PRIVILEGED_SENDER,
      );
      expect(expectError(response).code).toBe(-32602);

      // Still where it was. Guessing at a mistyped network is how someone ends
      // up reading testnet coins as their real balance.
      const status = expectResult<WalletStatusResult>(
        await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
      );
      expect(status.bitcoin?.network.network).toBe("signet");
    });
  });
});
