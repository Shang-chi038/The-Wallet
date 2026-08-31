import { describe, expect, it } from "vitest";
import {
  abbreviateEnsName,
  InvalidEnsNameError,
  isEnsNameCandidate,
  normalizeEnsName,
} from "@/core/ens/ensName";

/**
 * A name is the softest target in a send flow: unlike an address it is not
 * self-verifying, and the user cannot check the mapping by looking at it.
 */

const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

describe("routing input to the right validator", () => {
  it("never treats a valid address as a name", () => {
    expect(isEnsNameCandidate(ADDRESS)).toBe(false);
    expect(isEnsNameCandidate(ADDRESS.toLowerCase())).toBe(false);
  });

  it("recognises dotted names, not only .eth", () => {
    expect(isEnsNameCandidate("vitalik.eth")).toBe(true);
    // ENS supports DNS-imported names, so the TLD is not hardcoded.
    expect(isEnsNameCandidate("example.com")).toBe(true);
    expect(isEnsNameCandidate("deep.sub.eth")).toBe(true);
  });

  it("rejects things that are neither", () => {
    expect(isEnsNameCandidate("")).toBe(false);
    expect(isEnsNameCandidate("   ")).toBe(false);
    expect(isEnsNameCandidate("nodots")).toBe(false);
    expect(isEnsNameCandidate("has space.eth")).toBe(false);
    expect(isEnsNameCandidate("0xnotanaddress")).toBe(false);
  });
});

describe("normalisation", () => {
  it("leaves an already-normal name alone", () => {
    const result = normalizeEnsName("vitalik.eth");
    expect(result.normalized).toBe("vitalik.eth");
    expect(result.wasChanged).toBe(false);
  });

  it("folds case, and says that it did", () => {
    const result = normalizeEnsName("Vitalik.ETH");
    expect(result.normalized).toBe("vitalik.eth");
    // Innocent here, but the SAME signal a substitution produces -- which is
    // why the UI shows the resolved form rather than what was typed.
    expect(result.wasChanged).toBe(true);
    expect(result.entered).toBe("Vitalik.ETH");
  });

  /**
   * THE HOMOGRAPH CASE.
   *
   * U+0430 CYRILLIC SMALL LETTER A renders identically to Latin 'a' in most
   * fonts. It is named here rather than written, so that a reviewer grepping
   * this repository for confusable characters finds only the escape below.
   * ENSIP-15 refuses the mixed-script name, and so must we: resolving it would
   * resolve a name no registrar legitimately issued, owned by someone else,
   * that the user cannot distinguish by eye.
   */
  it("refuses a mixed-script confusable rather than resolving it", () => {
    // U+0430 CYRILLIC SMALL LETTER A, written as an escape rather than pasted:
    // an invisible or confusable character in source is unreviewable, and this
    // codebase has been bitten by that twice already.
    const confusable = "vit\u0430lik.eth";
    expect(confusable).not.toBe("vitalik.eth");
    expect(() => normalizeEnsName(confusable)).toThrow(InvalidEnsNameError);
  });

  it("refuses characters ENS disallows outright", () => {
    // U+200D ZERO WIDTH JOINER: invisible, and would make two different names
    // render identically on screen.
    expect(() => normalizeEnsName("vita\u200Dlik.eth")).toThrow(InvalidEnsNameError);
  });

  it("refuses empty input rather than producing an empty name", () => {
    expect(() => normalizeEnsName("   ")).toThrow(InvalidEnsNameError);
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(normalizeEnsName("  vitalik.eth \n").normalized).toBe("vitalik.eth");
  });

  /** Emoji names are legal ENS and must not be swept up by the confusable rules. */
  it("accepts a name ENSIP-15 considers valid", () => {
    expect(normalizeEnsName("\u{1F643}.eth").normalized).toBe("\u{1F643}.eth");
  });
});

describe("abbreviation", () => {
  it("leaves short names intact", () => {
    expect(abbreviateEnsName("vitalik.eth")).toBe("vitalik.eth");
  });

  /**
   * The suffix survives truncation. Dropping it would hide the very part that
   * tells the user what kind of name they are looking at.
   */
  it("keeps the suffix when shortening", () => {
    const abbreviated = abbreviateEnsName("averyveryverylongname.eth", 16);
    expect(abbreviated.endsWith(".eth")).toBe(true);
    expect(abbreviated.length).toBeLessThanOrEqual(16);
  });

  it("handles a name with no dot without throwing", () => {
    expect(abbreviateEnsName("x".repeat(40), 12)).toHaveLength(12);
  });
});
