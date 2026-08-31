import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  recoverMessageAddress,
  recoverTypedDataAddress,
  verifyMessage,
  type TypedDataDefinition,
  type TransactionSerializable,
} from "viem";
import {
  createPersonalMessagePreview,
  hashPersonalMessage,
  normalizePersonalSignPayload,
  signPersonalMessage,
} from "@/core/signing/messageSigning";
import {
  assertDomainMatchesChain,
  createTypedDataPreview,
  signTypedData,
  TypedDataDomainMismatchError,
} from "@/core/signing/typedDataSigning";
import {
  assertSignableTransaction,
  signTransaction,
  UnsignableTransactionError,
} from "@/core/signing/transactionSigning";
import { signDigest, serializeSignature } from "@/core/signing/signature";
import { decodeHex, encodeHex } from "@/core/crypto/encoding";
import { deriveAddressFromPrivateKey } from "@/core/account/ethereumAddress";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * viem is used here as an INDEPENDENT ORACLE, not as a convenience. Our signing
 * path is noble + our own EIP-191 framing; viem's is a separate implementation.
 * Agreement between the two is meaningful evidence of correctness in a way that
 * testing our code against itself would not be.
 */
const PRIVATE_KEY_HEX = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const PRIVATE_KEY = decodeHex(PRIVATE_KEY_HEX);
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY_HEX);

describe("address derivation agrees with viem", () => {
  it("derives the same address from the same key", () => {
    expect(deriveAddressFromPrivateKey(PRIVATE_KEY)).toBe(ACCOUNT.address);
  });
});

describe("personal_sign (EIP-191)", () => {
  it("produces a signature viem verifies", async () => {
    const message = "Hello, wallet!";
    const signature = signPersonalMessage(message, PRIVATE_KEY);
    await expect(
      verifyMessage({
        address: ACCOUNT.address,
        message,
        signature: signature.hex as `0x${string}`,
      }),
    ).resolves.toBe(true);
  });

  it("recovers to the signing address", async () => {
    const message = "recover me";
    const signature = signPersonalMessage(message, PRIVATE_KEY);
    await expect(
      recoverMessageAddress({ message, signature: signature.hex as `0x${string}` }),
    ).resolves.toBe(ACCOUNT.address);
  });

  it("byte-for-byte matches viem's own signMessage", async () => {
    const message = "exact match required";
    expect(signPersonalMessage(message, PRIVATE_KEY).hex).toBe(
      await ACCOUNT.signMessage({ message }),
    );
  });

  /** Byte length, not character count — differs for any non-ASCII message. */
  it("uses byte length for multi-byte characters", async () => {
    const message = "héllo 世界 🚀";
    expect(signPersonalMessage(message, PRIVATE_KEY).hex).toBe(
      await ACCOUNT.signMessage({ message }),
    );
  });

  it("applies the 0x19 prefix, so the digest is not a bare keccak of the message", () => {
    const message = "not raw";
    expect(encodeHex(hashPersonalMessage(message))).not.toBe(
      encodeHex(keccak_256(new TextEncoder().encode(message))),
    );
  });

  it("signs an empty message", async () => {
    expect(signPersonalMessage("", PRIVATE_KEY).hex).toBe(
      await ACCOUNT.signMessage({ message: "" }),
    );
  });

  it("emits v as 27 or 28", () => {
    for (const message of ["a", "b", "c", "d", "e"]) {
      expect([27, 28]).toContain(signPersonalMessage(message, PRIVATE_KEY).v);
    }
  });
});

describe("personal_sign payload normalization", () => {
  it("decodes hex payloads to bytes", () => {
    expect(encodeHex(normalizePersonalSignPayload("0xdeadbeef"))).toBe("deadbeef");
  });

  it("treats non-hex payloads as UTF-8 text", () => {
    expect(new TextDecoder().decode(normalizePersonalSignPayload("hello"))).toBe("hello");
  });

  it("matches viem when a dApp sends a hex payload", async () => {
    const hexPayload = "0x48656c6c6f"; // "Hello"
    const ours = signPersonalMessage(normalizePersonalSignPayload(hexPayload), PRIVATE_KEY);
    const theirs = await ACCOUNT.signMessage({ message: { raw: hexPayload as `0x${string}` } });
    expect(ours.hex).toBe(theirs);
  });
});

describe("createPersonalMessagePreview", () => {
  it("shows readable text as text", () => {
    expect(createPersonalMessagePreview("Sign in to Example")).toMatchObject({
      displayText: "Sign in to Example",
      isBinary: false,
    });
  });

  /** The user must be told when they are approving bytes we cannot explain. */
  it("flags non-UTF8 payloads as binary and shows hex", () => {
    const preview = createPersonalMessagePreview("0xdeadbeeffeed");
    expect(preview.isBinary).toBe(true);
    expect(preview.displayText).toBe("0xdeadbeeffeed");
  });

  it("reports byte length, not character count", () => {
    expect(createPersonalMessagePreview("héllo").byteLength).toBe(6);
  });
});

describe("EIP-712 typed data", () => {
  const definition: TypedDataDefinition = {
    domain: {
      name: "Ether Mail",
      version: "1",
      chainId: 1,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    types: {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "address" },
      ],
      Mail: [
        { name: "from", type: "Person" },
        { name: "to", type: "Person" },
        { name: "contents", type: "string" },
      ],
    },
    primaryType: "Mail",
    message: {
      from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
      to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
      contents: "Hello, Bob!",
    },
  };

  it("matches viem's signTypedData byte for byte", async () => {
    expect(signTypedData(definition, PRIVATE_KEY).hex).toBe(await ACCOUNT.signTypedData(definition));
  });

  it("recovers to the signing address", async () => {
    const ours = signTypedData(definition, PRIVATE_KEY);
    await expect(
      recoverTypedDataAddress({ ...definition, signature: ours.hex as `0x${string}` }),
    ).resolves.toBe(ACCOUNT.address);
  });

  /** Cross-chain replay: a signature for chain 1 must not be issued on Sepolia. */
  it("rejects a domain naming a different chain", () => {
    expect(() => assertDomainMatchesChain(definition, 11155111)).toThrow(
      TypedDataDomainMismatchError,
    );
  });

  it("accepts a matching domain chain", () => {
    expect(() => assertDomainMatchesChain(definition, 1)).not.toThrow();
  });

  /**
   * viem's TypedDataDefinition types chainId as number|bigint, but dApps send it
   * over JSON-RPC as a hex STRING. Our validator must handle the wire reality,
   * not just the type, so the cast here is deliberate.
   */
  it("accepts hex-encoded domain chain IDs from the wire", () => {
    const hexDomain = {
      ...definition,
      domain: { ...definition.domain, chainId: "0x1" },
    } as unknown as TypedDataDefinition;
    expect(() => assertDomainMatchesChain(hexDomain, 1)).not.toThrow();
  });

  it("allows a domain with no chainId", () => {
    const noChain = {
      ...definition,
      domain: { name: "Ether Mail" },
    } as unknown as TypedDataDefinition;
    expect(() => assertDomainMatchesChain(noChain, 1)).not.toThrow();
  });

  it("flattens nested messages into readable rows", () => {
    const preview = createTypedDataPreview(definition);
    expect(preview).toContainEqual({ path: "from.name", value: "Cow" });
    expect(preview).toContainEqual({ path: "contents", value: "Hello, Bob!" });
  });
});

describe("transaction signing (EIP-1559)", () => {
  const transaction: TransactionSerializable = {
    type: "eip1559",
    chainId: 11155111,
    nonce: 7,
    to: "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
    value: 1_000_000_000_000_000n,
    gas: 21_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  };

  it("matches viem's signTransaction byte for byte", async () => {
    const ours = signTransaction({
      transaction,
      expectedChainId: 11155111,
      privateKey: PRIVATE_KEY,
    });
    expect(ours.serialized).toBe(await ACCOUNT.signTransaction(transaction));
  });

  /** EIP-155: a transaction with no chain ID is replayable on every EVM chain. */
  it("refuses to sign a transaction with no chain ID", () => {
    const { chainId: _omitted, ...withoutChainId } = transaction;
    expect(() =>
      assertSignableTransaction(withoutChainId as TransactionSerializable, 11155111),
    ).toThrow(UnsignableTransactionError);
  });

  it("refuses to sign for a chain the wallet is not on", () => {
    expect(() => assertSignableTransaction(transaction, 1)).toThrow(/targets chain 11155111/);
  });

  it("refuses to sign without a nonce", () => {
    const { nonce: _omitted, ...withoutNonce } = transaction;
    expect(() => assertSignableTransaction(withoutNonce as TransactionSerializable, 11155111)).toThrow(
      /no nonce/,
    );
  });

  it("produces a transaction hash", () => {
    const ours = signTransaction({
      transaction,
      expectedChainId: 11155111,
      privateKey: PRIVATE_KEY,
    });
    expect(ours.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("signature invariants", () => {
  const digest = keccak_256(new TextEncoder().encode("invariants"));

  /** RFC 6979: a repeated or predictable nonce leaks the private key outright. */
  it("is deterministic for the same key and digest", () => {
    expect(serializeSignature(signDigest(digest, PRIVATE_KEY)).hex).toBe(
      serializeSignature(signDigest(digest, PRIVATE_KEY)).hex,
    );
  });

  it("produces different signatures for different digests", () => {
    const other = keccak_256(new TextEncoder().encode("different"));
    expect(serializeSignature(signDigest(digest, PRIVATE_KEY)).hex).not.toBe(
      serializeSignature(signDigest(other, PRIVATE_KEY)).hex,
    );
  });

  /** EIP-2: high-s signatures are malleable and invalid on Ethereum. */
  it("always emits low-s signatures", () => {
    const curveOrderHalf = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    for (let index = 0; index < 30; index += 1) {
      const message = keccak_256(new TextEncoder().encode(`msg-${index}`));
      expect(signDigest(message, PRIVATE_KEY).s).toBeLessThanOrEqual(curveOrderHalf);
    }
  });

  it("rejects a digest that is not 32 bytes", () => {
    expect(() => signDigest(new Uint8Array(31), PRIVATE_KEY)).toThrow(/32 bytes/);
  });

  it("serializes to 65 bytes", () => {
    expect(serializeSignature(signDigest(digest, PRIVATE_KEY)).hex).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
