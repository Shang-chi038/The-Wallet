import { describe, expect, it } from "vitest";
import { createMemoryStorageArea } from "@/core/vault/vaultStorage";
import {
  BitcoinNetworkStore,
  BITCOIN_NETWORK_STORAGE_KEY,
} from "@/background/bitcoinNetworkStore";

/**
 * The network picker is only a setting if the choice outlives the worker.
 *
 * MV3 collects the service worker constantly and this wallet treats that as a
 * feature, so "held in a field on BitcoinService" -- what this replaced -- is
 * indistinguishable from a control that silently reverts. What it reverts
 * BETWEEN is mainnet and a test network, which is the difference between a
 * real balance and a confident zero under the same heading.
 */
describe("BitcoinNetworkStore", () => {
  it("answers the configured network before anything is chosen", async () => {
    const store = new BitcoinNetworkStore({
      area: createMemoryStorageArea(),
      fallback: "signet",
    });
    await store.load();

    expect(store.get()).toBe("signet");
  });

  it("keeps the chosen network across a worker restart", async () => {
    const area = createMemoryStorageArea();
    const beforeRestart = new BitcoinNetworkStore({ area, fallback: "signet" });
    await beforeRestart.load();
    await beforeRestart.select("mainnet");

    // A second instance over the same storage IS the restart: the worker was
    // collected and every in-memory field went with it.
    const afterRestart = new BitcoinNetworkStore({ area, fallback: "signet" });
    await afterRestart.load();

    expect(afterRestart.get()).toBe("mainnet");
  });

  /**
   * Input, not state. A value this build cannot describe would make
   * `findBitcoinNetwork` throw on every Bitcoin read -- including the read
   * behind the picker that would let the user choose their way out of it.
   */
  it("discards a stored network it does not recognise", async () => {
    const area = createMemoryStorageArea();
    await area.set(BITCOIN_NETWORK_STORAGE_KEY, "mainet");

    const store = new BitcoinNetworkStore({ area, fallback: "signet" });
    await store.load();

    expect(store.get()).toBe("signet");
  });

  it("refuses to store a network it does not recognise", async () => {
    const store = new BitcoinNetworkStore({
      area: createMemoryStorageArea(),
      fallback: "signet",
    });
    await store.load();

    await expect(
      store.select("dogecoin" as unknown as "mainnet"),
    ).rejects.toThrow(/Unsupported Bitcoin network/);
    expect(store.get()).toBe("signet");
  });

  it("returns to the configured network when cleared", async () => {
    const area = createMemoryStorageArea();
    const store = new BitcoinNetworkStore({ area, fallback: "testnet4" });
    await store.load();
    await store.select("mainnet");

    await store.clear();

    expect(store.get()).toBe("testnet4");
    expect(await area.get(BITCOIN_NETWORK_STORAGE_KEY)).toBeUndefined();
  });
});
