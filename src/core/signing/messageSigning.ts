import { keccak_256 } from "@noble/hashes/sha3.js";
import { decodeHex, encodeHex, encodeUtf8 } from "../crypto/encoding";
import { serializeSignature, signDigest, type SerializedSignature } from "./signature";

/**
 * EIP-191 `personal_sign`.
 *
 * The prefix IS the security mechanism, so it is worth stating why. Raw ECDSA
 * over arbitrary bytes cannot distinguish a "login challenge" from an
 * RLP-encoded transaction. Without domain separation, a malicious site could
 * ask a user to "sign this message to verify your wallet" where the bytes are
 * in fact a transaction draining their balance — and the resulting signature
 * would be valid on chain.
 *
 * EIP-191 prepends "\x19Ethereum Signed Message:\n<byteLength>". The leading
 * 0x19 byte is not a valid RLP prefix for a transaction, so a personal_sign
 * signature can never be replayed as one. Any code path that signs without this
 * prefix is a critical vulnerability.
 */

export const EIP191_PREFIX = "Ethereum Signed Message:\n";

/**
 * Hashes a message per EIP-191.
 *
 * The length is the BYTE length, not the character count. For any message with
 * non-ASCII characters those differ, and using the character count yields a
 * signature that every other client rejects.
 */
export function hashPersonalMessage(message: string | Uint8Array): Uint8Array {
  const messageBytes = typeof message === "string" ? encodeUtf8(message) : message;
  const prefixBytes = encodeUtf8(`\x19${EIP191_PREFIX}${messageBytes.length}`);
  const payload = new Uint8Array(prefixBytes.length + messageBytes.length);
  payload.set(prefixBytes, 0);
  payload.set(messageBytes, prefixBytes.length);
  return keccak_256(payload);
}

/**
 * dApps send personal_sign payloads as hex more often than as text. Signing a
 * hex string as literal characters produces a signature the dApp cannot verify,
 * so decode when the payload is unambiguously hex.
 */
export function normalizePersonalSignPayload(payload: string): Uint8Array {
  if (/^0x[0-9a-fA-F]*$/.test(payload) && payload.length % 2 === 0) {
    return decodeHex(payload);
  }
  return encodeUtf8(payload);
}

export function signPersonalMessage(
  message: string | Uint8Array,
  privateKey: Uint8Array,
): SerializedSignature {
  return serializeSignature(signDigest(hashPersonalMessage(message), privateKey));
}

export interface PersonalMessagePreview {
  displayText: string;
  /** True when the payload is not printable text — the user is blind-signing. */
  isBinary: boolean;
  byteLength: number;
}

/**
 * Renders a personal_sign payload for the approval screen.
 *
 * Binary payloads are shown as hex rather than pushed through a lossy UTF-8
 * decode, and flagged, so the UI can warn that the user is approving opaque
 * bytes the wallet cannot explain to them.
 */
export function createPersonalMessagePreview(payload: string): PersonalMessagePreview {
  const bytes = normalizePersonalSignPayload(payload);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // U+FFFD means the bytes were not valid UTF-8. Control characters mean the
  // text may be spoofed or unreadable. Either way, do not present it as prose.
  const hasReplacementChar = decoded.includes("�");
  const hasControlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded);
  const isBinary = hasReplacementChar || hasControlChars;
  return {
    displayText: isBinary ? `0x${encodeHex(bytes)}` : decoded,
    isBinary,
    byteLength: bytes.length,
  };
}
