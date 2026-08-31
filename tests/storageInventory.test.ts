import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";
import { VAULT_STORAGE_KEY } from "@/core/vault/vaultStorage";
import { ORIGIN_PERMISSIONS_STORAGE_KEY } from "@/background/originPermissionStore";
import { ACTIVE_CHAIN_STORAGE_KEY, CUSTOM_CHAINS_STORAGE_KEY } from "@/background/networkService";
import { CUSTOM_TOKENS_STORAGE_KEY } from "@/background/tokenService";
import { LOCK_SETTINGS_STORAGE_KEY } from "@/background/lockSettingsStore";
import { SELECTED_ACCOUNT_STORAGE_KEY } from "@/background/selectedAccountStore";
import { OUTSTANDING_TRANSACTIONS_STORAGE_KEY } from "@/background/outstandingTransactionStore";
import { BITCOIN_NETWORK_STORAGE_KEY } from "@/background/bitcoinNetworkStore";
import { BITCOIN_INDEX_HINT_STORAGE_KEY } from "@/background/bitcoinIndexHintStore";
import type { PrepareSendResult, WalletStatusResult } from "@/core/messaging/walletApi";
import {
  createHarness,
  expectResult,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
  TEST_PASSWORD,
  TEST_PHRASE,
  type Harness,
} from "./support/routerHarness";

/**
 * What this wallet leaves on disk.
 *
 * `docs/privacy-policy.md` and the README both make a specific promise: the
 * outstanding-transaction store is the ONLY place this wallet writes a
 * recipient and an amount, everything else is either encrypted or is a
 * preference. That promise is currently kept by ten separate files each
 * choosing to behave, and checked by a human reading them.
 *
 * The gap this closes is not a bug that exists today. It is that the eleventh
 * store -- the one somebody adds next, to cache something helpful -- inherits
 * no check at all. A wallet that starts writing amounts, or addresses, or a
 * decrypted anything, would ship green.
 *
 * So this file does two things a per-store test cannot:
 *
 *   1. Enumerates the storage keys in `src/` and fails if one is not in the
 *      table below. A new store must be declared here, next to what it is
 *      allowed to hold, before its tests can pass.
 *   2. Drives a whole wallet through a realistic life -- create, connect,
 *      import a token, import a key, send, switch networks -- over storage it
 *      can see into, and then reads back every byte that was written.
 */

/** Where the recipient of a send may legitimately appear. Exactly one key. */
const TRANSACTION_DETAIL_KEYS = [OUTSTANDING_TRANSACTIONS_STORAGE_KEY];

interface InventoryEntry {
  /** What the key holds, in one line. */
  holds: string;
  /**
   * True when the value is meaningless to anyone who steals the disk without
   * also having the password. Everything else is readable plaintext, and the
   * point of the table is that the plaintext list stays short and boring.
   */
  encrypted: boolean;
  /** May this key hold a counterparty address or an amount? */
  transactionDetails: boolean;
}

/**
 * THE INVENTORY.
 *
 * Every key this extension may write, and what it is permitted to contain.
 * Adding a row is the deliberate act; the tests below make it the only way.
 */
const STORAGE_INVENTORY: Record<string, InventoryEntry> = {
  [VAULT_STORAGE_KEY]: {
    holds: "the encrypted vault: ciphertext, KDF parameters, salt and IV",
    encrypted: true,
    transactionDetails: false,
  },
  [ORIGIN_PERMISSIONS_STORAGE_KEY]: {
    holds: "which of the user's own addresses each origin may see",
    encrypted: false,
    transactionDetails: false,
  },
  [ACTIVE_CHAIN_STORAGE_KEY]: {
    holds: "the selected chain id",
    encrypted: false,
    transactionDetails: false,
  },
  [CUSTOM_CHAINS_STORAGE_KEY]: {
    holds: "chains added through wallet_addEthereumChain: id, name, RPC URL",
    encrypted: false,
    transactionDetails: false,
  },
  [CUSTOM_TOKENS_STORAGE_KEY]: {
    holds: "imported tokens: contract address, symbol, decimals",
    encrypted: false,
    transactionDetails: false,
  },
  [LOCK_SETTINGS_STORAGE_KEY]: {
    holds: "the auto-lock interval",
    encrypted: false,
    transactionDetails: false,
  },
  [SELECTED_ACCOUNT_STORAGE_KEY]: {
    holds: "which of the user's own accounts the popup last showed",
    encrypted: false,
    transactionDetails: false,
  },
  [OUTSTANDING_TRANSACTIONS_STORAGE_KEY]: {
    /**
     * The documented exception, and the only one. Plaintext because reading it
     * is what makes the Speed up button appear, and that has to work on a
     * wallet that locked itself since the send -- so it cannot be encrypted
     * under a session key that is gone. Bounded three ways: only what this
     * wallet broadcast, deleted as soon as the chain moves past the nonce,
     * expired within a day.
     */
    holds: "recipient, amount and original fees of transactions still in flight",
    encrypted: false,
    transactionDetails: true,
  },
  [BITCOIN_NETWORK_STORAGE_KEY]: {
    holds: "the selected Bitcoin network name",
    encrypted: false,
    transactionDetails: false,
  },
  [BITCOIN_INDEX_HINT_STORAGE_KEY]: {
    holds: "how far the last gap scan got, per network",
    encrypted: false,
    transactionDetails: false,
  },
};

// ---------------------------------------------------------------------------
// A storage area a test can see into
// ---------------------------------------------------------------------------

interface RecordingStorageArea extends KeyValueStorageArea {
  /** Every key ever written, including ones later removed. */
  keysEverWritten(): string[];
  /**
   * Every write, in order, including values later overwritten.
   *
   * The distinction is the whole point and it is easy to get wrong. A secret
   * written at wallet creation and overwritten by the next re-seal is gone
   * from the final state and was still on disk -- and on a real disk an
   * overwrite is a promise about an index, not about the bytes. Assertions
   * about what must NEVER be written read this; assertions about deletion read
   * `snapshot()`.
   */
  writes(): { key: string; value: unknown }[];
  /** What is on disk right now. */
  snapshot(): Map<string, unknown>;
}

/**
 * `KeyValueStorageArea` is get/set/remove and cannot be enumerated, because
 * the real implementation is `chrome.storage.local` and nothing in the wallet
 * has a reason to list it. This one keeps the writes so a test can ask.
 *
 * A key that was written and then removed still counts: it was on disk, and on
 * a real disk "removed" is a promise about an index, not about the bytes.
 */
function createRecordingStorageArea(): RecordingStorageArea {
  const entries = new Map<string, unknown>();
  const written: { key: string; value: unknown }[] = [];

  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      // Serialised, as the real area does.
      const stored = JSON.parse(JSON.stringify(value)) as unknown;
      written.push({ key, value: stored });
      entries.set(key, stored);
    },
    async remove(key) {
      entries.delete(key);
    },
    keysEverWritten() {
      return [...new Set(written.map((entry) => entry.key))];
    },
    writes() {
      return [...written];
    },
    snapshot() {
      return new Map(entries);
    },
  };
}

/**
 * Every string VALUE reachable from a stored record, ignoring keys.
 *
 * Ignoring keys is not tidiness, it is the documented trap: the vault record's
 * own field names contain BIP-39 words -- "text" inside `ciphertext`, "cost"
 * inside `costFactor`, "initial" inside `initializationVector`. A search over
 * the serialised blob matches those and fails about one run in six, on a
 * security assertion, which is exactly how a real leak gets waved through as
 * "the flaky one".
 */
function collectStringValues(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) collectStringValues(nested, found);
  }
  return found;
}

/** Every string ever written, whether or not it survived to the final state. */
function everWrittenStrings(area: RecordingStorageArea): string[] {
  return area.writes().flatMap((entry) => collectStringValues(entry.value));
}

/** As above, restricted to keys the caller does not exempt. */
function everWrittenStringsExcept(
  area: RecordingStorageArea,
  exemptKeys: string[],
): string[] {
  return area
    .writes()
    .filter((entry) => !exemptKeys.includes(entry.key))
    .flatMap((entry) => collectStringValues(entry.value));
}

/** Only what is on disk now. For assertions about deletion. */
function currentlyStoredStrings(area: RecordingStorageArea): string[] {
  return [...area.snapshot().values()].flatMap((value) => collectStringValues(value));
}

// ---------------------------------------------------------------------------
// A wallet that has been used
// ---------------------------------------------------------------------------

/** Distinctive on purpose: a match in stored bytes must mean something. */
const RECIPIENT = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const IMPORTED_PRIVATE_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const IMPORTED_TOKEN = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const SENT_AMOUNT_BASE_UNITS = "12345678901234567";

/**
 * Everything a user does that touches disk, in one wallet.
 *
 * Deliberately not a minimal fixture. The inventory is only as honest as the
 * range of behaviour it was measured over, and a store that writes on an
 * uncommon path is exactly the one that would be missed.
 */
async function usedWallet(): Promise<{ harness: Harness; area: RecordingStorageArea }> {
  const area = createRecordingStorageArea();
  const harness = createHarness({ area });

  await harness.createAndUnlockWallet();
  await harness.connectOrigin();

  await harness.route(
    { method: "wallet.updateLockSettings", params: { autoLockAfterMinutes: 15 } },
    PRIVILEGED_SENDER,
  );

  harness.chain.tokenContracts.set(IMPORTED_TOKEN.toLowerCase(), {
    decimals: 8,
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
  });
  harness.chain.tokenBalances.set(IMPORTED_TOKEN.toLowerCase(), 150_000_000n);
  await harness.route(
    { method: "wallet.importToken", params: { address: IMPORTED_TOKEN, decimals: 8 } },
    PRIVILEGED_SENDER,
  );

  await harness.route({ method: "wallet.addAccount" }, PRIVILEGED_SENDER);
  await harness.route(
    { method: "wallet.importPrivateKey", params: { privateKey: IMPORTED_PRIVATE_KEY } },
    PRIVILEGED_SENDER,
  );

  const status = expectResult<WalletStatusResult>(
    await harness.route({ method: "wallet.getStatus" }, PRIVILEGED_SENDER),
  );
  const secondAccount = status.accounts[1];
  if (secondAccount) {
    await harness.route(
      { method: "wallet.selectAccount", params: { address: secondAccount.address } },
      PRIVILEGED_SENDER,
    );
  }
  await harness.route(
    { method: "wallet.selectAccount", params: { address: TEST_ADDRESS } },
    PRIVILEGED_SENDER,
  );

  // A real send, so the outstanding-transaction store actually has a record.
  const prepared = expectResult<PrepareSendResult>(
    await harness.route(
      {
        method: "wallet.prepareSend",
        params: { recipient: RECIPIENT, amountBaseUnits: SENT_AMOUNT_BASE_UNITS },
      },
      PRIVILEGED_SENDER,
    ),
  );
  await harness.route(
    { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
    PRIVILEGED_SENDER,
  );

  await harness.route(
    { method: "wallet.switchBitcoinNetwork", params: { network: "testnet4" } },
    PRIVILEGED_SENDER,
  );
  await harness.route({ method: "wallet.getBitcoinPortfolio", params: {} }, PRIVILEGED_SENDER);

  // Last, so a chain id the fake client does not serve cannot disturb the send.
  await harness.route({ method: "wallet.switchChain", params: { chainId: 1 } }, PRIVILEGED_SENDER);

  return { harness, area };
}

// ---------------------------------------------------------------------------

describe("the inventory itself", () => {
  /**
   * Finds storage keys in `src/` by their VALUE rather than by the name of the
   * constant holding them, so a key written inline, or held in a constant
   * named something else, is still found. A new store cannot be introduced
   * without either appearing here or breaking this test.
   */
  it("accounts for every storage key in the source tree", () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const keysInSource = new Set<string>();

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        for (const match of readFileSync(path, "utf8").matchAll(/"(wallet\.[A-Za-z]+\.v\d+)"/g)) {
          if (match[1]) keysInSource.add(match[1]);
        }
      }
    };
    walk(sourceRoot);

    expect(keysInSource.size).toBeGreaterThan(0);
    expect([...keysInSource].sort()).toEqual(Object.keys(STORAGE_INVENTORY).sort());
  });

  /**
   * One key is allowed to hold a counterparty and an amount. If a second one
   * ever is, that is a change to what this wallet promises in
   * `docs/privacy-policy.md`, and it should be impossible to make quietly.
   */
  it("permits transaction details in exactly one place", () => {
    const permitted = Object.entries(STORAGE_INVENTORY)
      .filter(([, entry]) => entry.transactionDetails)
      .map(([key]) => key);
    expect(permitted).toEqual(TRANSACTION_DETAIL_KEYS);
  });

  it("encrypts exactly one key, and it is the vault", () => {
    const encrypted = Object.entries(STORAGE_INVENTORY)
      .filter(([, entry]) => entry.encrypted)
      .map(([key]) => key);
    expect(encrypted).toEqual([VAULT_STORAGE_KEY]);
  });
});

describe("what a used wallet has written", () => {
  it("writes nothing that is not in the inventory", async () => {
    const { area } = await usedWallet();
    for (const key of area.keysEverWritten()) {
      expect(STORAGE_INVENTORY[key], `undocumented storage key: ${key}`).toBeDefined();
    }
  });

  /**
   * The lifecycle is only evidence if it actually exercised the stores. Left
   * unchecked, a refactor that stopped persisting something would make the
   * assertions above pass by writing nothing at all.
   */
  it("exercised the stores the lifecycle is supposed to reach", async () => {
    const { area } = await usedWallet();
    const written = area.keysEverWritten();
    for (const expected of [
      VAULT_STORAGE_KEY,
      ORIGIN_PERMISSIONS_STORAGE_KEY,
      ACTIVE_CHAIN_STORAGE_KEY,
      CUSTOM_TOKENS_STORAGE_KEY,
      LOCK_SETTINGS_STORAGE_KEY,
      SELECTED_ACCOUNT_STORAGE_KEY,
      OUTSTANDING_TRANSACTIONS_STORAGE_KEY,
      BITCOIN_NETWORK_STORAGE_KEY,
    ]) {
      expect(written, `nothing wrote ${expected}`).toContain(expected);
    }
  });
});

describe("secret material never reaches disk", () => {
  /**
   * Adjacent word PAIRS, not single words.
   *
   * A single BIP-39 word is three to eight lowercase letters and can occur by
   * chance inside base64. A pair contains a space, and a space cannot occur in
   * base64url at all -- so a match is a real leak rather than a coincidence,
   * and a miss is not luck.
   */
  it("does not contain the recovery phrase", async () => {
    const { area } = await usedWallet();
    const strings = everWrittenStrings(area);
    const words = TEST_PHRASE.split(" ");

    for (let index = 0; index < words.length - 1; index += 1) {
      const pair = `${words[index]} ${words[index + 1]}`;
      for (const stored of strings) {
        expect(stored, `stored value contains "${pair}"`).not.toContain(pair);
      }
    }
  });

  it("does not contain the password", async () => {
    const { area } = await usedWallet();
    for (const stored of everWrittenStrings(area)) {
      expect(stored).not.toContain(TEST_PASSWORD);
    }
  });

  /**
   * An imported key is the case where an unencrypted copy is most tempting:
   * unlike a derived account there is no seed to re-derive it from, so
   * anything that wanted it later would have to keep it. Nothing does.
   */
  it("does not contain an imported private key", async () => {
    const { area } = await usedWallet();
    const bare = IMPORTED_PRIVATE_KEY.slice(2);
    for (const stored of everWrittenStrings(area)) {
      expect(stored.toLowerCase()).not.toContain(bare.toLowerCase());
    }
  });

  it("stores the vault as ciphertext and nothing else", async () => {
    const { area } = await usedWallet();
    const vaultWrites = area.writes().filter((entry) => entry.key === VAULT_STORAGE_KEY);
    expect(vaultWrites.length).toBeGreaterThan(0);

    /**
     * Every string in the record must be opaque: base64url payloads, an
     * algorithm name, a version. An address, a `0x` hex string or a space
     * would mean something readable got written beside the ciphertext.
     */
    for (const stored of vaultWrites.flatMap((entry) => collectStringValues(entry.value))) {
      expect(stored).not.toContain(" ");
      expect(stored.toLowerCase()).not.toContain(TEST_ADDRESS.toLowerCase());
      expect(stored).toMatch(/^[A-Za-z0-9_\-+/=.]*$/);
    }
  });
});

describe("transaction details", () => {
  /**
   * THE claim this file exists to pin, from `docs/privacy-policy.md`: the
   * outstanding-transaction store is the only place a recipient and an amount
   * are written down.
   *
   * `pendingTransactionLog` and `preparedTransactionStore` hold the same
   * shapes and are memory-only, which is a decision recorded in a comment and
   * nowhere else. If either ever gains a storage area, the recipient shows up
   * in a second key and this fails.
   */
  it("appear under the outstanding-transaction key and nowhere else", async () => {
    const { area } = await usedWallet();

    const inOutstanding = collectStringValues(
      area.snapshot().get(OUTSTANDING_TRANSACTIONS_STORAGE_KEY),
    );
    expect(inOutstanding.some((value) => value.toLowerCase().includes(RECIPIENT.toLowerCase()))).toBe(
      true,
    );

    for (const stored of everWrittenStringsExcept(area, TRANSACTION_DETAIL_KEYS)) {
      expect(stored.toLowerCase()).not.toContain(RECIPIENT.toLowerCase());
      expect(stored).not.toContain(SENT_AMOUNT_BASE_UNITS);
    }
  });

  /**
   * The record is deleted the moment the chain moves past its nonce -- the
   * chain is the authority, not the record -- so the plaintext is transient by
   * construction rather than by a cleanup that has to be remembered.
   */
  it("are gone once the chain has moved past the nonce", async () => {
    const { harness, area } = await usedWallet();

    /**
     * Back to the chain the send went out on first. `reconcile` deletes only
     * records matching the chain and account it was asked about -- correctly,
     * since one chain's confirmed nonce says nothing about another's -- so
     * reconciling from the wrong chain would leave the record in place and
     * this test would be asserting against its own sequencing.
     */
    await harness.route(
      { method: "wallet.switchChain", params: { chainId: harness.chain.chainId } },
      PRIVILEGED_SENDER,
    );
    harness.chain.confirmedNonce = harness.chain.pendingNonce + 10;
    await harness.route({ method: "wallet.listStuckTransactions" }, PRIVILEGED_SENDER);

    for (const stored of currentlyStoredStrings(area)) {
      expect(stored.toLowerCase()).not.toContain(RECIPIENT.toLowerCase());
    }
  });
});
