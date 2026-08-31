import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { decodeHex, encodeHex } from "../crypto/encoding";

/**
 * Ethereum address derivation and EIP-55 checksumming.
 *
 * Implemented directly (it is ~20 lines over keccak256) rather than pulled from
 * a chain library, so the `core` layer stays independent of viem/ethers and the
 * whole key-to-address path is auditable in one file.
 */

const ADDRESS_BYTE_LENGTH = 20;

/**
 * An Ethereum address is the last 20 bytes of keccak256 over the UNCOMPRESSED
 * public key with its 0x04 prefix removed — i.e. the raw 64-byte X||Y
 * concatenation. Hashing the 33-byte compressed form, or leaving the 0x04
 * prefix on, both yield a plausible-looking but completely wrong address.
 */
export function deriveAddressFromPublicKey(publicKey: Uint8Array): string {
  let uncompressed = publicKey;
  if (publicKey.length === 33) {
    // Decompress by recovering the curve point and re-serialising uncompressed.
    // NOTE: `getPublicKey` takes a PRIVATE key, so it must never be used here —
    // passing a public key to it silently produces a valid-looking but
    // completely unrelated address.
    uncompressed = secp256k1.Point.fromHex(publicKey).toBytes(false);
  }
  if (uncompressed.length === 65) {
    if (uncompressed[0] !== 0x04) {
      throw new Error("Expected an uncompressed public key with a 0x04 prefix.");
    }
    uncompressed = uncompressed.slice(1);
  }
  if (uncompressed.length !== 64) {
    throw new Error("Public key must be 64 bytes (X||Y) after prefix removal.");
  }
  const hash = keccak_256(uncompressed);
  return toChecksumAddress(`0x${encodeHex(hash.slice(-ADDRESS_BYTE_LENGTH))}`);
}

export function deriveAddressFromPrivateKey(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return deriveAddressFromPublicKey(publicKey);
}

/**
 * EIP-55 mixed-case checksum.
 *
 * Encodes 4 bits of checksum per hex character in the letter casing. It costs
 * nothing to display and catches essentially every single-character typo in a
 * pasted address, which is the difference between a failed paste and an
 * irreversible send to a burn address.
 */
export function toChecksumAddress(address: string): string {
  const normalized = address.toLowerCase().replace(/^0x/, "");
  if (normalized.length !== ADDRESS_BYTE_LENGTH * 2) {
    throw new Error("An Ethereum address must be 20 bytes.");
  }
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("Address contains non-hexadecimal characters.");
  }
  const hash = encodeHex(keccak_256(normalized));
  let checksummed = "0x";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string;
    const hashNibble = Number.parseInt(hash[index] as string, 16);
    checksummed += hashNibble >= 8 ? character.toUpperCase() : character;
  }
  return checksummed;
}

export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Verifies the EIP-55 checksum.
 *
 * An all-lowercase or all-uppercase address carries no checksum and is accepted
 * as unchecksummed rather than rejected, per EIP-55.
 */
export function isValidChecksumAddress(address: string): boolean {
  if (!isValidAddress(address)) return false;
  const withoutPrefix = address.slice(2);
  const isUnchecksummed =
    withoutPrefix === withoutPrefix.toLowerCase() || withoutPrefix === withoutPrefix.toUpperCase();
  if (isUnchecksummed) return true;
  try {
    return toChecksumAddress(address) === address;
  } catch {
    return false;
  }
}

export function isValidPrivateKey(privateKey: Uint8Array | string): boolean {
  try {
    const bytes = typeof privateKey === "string" ? decodeHex(privateKey) : privateKey;
    if (bytes.length !== 32) return false;
    // Must be in [1, n-1]. Zero and values >= the curve order are invalid
    // scalars and would produce an unusable key.
    return secp256k1.utils.isValidSecretKey(bytes);
  } catch {
    return false;
  }
}
