import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type TransactionSerializable } from "viem";
import {
  signPersonalMessageRequest,
  signTransactionRequest,
  signTypedDataRequest,
} from "@/core/signing/signingService";
import { createUnlockedKeyring, UnknownAccountError } from "@/core/keyring/keyring";
import { VaultLockedError } from "@/core/vault/vaultErrors";
import { TypedDataDomainMismatchError } from "@/core/signing/typedDataSigning";
import type { VaultPayload } from "@/core/vault/vaultRecord";

const PRIVATE_KEY_HEX = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY_HEX);

const PAYLOAD: VaultPayload = {
  version: 1,
  keyringSources: [{ type: "privateKey", id: "kr_pk_1", privateKey: PRIVATE_KEY_HEX }],
};

const keyring = createUnlockedKeyring({ payload: PAYLOAD });

describe("signPersonalMessageRequest", () => {
  it("signs through the keyring and recovers to the account", async () => {
    const signature = await signPersonalMessageRequest({
      keyring,
      address: ACCOUNT.address,
      payload: "hello from the service",
    });
    await expect(
      recoverMessageAddress({
        message: "hello from the service",
        signature: signature.hex as `0x${string}`,
      }),
    ).resolves.toBe(ACCOUNT.address);
  });

  it("refuses when the wallet is locked", async () => {
    await expect(
      signPersonalMessageRequest({
        keyring: { status: "locked" },
        address: ACCOUNT.address,
        payload: "nope",
      }),
    ).rejects.toThrow(VaultLockedError);
  });

  it("refuses an address the wallet does not own", async () => {
    await expect(
      signPersonalMessageRequest({ keyring, address: `0x${"de".repeat(20)}`, payload: "nope" }),
    ).rejects.toThrow(UnknownAccountError);
  });
});

describe("signTypedDataRequest", () => {
  const definition = {
    domain: { name: "Test", version: "1", chainId: 1 },
    types: { Msg: [{ name: "text", type: "string" }] },
    primaryType: "Msg",
    message: { text: "hi" },
  } as const;

  it("signs when the domain chain matches", async () => {
    const signature = await signTypedDataRequest({
      keyring,
      address: ACCOUNT.address,
      definition,
      activeChainId: 1,
    });
    expect(signature.hex).toBe(await ACCOUNT.signTypedData(definition));
  });

  /** The guard must fire before any key is lent. */
  it("rejects a cross-chain domain without touching key material", async () => {
    await expect(
      signTypedDataRequest({
        keyring,
        address: ACCOUNT.address,
        definition,
        activeChainId: 11155111,
      }),
    ).rejects.toThrow(TypedDataDomainMismatchError);
  });
});

describe("signTransactionRequest", () => {
  const transaction: TransactionSerializable = {
    type: "eip1559",
    chainId: 11155111,
    nonce: 3,
    to: "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };

  it("matches viem's signed transaction", async () => {
    const signed = await signTransactionRequest({
      keyring,
      address: ACCOUNT.address,
      transaction,
      expectedChainId: 11155111,
    });
    expect(signed.serialized).toBe(await ACCOUNT.signTransaction(transaction));
  });

  it("refuses to sign for the wrong chain", async () => {
    await expect(
      signTransactionRequest({
        keyring,
        address: ACCOUNT.address,
        transaction,
        expectedChainId: 1,
      }),
    ).rejects.toThrow(/targets chain 11155111/);
  });
});
