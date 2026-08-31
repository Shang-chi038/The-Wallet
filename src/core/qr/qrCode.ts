import { computeErrorCorrection } from "./galoisField";

/**
 * A minimal QR encoder: byte mode, error-correction level M, versions 1-10.
 *
 * ===========================================================================
 * WHY THIS IS WRITTEN RATHER THAN INSTALLED
 * ===========================================================================
 * This is a wallet, and the README states the position plainly: the dependency
 * tree is the whole of our supply-chain surface. A QR library is a package that
 * renders the very string a stranger scans before sending money -- exactly the
 * kind of thing worth being able to read end to end. So it is ~300 lines here,
 * restricted to the one mode and one correction level a receive screen needs.
 *
 * ===========================================================================
 * THE FAILURE MODE, AND WHAT ACTUALLY GUARDS AGAINST IT
 * ===========================================================================
 * A bug here encodes the wrong address, someone scans it, and the money is
 * gone. That is severe enough that "we wrote tests" is not sufficient on its
 * own, so there are three independent guards:
 *
 *   1. The receive screen ALWAYS renders the full checksummed address as text
 *      beneath the code. The QR is a convenience; the text is the record.
 *   2. The capacity table below is cross-checked in tests against the published
 *      ISO/IEC 18004 byte-mode capacities, which we did not derive.
 *   3. Reed-Solomon output is verified by its defining property -- the encoded
 *      codeword's syndromes are zero -- rather than by comparison against our
 *      own output, which would prove nothing.
 *
 * Anything that does not fit version 10 throws. A truncated QR is far worse
 * than no QR, because it still scans.
 */

/** Error-correction level M: recovers ~15% damage. The usual screen default. */
const EC_LEVEL_M_FORMAT_BITS = 0b00;

interface VersionSpec {
  /** Error-correction codewords per block. */
  ecCodewordsPerBlock: number;
  /** [blockCount, dataCodewordsPerBlock] for each group. */
  groups: readonly (readonly [number, number])[];
}

/**
 * ISO/IEC 18004 Table 9, error-correction level M.
 *
 * Total data codewords are the sum over groups; byte-mode capacity is derived
 * from that in `byteCapacity`, and the tests check the derivation against the
 * standard's own published capacity figures. That cross-check is what makes
 * this table trustworthy without a second implementation to compare to.
 */
const VERSION_SPECS: Record<number, VersionSpec> = {
  1: { ecCodewordsPerBlock: 10, groups: [[1, 16]] },
  2: { ecCodewordsPerBlock: 16, groups: [[1, 28]] },
  3: { ecCodewordsPerBlock: 26, groups: [[1, 44]] },
  4: { ecCodewordsPerBlock: 18, groups: [[2, 32]] },
  5: { ecCodewordsPerBlock: 24, groups: [[2, 43]] },
  6: { ecCodewordsPerBlock: 16, groups: [[4, 27]] },
  7: { ecCodewordsPerBlock: 18, groups: [[4, 31]] },
  8: { ecCodewordsPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { ecCodewordsPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { ecCodewordsPerBlock: 26, groups: [[4, 43], [1, 44]] },
};

export const MAX_SUPPORTED_VERSION = 10;

/** Alignment-pattern centre coordinates, ISO/IEC 18004 Annex E. */
const ALIGNMENT_CENTERS: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** Pre-computed 18-bit BCH version information, versions 7-10. */
const VERSION_INFORMATION: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

export class QrCapacityError extends Error {
  readonly code = "qr_capacity_exceeded";
  constructor(byteLength: number) {
    super(`${byteLength} bytes does not fit a version-${MAX_SUPPORTED_VERSION} QR code.`);
    this.name = "QrCapacityError";
  }
}

export function totalDataCodewords(version: number): number {
  const spec = VERSION_SPECS[version];
  if (!spec) throw new Error(`Unsupported QR version ${version}.`);
  return spec.groups.reduce((sum, [blocks, perBlock]) => sum + blocks * perBlock, 0);
}

/** Bits in the character-count indicator: 8 for versions 1-9, 16 for 10+. */
export function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Maximum byte-mode payload for a version at level M. */
export function byteCapacity(version: number): number {
  const availableBits = totalDataCodewords(version) * 8;
  // 4-bit mode indicator plus the character-count indicator.
  return Math.floor((availableBits - 4 - characterCountBits(version)) / 8);
}

export function selectVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_SUPPORTED_VERSION; version += 1) {
    if (byteLength <= byteCapacity(version)) return version;
  }
  throw new QrCapacityError(byteLength);
}

export interface QrMatrix {
  version: number;
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
}

/**
 * Encodes text as a QR matrix.
 *
 * The text is UTF-8 encoded. Ethereum addresses and EIP-681 URIs are ASCII, so
 * byte mode carries them exactly; the encoder does not attempt the alphanumeric
 * mode, which would be denser but cannot represent lowercase hex.
 */
export function encodeQrCode(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = selectVersion(data.length);
  const codewords = buildCodewords(data, version);

  const size = 17 + version * 4;
  const modules: (boolean | undefined)[][] = Array.from({ length: size }, () =>
    new Array<boolean | undefined>(size).fill(undefined),
  );

  drawFunctionPatterns(modules, version, size);
  const reserved = markReserved(size, version);
  placeCodewords(modules, codewords, size, reserved);

  // The mask that makes the code most readable, chosen by the standard's own
  // penalty rules. Picking a fixed mask produces valid but harder-to-scan codes,
  // and "harder to scan" on a receive screen means a user retyping an address.
  const { masked, maskPattern } = applyBestMask(modules as boolean[][], reserved, size);
  drawFormatInformation(masked, maskPattern, size);
  if (version >= 7) drawVersionInformation(masked, version, size);

  return { version, size, modules: masked };
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(): number[] {
    const codewords: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) {
        byte = (byte << 1) | (this.bits[index + offset] ?? 0);
      }
      codewords.push(byte);
    }
    return codewords;
  }
}

function buildCodewords(data: Uint8Array, version: number): number[] {
  const spec = VERSION_SPECS[version] as VersionSpec;
  const dataCodewordCount = totalDataCodewords(version);

  const writer = new BitWriter();
  writer.write(0b0100, 4); // byte mode
  writer.write(data.length, characterCountBits(version));
  for (const byte of data) writer.write(byte, 8);

  // Terminator: up to four zero bits, truncated if the capacity is nearly full.
  const remainingBits = dataCodewordCount * 8 - writer.length;
  writer.write(0, Math.min(4, remainingBits));
  // Pad to a byte boundary.
  if (writer.length % 8 !== 0) writer.write(0, 8 - (writer.length % 8));

  const codewords = writer.toCodewords();
  // The standard's alternating pad bytes. Not arbitrary: they are chosen to
  // avoid patterns that would confuse a scanner.
  const PAD_BYTES = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewordCount) {
    codewords.push(PAD_BYTES[padIndex % 2] as number);
    padIndex += 1;
  }

  // Split into blocks, error-correct each, then INTERLEAVE. Interleaving is what
  // makes the correction useful: a scratch across the code damages one codeword
  // in many blocks rather than many codewords in one, and each block can recover
  // from a small number of errors.
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [blockCount, perBlock] of spec.groups) {
    for (let index = 0; index < blockCount; index += 1) {
      const block = codewords.slice(offset, offset + perBlock);
      offset += perBlock;
      dataBlocks.push(block);
      ecBlocks.push(computeErrorCorrection(block, spec.ecCodewordsPerBlock));
    }
  }

  const interleaved: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));
  for (let index = 0; index < longestData; index += 1) {
    for (const block of dataBlocks) {
      if (index < block.length) interleaved.push(block[index] as number);
    }
  }
  for (let index = 0; index < spec.ecCodewordsPerBlock; index += 1) {
    for (const block of ecBlocks) interleaved.push(block[index] as number);
  }

  return interleaved;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function drawFunctionPatterns(
  modules: (boolean | undefined)[][],
  version: number,
  size: number,
): void {
  const set = (row: number, column: number, dark: boolean): void => {
    if (row < 0 || column < 0 || row >= size || column >= size) return;
    (modules[row] as (boolean | undefined)[])[column] = dark;
  };

  // Finder patterns, with their separators, at three corners.
  for (const [originRow, originColumn] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const inRing =
          (row >= 0 && row <= 6 && (column === 0 || column === 6)) ||
          (column >= 0 && column <= 6 && (row === 0 || row === 6));
        const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        set(originRow + row, originColumn + column, inRing || inCore);
      }
    }
  }

  // Timing patterns: alternating modules that let a scanner establish the grid.
  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    set(6, index, dark);
    set(index, 6, dark);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const centerRow of centers) {
    for (const centerColumn of centers) {
      const onFinder =
        (centerRow === 6 && centerColumn === 6) ||
        (centerRow === 6 && centerColumn === size - 7) ||
        (centerRow === size - 7 && centerColumn === 6);
      if (onFinder) continue;
      for (let row = -2; row <= 2; row += 1) {
        for (let column = -2; column <= 2; column += 1) {
          const dark = Math.max(Math.abs(row), Math.abs(column)) !== 1;
          set(centerRow + row, centerColumn + column, dark);
        }
      }
    }
  }

  // The dark module. Always set, always here.
  set(size - 8, 8, true);
}

/** Modules that carry function patterns or format/version info, not data. */
function markReserved(size: number, version: number): boolean[][] {
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const reserve = (row: number, column: number): void => {
    if (row < 0 || column < 0 || row >= size || column >= size) return;
    (reserved[row] as boolean[])[column] = true;
  };

  for (const [originRow, originColumn] of [
    [0, 0],
    [0, size - 8],
    [size - 8, 0],
  ] as const) {
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) reserve(originRow + row, originColumn + column);
    }
  }

  for (let index = 0; index < size; index += 1) {
    reserve(6, index);
    reserve(index, 6);
  }

  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const centerRow of centers) {
    for (const centerColumn of centers) {
      const onFinder =
        (centerRow === 6 && centerColumn === 6) ||
        (centerRow === 6 && centerColumn === size - 7) ||
        (centerRow === size - 7 && centerColumn === 6);
      if (onFinder) continue;
      for (let row = -2; row <= 2; row += 1) {
        for (let column = -2; column <= 2; column += 1) reserve(centerRow + row, centerColumn + column);
      }
    }
  }

  // Format information strips, and the dark module.
  for (let index = 0; index < 9; index += 1) {
    reserve(8, index);
    reserve(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    reserve(8, size - 1 - index);
    reserve(size - 1 - index, 8);
  }

  if (version >= 7) {
    for (let index = 0; index < 6; index += 1) {
      for (let offset = 0; offset < 3; offset += 1) {
        reserve(size - 11 + offset, index);
        reserve(index, size - 11 + offset);
      }
    }
  }

  return reserved;
}

/**
 * The zigzag placement: two-module-wide columns walked upward then downward
 * from the bottom right, skipping the vertical timing column.
 */
function placeCodewords(
  modules: (boolean | undefined)[][],
  codewords: readonly number[],
  size: number,
  reserved: readonly boolean[][],
): void {
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the pairing shifts left past it.
    if (right === 6) right = 5;

    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if ((reserved[row] as boolean[])[column]) continue;

        const byte = codewords[bitIndex >>> 3] ?? 0;
        const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        (modules[row] as (boolean | undefined)[])[column] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const MASK_FUNCTIONS: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

function applyBestMask(
  modules: readonly boolean[][],
  reserved: readonly boolean[][],
  size: number,
): { masked: boolean[][]; maskPattern: number } {
  let best: { masked: boolean[][]; maskPattern: number; penalty: number } | undefined;

  for (let maskPattern = 0; maskPattern < MASK_FUNCTIONS.length; maskPattern += 1) {
    const mask = MASK_FUNCTIONS[maskPattern] as (row: number, column: number) => boolean;
    const candidate = modules.map((row, rowIndex) =>
      row.map((dark, columnIndex) =>
        (reserved[rowIndex] as boolean[])[columnIndex]
          ? dark
          : dark !== mask(rowIndex, columnIndex),
      ),
    );
    const penalty = computeMaskPenalty(candidate, size);
    if (!best || penalty < best.penalty) best = { masked: candidate, maskPattern, penalty };
  }

  return best as { masked: boolean[][]; maskPattern: number };
}

/**
 * ISO/IEC 18004 penalty rules.
 *
 * These score how hard a masked code is for a scanner: long same-colour runs,
 * solid blocks, patterns resembling a finder, and an unbalanced dark/light
 * ratio. Lowest score wins.
 */
function computeMaskPenalty(modules: readonly boolean[][], size: number): number {
  let penalty = 0;

  // Rule 1: runs of five or more identical modules, in each direction.
  for (let index = 0; index < size; index += 1) {
    for (const line of [
      (offset: number) => (modules[index] as boolean[])[offset] as boolean,
      (offset: number) => (modules[offset] as boolean[])[index] as boolean,
    ]) {
      let runLength = 1;
      for (let offset = 1; offset < size; offset += 1) {
        if (line(offset) === line(offset - 1)) {
          runLength += 1;
          if (runLength === 5) penalty += 3;
          else if (runLength > 5) penalty += 1;
        } else {
          runLength = 1;
        }
      }
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = (modules[row] as boolean[])[column];
      if (
        value === (modules[row] as boolean[])[column + 1] &&
        value === (modules[row + 1] as boolean[])[column] &&
        value === (modules[row + 1] as boolean[])[column + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns, which a scanner may mistake for a
  // real finder and misalign the whole grid.
  const FINDER = [true, false, true, true, true, false, true];
  const hasPattern = (
    read: (offset: number) => boolean | undefined,
    start: number,
  ): boolean => FINDER.every((expected, offset) => read(start + offset) === expected);

  for (let index = 0; index < size; index += 1) {
    for (let start = 0; start <= size - 7; start += 1) {
      const readRow = (offset: number) => (modules[index] as boolean[])[offset];
      const readColumn = (offset: number) => (modules[offset] as boolean[] | undefined)?.[index];
      for (const read of [readRow, readColumn]) {
        if (!hasPattern(read, start)) continue;
        const beforeLight = [start - 4, start - 3, start - 2, start - 1].every(
          (offset) => offset < 0 || read(offset) === false,
        );
        const afterLight = [start + 7, start + 8, start + 9, start + 10].every(
          (offset) => offset >= size || read(offset) === false,
        );
        if (beforeLight || afterLight) penalty += 40;
      }
    }
  }

  // Rule 4: deviation from an even dark/light split.
  let darkCount = 0;
  for (const row of modules) for (const dark of row) if (dark) darkCount += 1;
  const percentage = (darkCount * 100) / (size * size);
  penalty += Math.floor(Math.abs(percentage - 50) / 5) * 10;

  return penalty;
}

// ---------------------------------------------------------------------------
// Format and version information
// ---------------------------------------------------------------------------

/**
 * 15-bit BCH format information: five data bits (EC level and mask), ten check
 * bits, XORed with 0x5412 so an all-zero format is never a valid pattern.
 */
export function computeFormatInformation(ecLevelBits: number, maskPattern: number): number {
  const data = (ecLevelBits << 3) | maskPattern;
  let remainder = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((remainder >>> index) & 1) remainder ^= 0b10100110111 << (index - 10);
  }
  return ((data << 10) | remainder) ^ 0b101010000010010;
}

function drawFormatInformation(modules: boolean[][], maskPattern: number, size: number): void {
  const bits = computeFormatInformation(EC_LEVEL_M_FORMAT_BITS, maskPattern);
  const bitAt = (index: number): boolean => ((bits >>> index) & 1) === 1;

  // Written twice, in two places, so a damaged corner does not make the code
  // unreadable.
  for (let index = 0; index <= 5; index += 1) (modules[8] as boolean[])[index] = bitAt(index);
  (modules[8] as boolean[])[7] = bitAt(6);
  (modules[8] as boolean[])[8] = bitAt(7);
  (modules[7] as boolean[])[8] = bitAt(8);
  for (let index = 9; index <= 14; index += 1) {
    (modules[14 - index] as boolean[])[8] = bitAt(index);
  }

  for (let index = 0; index <= 7; index += 1) {
    (modules[size - 1 - index] as boolean[])[8] = bitAt(index);
  }
  for (let index = 8; index <= 14; index += 1) {
    (modules[8] as boolean[])[size - 15 + index] = bitAt(index);
  }
}

function drawVersionInformation(modules: boolean[][], version: number, size: number): void {
  const bits = VERSION_INFORMATION[version];
  if (bits === undefined) return;
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = size - 11 + (index % 3);
    (modules[row] as boolean[])[column] = dark;
    (modules[column] as boolean[])[row] = dark;
  }
}
