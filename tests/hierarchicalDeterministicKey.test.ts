import { describe, expect, it } from "vitest";
import {
  deriveAccountKeyFromMnemonic,
  deriveAccountKeyFromSeed,
  deriveAccountSummariesFromSeed,
} from "@/core/account/hierarchicalDeterministicKey";
import { deriveSeedFromMnemonic } from "@/core/mnemonic/mnemonicPhrase";
import { createEthereumDerivationPath } from "@/core/account/derivationPath";
import { isValidChecksumAddress } from "@/core/account/ethereumAddress";

const TEST_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Cross-wallet compatibility vector.
 *
 * These are the addresses MetaMask, Ledger Live and Rainbow all show for this
 * phrase. If this test ever fails, a phrase created here will not restore
 * correctly in another wallet — the single worst failure mode this codebase can
 * have, so it is asserted explicitly rather than snapshotted.
 */
const EXPECTED_ADDRESSES = [
  "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
  "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A",
];

describe("deriveAccountSummariesFromSeed", () => {
  it("reproduces the canonical BIP-44 addresses for the reference phrase", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    expect(deriveAccountSummariesFromSeed({ seed, count: 3 }).map((a) => a.address)).toEqual(
      EXPECTED_ADDRESSES,
    );
  });

  it("uses the standard m/44'/60'/0'/0/i path", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    const [first, second] = deriveAccountSummariesFromSeed({ seed, count: 2 });
    expect(first?.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(second?.derivationPath).toBe("m/44'/60'/0'/0/1");
  });

  it("does not expose private keys in summaries", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    const [summary] = deriveAccountSummariesFromSeed({ seed, count: 1 });
    expect(summary).not.toHaveProperty("privateKey");
  });

  it("returns an empty list for a count of zero", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    expect(deriveAccountSummariesFromSeed({ seed, count: 0 })).toEqual([]);
  });

  it("is deterministic across repeated derivations", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    expect(deriveAccountSummariesFromSeed({ seed, count: 5 })).toEqual(
      deriveAccountSummariesFromSeed({ seed, count: 5 }),
    );
  });
});

describe("deriveAccountKeyFromSeed", () => {
  it("returns a 32-byte private key whose address matches the summary", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    const account = deriveAccountKeyFromSeed({ seed, addressIndex: 0 });
    expect(account.privateKey.length).toBe(32);
    expect(account.address).toBe(EXPECTED_ADDRESSES[0]);
    expect(isValidChecksumAddress(account.address)).toBe(true);
  });

  it("derives distinct keys per index", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TEST_PHRASE });
    expect(deriveAccountKeyFromSeed({ seed, addressIndex: 0 }).address).not.toBe(
      deriveAccountKeyFromSeed({ seed, addressIndex: 1 }).address,
    );
  });
});

describe("deriveAccountKeyFromMnemonic", () => {
  it("derives a different wallet when a BIP-39 passphrase is used", () => {
    const withoutPassphrase = deriveAccountKeyFromMnemonic({
      phrase: TEST_PHRASE,
      addressIndex: 0,
    });
    const withPassphrase = deriveAccountKeyFromMnemonic({
      phrase: TEST_PHRASE,
      passphrase: "my hidden wallet",
      addressIndex: 0,
    });
    expect(withPassphrase.address).not.toBe(withoutPassphrase.address);
    expect(withoutPassphrase.address).toBe(EXPECTED_ADDRESSES[0]);
  });
});

describe("createEthereumDerivationPath", () => {
  it("rejects negative and non-integer indices", () => {
    expect(() => createEthereumDerivationPath({ addressIndex: -1 })).toThrow();
    expect(() => createEthereumDerivationPath({ addressIndex: 1.5 })).toThrow();
  });

  it("rejects indices in the hardened range", () => {
    expect(() => createEthereumDerivationPath({ addressIndex: 2 ** 31 })).toThrow();
  });
});
