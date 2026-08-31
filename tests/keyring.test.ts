import { describe, expect, it } from "vitest";
import {
  addHdAccount,
  assertUnlocked,
  createUnlockedKeyring,
  isUnlocked,
  lockKeyring,
  toVaultPayload,
  UnknownAccountError,
  withAccountPrivateKey,
} from "@/core/keyring/keyring";
import { VaultLockedError } from "@/core/vault/vaultErrors";
import type { VaultPayload } from "@/core/vault/vaultRecord";
import { deriveAddressFromPrivateKey } from "@/core/account/ethereumAddress";
import { decodeHex, encodeHex } from "@/core/crypto/encoding";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FIRST_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SECOND_ADDRESS = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
const IMPORTED_PRIVATE_KEY = `0x${"11".repeat(32)}`;

function buildPayload(): VaultPayload {
  return {
    version: 1,
    keyringSources: [
      { type: "hd", id: "kr_hd_1", mnemonic: PHRASE, passphrase: "", accountCount: 2 },
      { type: "privateKey", id: "kr_pk_1", privateKey: IMPORTED_PRIVATE_KEY },
    ],
  };
}

describe("createUnlockedKeyring", () => {
  it("derives HD accounts and imported accounts together", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    expect(keyring.accounts.map((account) => account.address)).toEqual([
      FIRST_ADDRESS,
      SECOND_ADDRESS,
      deriveAddressFromPrivateKey(decodeHex(IMPORTED_PRIVATE_KEY)),
    ]);
  });

  it("tags each account with its source type", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    expect(keyring.accounts.map((account) => account.source)).toEqual(["hd", "hd", "privateKey"]);
  });

  it("does not retain private keys on the account records", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    for (const account of keyring.accounts) {
      expect(account).not.toHaveProperty("privateKey");
    }
    expect(JSON.stringify(keyring.accounts)).not.toContain("11111111");
  });

  it("reports HD derivation paths", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    expect(keyring.accounts[0]?.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(keyring.accounts[1]?.derivationPath).toBe("m/44'/60'/0'/0/1");
  });
});

describe("withAccountPrivateKey", () => {
  it("lends the correct key for an HD account", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    const address = await withAccountPrivateKey({
      keyring,
      address: FIRST_ADDRESS,
      operation: (privateKey) => deriveAddressFromPrivateKey(privateKey),
    });
    expect(address).toBe(FIRST_ADDRESS);
  });

  it("lends the correct key for an imported account", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    const imported = keyring.accounts[2]!;
    const hex = await withAccountPrivateKey({
      keyring,
      address: imported.address,
      operation: (privateKey) => encodeHex(privateKey),
    });
    expect(`0x${hex}`).toBe(IMPORTED_PRIVATE_KEY);
  });

  it("matches addresses case-insensitively", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    await expect(
      withAccountPrivateKey({
        keyring,
        address: FIRST_ADDRESS.toLowerCase(),
        operation: () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  /** The core guarantee: the buffer is dead the moment the operation returns. */
  it("zeroizes the lent key after the operation completes", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    let retained: Uint8Array | undefined;
    await withAccountPrivateKey({
      keyring,
      address: FIRST_ADDRESS,
      operation: (privateKey) => {
        retained = privateKey;
        expect(privateKey.some((byte) => byte !== 0)).toBe(true);
      },
    });
    expect(retained).toBeDefined();
    expect(retained!.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroizes the lent key even when the operation throws", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    let retained: Uint8Array | undefined;
    await expect(
      withAccountPrivateKey({
        keyring,
        address: FIRST_ADDRESS,
        operation: (privateKey) => {
          retained = privateKey;
          throw new Error("signer exploded");
        },
      }),
    ).rejects.toThrow("signer exploded");
    expect(retained!.every((byte) => byte === 0)).toBe(true);
  });

  it("refuses an address the wallet does not own", async () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    await expect(
      withAccountPrivateKey({
        keyring,
        address: `0x${"de".repeat(20)}`,
        operation: () => "unreachable",
      }),
    ).rejects.toThrow(UnknownAccountError);
  });

  it("refuses to sign while locked", async () => {
    await expect(
      withAccountPrivateKey({
        keyring: { status: "locked" },
        address: FIRST_ADDRESS,
        operation: () => "unreachable",
      }),
    ).rejects.toThrow(VaultLockedError);
  });
});

describe("addHdAccount", () => {
  it("appends the next sequential account", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    const extended = addHdAccount({ keyring, keyringSourceId: "kr_hd_1" });
    expect(extended.accounts).toHaveLength(4);
    expect(extended.accounts[2]?.address).toBe("0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A");
  });

  it("bumps accountCount so the change survives a re-seal", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    const payload = toVaultPayload(addHdAccount({ keyring, keyringSourceId: "kr_hd_1" }));
    expect(payload.keyringSources.find((s) => s.type === "hd")).toMatchObject({ accountCount: 3 });
  });

  it("rejects an unknown keyring source", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    expect(() => addHdAccount({ keyring, keyringSourceId: "nope" })).toThrow();
  });
});

describe("lockKeyring", () => {
  it("returns the locked sentinel", () => {
    expect(isUnlocked(lockKeyring(createUnlockedKeyring({ payload: buildPayload() })))).toBe(false);
  });

  it("clears secret material from the previously unlocked object", () => {
    const keyring = createUnlockedKeyring({ payload: buildPayload() });
    const sources = keyring.sources;
    lockKeyring(keyring);
    expect(sources).toHaveLength(0);
    expect(JSON.stringify(keyring)).not.toContain("abandon");
  });

  it("makes assertUnlocked throw afterwards", () => {
    const locked = lockKeyring(createUnlockedKeyring({ payload: buildPayload() }));
    expect(() => assertUnlocked(locked)).toThrow(VaultLockedError);
  });
});
