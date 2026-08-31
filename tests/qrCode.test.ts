import { describe, expect, it } from "vitest";
import {
  buildGeneratorPolynomial,
  computeErrorCorrection,
  evaluateAt,
  fieldExp,
  fieldLog,
  fieldMultiply,
} from "@/core/qr/galoisField";
import {
  byteCapacity,
  computeFormatInformation,
  encodeQrCode,
  QrCapacityError,
  selectVersion,
  totalDataCodewords,
} from "@/core/qr/qrCode";

/**
 * A wrong QR encodes a wrong address, someone scans it, and the money is gone.
 * "We wrote it ourselves and it looked right" is not a standard this can be
 * held to, so every check below is against something we did NOT derive:
 *
 *   - GF(256) is checked on its own algebraic identities.
 *   - Reed-Solomon is checked by its defining property (zero syndromes), not by
 *     comparison against our own output, which would prove nothing.
 *   - Capacities are checked against the published ISO/IEC 18004 figures.
 *   - Format information is checked against the standard's own bit strings.
 *   - The matrix is checked against the structural rules in the specification.
 */

describe("GF(256)", () => {
  it("satisfies log/exp inversion across the field", () => {
    for (let power = 0; power < 255; power += 1) {
      expect(fieldLog(fieldExp(power))).toBe(power);
    }
  });

  it("has a multiplicative identity and annihilator", () => {
    for (let value = 1; value < 256; value += 1) {
      expect(fieldMultiply(value, 1)).toBe(value);
      expect(fieldMultiply(value, 0)).toBe(0);
    }
  });

  it("is commutative and associative", () => {
    for (let a = 1; a < 40; a += 1) {
      for (let b = 1; b < 40; b += 1) {
        expect(fieldMultiply(a, b)).toBe(fieldMultiply(b, a));
        expect(fieldMultiply(fieldMultiply(a, b), 7)).toBe(fieldMultiply(a, fieldMultiply(b, 7)));
      }
    }
  });

  it("gives every non-zero element an inverse", () => {
    for (let value = 1; value < 256; value += 1) {
      const inverse = fieldExp(255 - fieldLog(value));
      expect(fieldMultiply(value, inverse)).toBe(1);
    }
  });

  it("builds a generator polynomial of the requested degree", () => {
    for (const degree of [10, 16, 18, 22, 24, 26]) {
      expect(buildGeneratorPolynomial(degree)).toHaveLength(degree + 1);
    }
  });
});

describe("Reed-Solomon", () => {
  /**
   * THE defining property. An RS codeword is constructed so that it evaluates
   * to zero at each of the generator's roots; a decoder detects errors by
   * finding a non-zero syndrome. Checking it here verifies the encoder against
   * the mathematics rather than against itself.
   */
  it("produces codewords whose syndromes are all zero", () => {
    const data = Array.from({ length: 16 }, (_value, index) => (index * 37 + 11) % 256);
    for (const ecLength of [10, 16, 18, 22, 24, 26]) {
      const codeword = [...data, ...computeErrorCorrection(data, ecLength)];
      for (let power = 0; power < ecLength; power += 1) {
        expect(evaluateAt(codeword, power), `syndrome ${power} for ec=${ecLength}`).toBe(0);
      }
    }
  });

  it("detects a single-byte corruption as a non-zero syndrome", () => {
    const data = Array.from({ length: 16 }, (_value, index) => index);
    const codeword = [...data, ...computeErrorCorrection(data, 10)];
    codeword[3] = (codeword[3] as number) ^ 0xff;

    const syndromes = Array.from({ length: 10 }, (_value, power) => evaluateAt(codeword, power));
    expect(syndromes.some((syndrome) => syndrome !== 0)).toBe(true);
  });

  it("emits exactly the requested number of correction codewords", () => {
    expect(computeErrorCorrection([1, 2, 3], 10)).toHaveLength(10);
    expect(computeErrorCorrection([1, 2, 3], 26)).toHaveLength(26);
  });
});

describe("capacity table", () => {
  /**
   * ISO/IEC 18004 Table 7, byte mode, error-correction level M.
   *
   * These figures are published, not derived here. The block layout in
   * `VERSION_SPECS` is what produces them, so agreement across all ten versions
   * is strong evidence the layout table was transcribed correctly -- a
   * mistranscribed block count would shift the capacity and show up instantly.
   */
  const PUBLISHED_BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

  it.each(PUBLISHED_BYTE_CAPACITY_M.map((capacity, index) => [index + 1, capacity]))(
    "version %i holds %i bytes at level M",
    (version, capacity) => {
      expect(byteCapacity(version as number)).toBe(capacity);
    },
  );

  it("picks the smallest version that fits", () => {
    expect(selectVersion(14)).toBe(1);
    expect(selectVersion(15)).toBe(2);
    // A checksummed Ethereum address is exactly 42 characters.
    expect(selectVersion(42)).toBe(3);
    expect(selectVersion(213)).toBe(10);
  });

  /**
   * A truncated QR is worse than no QR, because it still scans -- and what it
   * scans is a corrupted address. Refusing is the only safe answer.
   */
  it("refuses rather than truncating what does not fit", () => {
    expect(() => selectVersion(214)).toThrow(QrCapacityError);
  });

  it("keeps total data codewords consistent with the block groups", () => {
    expect(totalDataCodewords(1)).toBe(16);
    expect(totalDataCodewords(8)).toBe(2 * 38 + 2 * 39);
    expect(totalDataCodewords(10)).toBe(4 * 43 + 1 * 44);
  });
});

describe("format information", () => {
  /**
   * ISO/IEC 18004 Table 25, error-correction level M, masks 0-7. Published bit
   * strings, transcribed as-is; the BCH implementation has to reproduce them.
   */
  const PUBLISHED_FORMAT_M = [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ];

  it.each(PUBLISHED_FORMAT_M.map((bits, mask) => [mask, bits]))(
    "mask %i encodes to %s",
    (mask, bits) => {
      const value = computeFormatInformation(0b00, mask as number);
      expect(value.toString(2).padStart(15, "0")).toBe(bits);
    },
  );
});

describe("matrix structure", () => {
  const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

  it("sizes the matrix as 17 + 4 * version", () => {
    for (const text of ["hi", ADDRESS, "x".repeat(200)]) {
      const code = encodeQrCode(text);
      expect(code.size).toBe(17 + code.version * 4);
      expect(code.modules).toHaveLength(code.size);
      for (const row of code.modules) expect(row).toHaveLength(code.size);
    }
  });

  /**
   * The three finder patterns are what a scanner locates first. A single wrong
   * module here and nothing scans at all -- which is a safe failure, but still
   * worth catching before a user meets it.
   */
  it("places the 7x7 finder pattern at three corners", () => {
    const { modules, size } = encodeQrCode(ADDRESS);
    const expectedRing = (row: number, column: number): boolean => {
      const inRing =
        (row >= 0 && row <= 6 && (column === 0 || column === 6)) ||
        (column >= 0 && column <= 6 && (row === 0 || row === 6));
      const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
      return inRing || inCore;
    };

    for (const [originRow, originColumn] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 7; column += 1) {
          expect(
            (modules[originRow + row] as boolean[])[originColumn + column],
            `finder at ${originRow + row},${originColumn + column}`,
          ).toBe(expectedRing(row, column));
        }
      }
    }
  });

  it("alternates the timing patterns on row and column six", () => {
    const { modules, size } = encodeQrCode(ADDRESS);
    for (let index = 8; index < size - 8; index += 1) {
      const expected = index % 2 === 0;
      expect((modules[6] as boolean[])[index], `horizontal timing at ${index}`).toBe(expected);
      expect((modules[index] as boolean[])[6], `vertical timing at ${index}`).toBe(expected);
    }
  });

  /** Always dark, at (4 * version + 9, 8). Its absence breaks decoding. */
  it("sets the dark module", () => {
    const code = encodeQrCode(ADDRESS);
    expect((code.modules[4 * code.version + 9] as boolean[])[8]).toBe(true);
  });

  /**
   * Format information is written twice so a damaged corner does not make the
   * code unreadable. Both copies must say the same thing -- and must be one of
   * the eight published level-M patterns.
   */
  it("writes two agreeing copies of the format information", () => {
    const { modules, size } = encodeQrCode(ADDRESS);

    const primary: number[] = [];
    for (let index = 0; index <= 5; index += 1) primary.push(bit(modules, 8, index));
    primary.push(bit(modules, 8, 7), bit(modules, 8, 8), bit(modules, 7, 8));
    for (let index = 9; index <= 14; index += 1) primary.push(bit(modules, 14 - index, 8));

    const secondary: number[] = [];
    for (let index = 0; index <= 7; index += 1) secondary.push(bit(modules, size - 1 - index, 8));
    for (let index = 8; index <= 14; index += 1) secondary.push(bit(modules, 8, size - 15 + index));

    expect(secondary).toEqual(primary);

    const value = primary.reduce((sum, b, index) => sum | (b << index), 0);
    const published = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => computeFormatInformation(0b00, mask));
    expect(published).toContain(value);
  });

  it("produces a mixed matrix rather than a blank or solid one", () => {
    const { modules, size } = encodeQrCode(ADDRESS);
    const dark = modules.flat().filter(Boolean).length;
    // A solid or near-solid matrix means placement or masking collapsed.
    expect(dark).toBeGreaterThan(size * size * 0.2);
    expect(dark).toBeLessThan(size * size * 0.8);
  });

  /**
   * Determinism matters for a UI that re-renders: the same address must always
   * produce the same picture, or the receive screen appears to flicker between
   * two different codes and the user cannot tell which one is real.
   */
  it("is deterministic", () => {
    expect(encodeQrCode(ADDRESS)).toEqual(encodeQrCode(ADDRESS));
  });

  it("encodes an EIP-681 payment URI, which is longer than a bare address", () => {
    const code = encodeQrCode(`ethereum:${ADDRESS}@11155111`);
    expect(code.version).toBeGreaterThanOrEqual(3);
    expect(code.size).toBe(17 + code.version * 4);
  });
});

function bit(modules: readonly boolean[][], row: number, column: number): number {
  return (modules[row] as boolean[])[column] ? 1 : 0;
}
