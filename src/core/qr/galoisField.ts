/**
 * GF(256) arithmetic for Reed-Solomon.
 *
 * The field QR codes use: byte values as elements, arithmetic modulo the
 * primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), with 2 as a
 * generator. Addition is XOR; multiplication goes through log/antilog tables
 * because a table lookup is exact and a loop is where sign and overflow bugs
 * live.
 *
 * Separated from the encoder so the field can be tested on its own identities
 * -- a * a^-1 == 1, log(exp(n)) == n -- which is a real check rather than a
 * comparison against our own output.
 */

const PRIMITIVE_POLYNOMIAL = 0x11d;

const EXPONENTIALS = new Uint8Array(512);
const LOGARITHMS = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXPONENTIALS[index] = value;
    LOGARITHMS[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= PRIMITIVE_POLYNOMIAL;
  }
  // Doubled so a product of two logs (max 254 + 254) indexes without a modulo.
  for (let index = 255; index < 512; index += 1) {
    EXPONENTIALS[index] = EXPONENTIALS[index - 255] as number;
  }
}

export function fieldExp(power: number): number {
  return EXPONENTIALS[((power % 255) + 255) % 255] as number;
}

export function fieldLog(value: number): number {
  if (value === 0) throw new Error("log(0) is undefined in GF(256).");
  return LOGARITHMS[value] as number;
}

export function fieldMultiply(left: number, right: number): number {
  // Zero has no logarithm, so it is special-cased rather than clamped.
  if (left === 0 || right === 0) return 0;
  return EXPONENTIALS[(LOGARITHMS[left] as number) + (LOGARITHMS[right] as number)] as number;
}

/** Polynomial product, coefficients highest-order first. */
export function polynomialMultiply(
  left: readonly number[],
  right: readonly number[],
): number[] {
  const product = new Array<number>(left.length + right.length - 1).fill(0);
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      product[i + j] = (product[i + j] as number) ^ fieldMultiply(left[i] as number, right[j] as number);
    }
  }
  return product;
}

/**
 * The RS generator polynomial for `degree` error-correction codewords:
 * (x - a^0)(x - a^1)...(x - a^(degree-1)).
 */
export function buildGeneratorPolynomial(degree: number): number[] {
  let generator = [1];
  for (let index = 0; index < degree; index += 1) {
    generator = polynomialMultiply(generator, [1, fieldExp(index)]);
  }
  return generator;
}

/**
 * Reed-Solomon error-correction codewords for one block.
 *
 * Polynomial long division of the data (shifted left by `ecLength`) by the
 * generator; the remainder is the EC codewords. The defining property -- and
 * the one worth testing independently -- is that the full codeword, data
 * followed by these, evaluates to zero at a^0 .. a^(ecLength-1).
 */
export function computeErrorCorrection(
  data: readonly number[],
  ecLength: number,
): number[] {
  const generator = buildGeneratorPolynomial(ecLength);
  const remainder = [...data, ...new Array<number>(ecLength).fill(0)];

  for (let index = 0; index < data.length; index += 1) {
    const factor = remainder[index] as number;
    if (factor === 0) continue;
    for (let offset = 0; offset < generator.length; offset += 1) {
      remainder[index + offset] =
        (remainder[index + offset] as number) ^
        fieldMultiply(generator[offset] as number, factor);
    }
  }

  return remainder.slice(data.length);
}

/**
 * Evaluates a codeword polynomial at a^power. Used by tests to confirm the
 * syndromes of an encoded block are zero -- an independent check of the encoder
 * that does not compare it against itself.
 */
export function evaluateAt(codeword: readonly number[], power: number): number {
  let result = 0;
  for (const coefficient of codeword) {
    result = fieldMultiply(result, fieldExp(power)) ^ coefficient;
  }
  return result;
}
