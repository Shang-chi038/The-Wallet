import { describe, expect, it } from "vitest";
import {
  createMnemonicPhrase,
  deriveSeedFromMnemonic,
  getMnemonicWordCount,
  InvalidMnemonicError,
  isMnemonicWord,
  listMnemonicWordSuggestions,
  normalizeMnemonicPhrase,
  validateMnemonicPhrase,
} from "@/core/mnemonic/mnemonicPhrase";
import { encodeHex } from "@/core/crypto/encoding";

/** The canonical BIP-39 all-zero-entropy vector from the reference test suite. */
const TREZOR_VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TREZOR_VECTOR_SEED_WITH_PASSPHRASE =
  "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";

describe("createMnemonicPhrase", () => {
  it("defaults to a 12-word phrase", () => {
    expect(getMnemonicWordCount(createMnemonicPhrase())).toBe(12);
  });

  it("produces a 24-word phrase at 256-bit strength", () => {
    expect(getMnemonicWordCount(createMnemonicPhrase({ strength: 256 }))).toBe(24);
  });

  it("produces a valid checksum every time", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(validateMnemonicPhrase(createMnemonicPhrase())).toBe(true);
    }
  });

  it("never repeats a phrase across calls", () => {
    const phrases = new Set(Array.from({ length: 50 }, () => createMnemonicPhrase()));
    expect(phrases.size).toBe(50);
  });
});

describe("normalizeMnemonicPhrase", () => {
  it("collapses the whitespace damage that real paper backups produce", () => {
    const messy =
      "  ABANDON\tabandon\n abandon   abandon abandon abandon abandon abandon abandon abandon abandon ABOUT ";
    expect(normalizeMnemonicPhrase(messy)).toBe(TREZOR_VECTOR_PHRASE);
  });

  it("normalizes non-breaking spaces pasted from PDFs", () => {
    const withNonBreakingSpaces = TREZOR_VECTOR_PHRASE.replace(/ /g, "\u00a0");
    expect(normalizeMnemonicPhrase(withNonBreakingSpaces)).toBe(TREZOR_VECTOR_PHRASE);
    expect(validateMnemonicPhrase(withNonBreakingSpaces)).toBe(true);
  });
});

describe("validateMnemonicPhrase", () => {
  it("accepts the reference vector", () => {
    expect(validateMnemonicPhrase(TREZOR_VECTOR_PHRASE)).toBe(true);
  });

  it("rejects a phrase whose checksum word was altered", () => {
    expect(validateMnemonicPhrase(TREZOR_VECTOR_PHRASE.replace(/about$/, "abandon"))).toBe(false);
  });

  it("rejects words outside the BIP-39 wordlist", () => {
    expect(validateMnemonicPhrase(TREZOR_VECTOR_PHRASE.replace("about", "bitcoin"))).toBe(false);
  });

  it("rejects a phrase of invalid length", () => {
    expect(validateMnemonicPhrase("abandon abandon abandon")).toBe(false);
  });
});

describe("deriveSeedFromMnemonic", () => {
  it("matches the published BIP-39 vector for passphrase 'TREZOR'", () => {
    const seed = deriveSeedFromMnemonic({ phrase: TREZOR_VECTOR_PHRASE, passphrase: "TREZOR" });
    expect(encodeHex(seed)).toBe(TREZOR_VECTOR_SEED_WITH_PASSPHRASE);
  });

  it("produces a 64-byte seed", () => {
    expect(deriveSeedFromMnemonic({ phrase: TREZOR_VECTOR_PHRASE }).length).toBe(64);
  });

  it("derives a completely different seed for a different passphrase", () => {
    const withoutPassphrase = deriveSeedFromMnemonic({ phrase: TREZOR_VECTOR_PHRASE });
    const withPassphrase = deriveSeedFromMnemonic({
      phrase: TREZOR_VECTOR_PHRASE,
      passphrase: "hidden",
    });
    expect(encodeHex(withPassphrase)).not.toBe(encodeHex(withoutPassphrase));
  });

  it("treats an empty passphrase as no passphrase", () => {
    const implicit = deriveSeedFromMnemonic({ phrase: TREZOR_VECTOR_PHRASE });
    const explicit = deriveSeedFromMnemonic({ phrase: TREZOR_VECTOR_PHRASE, passphrase: "" });
    expect(encodeHex(implicit)).toBe(encodeHex(explicit));
  });

  it("refuses to derive from an invalid phrase instead of returning garbage", () => {
    expect(() => deriveSeedFromMnemonic({ phrase: "not a real phrase at all" })).toThrow(
      InvalidMnemonicError,
    );
  });
});

describe("wordlist helpers", () => {
  it("suggests words by prefix", () => {
    expect(listMnemonicWordSuggestions("aban")).toContain("abandon");
  });

  it("returns nothing for an empty prefix", () => {
    expect(listMnemonicWordSuggestions("")).toEqual([]);
  });

  it("recognises wordlist membership", () => {
    expect(isMnemonicWord("abandon")).toBe(true);
    expect(isMnemonicWord("ethereum")).toBe(false);
  });
});
