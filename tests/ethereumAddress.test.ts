import { describe, expect, it } from "vitest";
import {
  deriveAddressFromPrivateKey,
  deriveAddressFromPublicKey,
  isValidAddress,
  isValidChecksumAddress,
  isValidPrivateKey,
  toChecksumAddress,
} from "@/core/account/ethereumAddress";
import { decodeHex } from "@/core/crypto/encoding";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** The four checksum examples published in EIP-55 itself. */
const EIP55_VECTORS = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("toChecksumAddress", () => {
  it.each(EIP55_VECTORS)("reproduces the EIP-55 vector %s", (expected) => {
    expect(toChecksumAddress(expected.toLowerCase())).toBe(expected);
  });

  it("is idempotent", () => {
    for (const vector of EIP55_VECTORS) {
      expect(toChecksumAddress(toChecksumAddress(vector))).toBe(vector);
    }
  });

  it("rejects an address of the wrong length", () => {
    expect(() => toChecksumAddress("0xdeadbeef")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => toChecksumAddress(`0x${"z".repeat(40)}`)).toThrow();
  });
});

describe("isValidChecksumAddress", () => {
  it("accepts correctly checksummed addresses", () => {
    for (const vector of EIP55_VECTORS) expect(isValidChecksumAddress(vector)).toBe(true);
  });

  it("accepts all-lowercase addresses as unchecksummed, per EIP-55", () => {
    expect(isValidChecksumAddress(EIP55_VECTORS[0]!.toLowerCase())).toBe(true);
  });

  it("rejects an address with a single flipped case bit", () => {
    const vector = EIP55_VECTORS[0]!;
    expect(isValidChecksumAddress(`0x5A${vector.slice(4)}`)).toBe(false);
  });
});

describe("deriveAddressFromPrivateKey", () => {
  /**
   * Private key 0x01 has a well-known corresponding address; the simplest
   * end-to-end check that key -> pubkey -> keccak -> address is wired right.
   */
  it("derives the known address for private key = 1", () => {
    const privateKey = decodeHex(`0x${"00".repeat(31)}01`);
    expect(deriveAddressFromPrivateKey(privateKey)).toBe(
      "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    );
  });

  it("returns a checksummed address", () => {
    const address = deriveAddressFromPrivateKey(secp256k1.utils.randomSecretKey());
    expect(isValidChecksumAddress(address)).toBe(true);
    expect(toChecksumAddress(address)).toBe(address);
  });

  /** Regression guard: decompression must not route through getPublicKey. */
  it("agrees whether given the compressed or uncompressed public key", () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    expect(deriveAddressFromPublicKey(secp256k1.getPublicKey(privateKey, true))).toBe(
      deriveAddressFromPublicKey(secp256k1.getPublicKey(privateKey, false)),
    );
  });

  it("rejects a 65-byte public key given with a bogus prefix byte", () => {
    const corrupted = Uint8Array.from(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false),
    );
    corrupted[0] = 0x05;
    expect(() => deriveAddressFromPublicKey(corrupted)).toThrow();
  });
});

describe("isValidPrivateKey", () => {
  it("accepts a freshly generated key", () => {
    expect(isValidPrivateKey(secp256k1.utils.randomSecretKey())).toBe(true);
  });

  it("rejects the zero scalar", () => {
    expect(isValidPrivateKey(new Uint8Array(32))).toBe(false);
  });

  it("rejects a scalar at or above the curve order", () => {
    expect(
      isValidPrivateKey("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
    ).toBe(false);
  });

  it("rejects keys of the wrong length", () => {
    expect(isValidPrivateKey(new Uint8Array(31))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(33))).toBe(false);
  });
});

describe("isValidAddress", () => {
  it("checks shape only", () => {
    expect(isValidAddress(`0x${"a".repeat(40)}`)).toBe(true);
    expect(isValidAddress(`0x${"a".repeat(39)}`)).toBe(false);
    expect(isValidAddress("a".repeat(40))).toBe(false);
  });
});
