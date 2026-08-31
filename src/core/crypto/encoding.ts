/**
 * Byte <-> text encoding helpers.
 *
 * Deliberately dependency-free: every byte of the crypto path should be
 * auditable without reading a third-party package.
 */

const BASE64URL_PADDING = /=+$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(BASE64URL_PADDING, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function decodeHex(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length % 2 !== 0) {
    throw new Error("Hex string must have an even number of characters.");
  }
  if (!/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error("Hex string contains non-hexadecimal characters.");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Constant-time equality.
 *
 * Used for comparing authentication material. A short-circuiting `===` on
 * secrets leaks length and prefix information through timing.
 */
export function equalsConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
