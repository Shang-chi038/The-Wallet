import { describe, expect, it } from "vitest";
import { resolveBitcoinIndexerOverrides } from "@/platform/indexer/indexerOverrides";

/**
 * ===========================================================================
 * WHAT THIS EXISTS TO PREVENT
 * ===========================================================================
 * One indexer URL for three reachable networks meant mainnet could only ever
 * use its built-in host, and a machine that cannot reach that host had a wallet
 * which read signet perfectly and mainnet not at all, with no configuration
 * that could fix it.
 *
 * The dangerous half of the fix is the mainnet slot: paste the signet URL into
 * it and nothing fails. Every derived mainnet address comes back unused, and
 * the wallet reports a confident zero where somebody is looking for their real
 * money. That case is asserted first.
 */
describe("Bitcoin indexer overrides", () => {
  it("routes each network to its own host", () => {
    const { overrides, rejected } = resolveBitcoinIndexerOverrides({
      startingNetwork: "signet",
      defaultIndexerUrl: "https://blockstream.info/signet/api",
      perNetworkIndexerUrls: {
        mainnet: "https://blockstream.info/api",
        testnet4: "https://mempool.space/testnet4/api",
      },
    });

    expect(rejected).toHaveLength(0);
    expect(overrides).toEqual({
      mainnet: "https://blockstream.info/api",
      signet: "https://blockstream.info/signet/api",
      testnet4: "https://mempool.space/testnet4/api",
    });
  });

  it("refuses a mainnet host that lives under a testnet path", () => {
    // The copy-paste this configuration shape invites. There is no loud
    // failure for it -- only a zero balance on real money.
    const { overrides, rejected } = resolveBitcoinIndexerOverrides({
      startingNetwork: "signet",
      defaultIndexerUrl: "https://blockstream.info/signet/api",
      perNetworkIndexerUrls: { mainnet: "https://blockstream.info/signet/api" },
    });

    expect(overrides.mainnet).toBeUndefined();
    expect(rejected).toEqual([
      {
        network: "mainnet",
        host: "blockstream.info",
        reason: "a mainnet indexer cannot live under a testnet path",
      },
    ]);
    // Signet is untouched: one bad value must not take the rest with it.
    expect(overrides.signet).toBe("https://blockstream.info/signet/api");
  });

  it("does not second-guess a testnet host with no marker in its path", () => {
    // `https://my-signet-node.internal/api` is perfectly ordinary. The mainnet
    // check is one-directional precisely so this stays configurable.
    const { overrides, rejected } = resolveBitcoinIndexerOverrides({
      startingNetwork: "mainnet",
      defaultIndexerUrl: "https://blockstream.info/api",
      perNetworkIndexerUrls: { signet: "https://my-signet-node.internal/api" },
    });

    expect(rejected).toHaveLength(0);
    expect(overrides.signet).toBe("https://my-signet-node.internal/api");
  });

  it("keeps an existing single-URL configuration working untouched", () => {
    // The migration promise: an `.env.local` written before per-network
    // overrides existed behaves exactly as it did.
    const { overrides } = resolveBitcoinIndexerOverrides({
      startingNetwork: "signet",
      defaultIndexerUrl: "https://blockstream.info/signet/api",
    });

    expect(overrides).toEqual({ signet: "https://blockstream.info/signet/api" });
  });

  it("lets a per-network value win over the generic one for its network", () => {
    const { overrides } = resolveBitcoinIndexerOverrides({
      startingNetwork: "mainnet",
      defaultIndexerUrl: "https://mempool.space/api",
      perNetworkIndexerUrls: { mainnet: "https://blockstream.info/api" },
    });

    expect(overrides.mainnet).toBe("https://blockstream.info/api");
  });

  it("rejects plaintext http, except on loopback", () => {
    const { overrides, rejected } = resolveBitcoinIndexerOverrides({
      startingNetwork: "signet",
      perNetworkIndexerUrls: {
        mainnet: "http://indexer.example/api",
        signet: "http://localhost:3002",
      },
    });

    // A plaintext indexer request carries the user's addresses across their
    // network. A developer's own machine has no third party to hide from.
    expect(overrides.mainnet).toBeUndefined();
    expect(overrides.signet).toBe("http://localhost:3002");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.network).toBe("mainnet");
  });

  it("ignores blank values and reports unparseable ones", () => {
    const { overrides, rejected } = resolveBitcoinIndexerOverrides({
      startingNetwork: "signet",
      defaultIndexerUrl: "   ",
      perNetworkIndexerUrls: { mainnet: "blockstream.info/api" },
    });

    // Blank is "not configured". A typo is a value that will not be applied,
    // and silence there is what leaves someone debugging a host they thought
    // they had changed.
    expect(overrides).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("not a valid URL");
  });
});
