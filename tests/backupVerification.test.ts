import { describe, expect, it } from "vitest";
import { createBackupChallenge, verifyBackupResponse } from "@/core/mnemonic/backupVerification";
import { createMnemonicPhrase } from "@/core/mnemonic/mnemonicPhrase";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("createBackupChallenge", () => {
  it("asks for the requested number of distinct positions", () => {
    const challenge = createBackupChallenge({ phrase: PHRASE, wordCount: 3 });
    expect(challenge.wordPositions).toHaveLength(3);
    expect(new Set(challenge.wordPositions).size).toBe(3);
  });

  it("returns positions in ascending order", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { wordPositions } = createBackupChallenge({ phrase: PHRASE, wordCount: 4 });
      expect([...wordPositions].sort((a, b) => a - b)).toEqual(wordPositions);
    }
  });

  it("stays within the phrase bounds", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const position of createBackupChallenge({ phrase: PHRASE, wordCount: 3 }).wordPositions) {
        expect(position).toBeGreaterThanOrEqual(0);
        expect(position).toBeLessThan(12);
      }
    }
  });

  it("never asks for more words than the phrase contains", () => {
    expect(createBackupChallenge({ phrase: PHRASE, wordCount: 99 }).wordPositions).toHaveLength(12);
  });

  it("samples late positions, not just early ones", () => {
    // Guards against the modulo bias that a naive random % length would
    // introduce, which would leave the tail of the phrase never verified.
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      for (const position of createBackupChallenge({ phrase: PHRASE, wordCount: 1 }).wordPositions) {
        seen.add(position);
      }
    }
    expect(seen.has(11)).toBe(true);
    expect(seen.size).toBe(12);
  });

  it("rejects an empty phrase", () => {
    expect(() => createBackupChallenge({ phrase: "" })).toThrow();
  });
});

describe("verifyBackupResponse", () => {
  const words = PHRASE.split(" ");

  it("accepts the correct words", () => {
    const challenge = createBackupChallenge({ phrase: PHRASE, wordCount: 3 });
    const responses = Object.fromEntries(
      challenge.wordPositions.map((position) => [position, words[position] as string]),
    );
    expect(verifyBackupResponse({ phrase: PHRASE, challenge, responses })).toBe(true);
  });

  it("tolerates stray case and whitespace in user input", () => {
    expect(
      verifyBackupResponse({
        phrase: PHRASE,
        challenge: { wordPositions: [0, 11] },
        responses: { 0: "  ABANDON ", 11: "About" },
      }),
    ).toBe(true);
  });

  it("rejects a wrong word", () => {
    expect(
      verifyBackupResponse({
        phrase: PHRASE,
        challenge: { wordPositions: [0] },
        responses: { 0: "ability" },
      }),
    ).toBe(false);
  });

  it("rejects a missing response", () => {
    expect(
      verifyBackupResponse({
        phrase: PHRASE,
        challenge: { wordPositions: [0, 1] },
        responses: { 0: "abandon" },
      }),
    ).toBe(false);
  });

  it("works for a freshly generated 24-word phrase", () => {
    const phrase = createMnemonicPhrase({ strength: 256 });
    const generatedWords = phrase.split(" ");
    const challenge = createBackupChallenge({ phrase, wordCount: 5 });
    const responses = Object.fromEntries(
      challenge.wordPositions.map((position) => [position, generatedWords[position] as string]),
    );
    expect(verifyBackupResponse({ phrase, challenge, responses })).toBe(true);
  });
});
