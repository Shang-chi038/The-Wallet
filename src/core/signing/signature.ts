import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encodeHex } from "../crypto/encoding";

/**
 * ECDSA signature production over secp256k1.
 *
 * All signing in the wallet funnels through here, so the invariants below hold
 * everywhere by construction rather than by convention at each call site.
 *
 * TWO PROPERTIES THAT MUST NOT REGRESS:
 *
 * 1. LOW-S NORMALISATION. For any valid signature (r, s), the pair (r, n - s)
 *    is equally valid. Leaving s in the upper half makes signatures malleable:
 *    a third party can rewrite a pending transaction's signature, changing its
 *    hash without invalidating it. EIP-2 makes high-s signatures invalid on
 *    Ethereum. @noble/curves emits low-s by default; `assertLowS` makes that a
 *    checked invariant rather than an assumption about a dependency.
 *
 * 2. RFC-6979 DETERMINISTIC NONCES. ECDSA leaks the private key outright if the
 *    per-signature nonce k is ever reused or predictable — this is how the PS3
 *    and several wallet key compromises happened. @noble/curves derives k
 *    deterministically from (privateKey, messageHash) per RFC 6979, so k is
 *    never drawn from a PRNG and cannot repeat across different messages.
 */

export interface EcdsaSignature {
  r: bigint;
  s: bigint;
  /** 0 or 1. Lets a verifier recover the public key from the signature. */
  recovery: number;
}

export interface SerializedSignature {
  /** 65-byte r || s || v, 0x-prefixed. The format Ethereum RPC expects. */
  hex: string;
  r: string;
  s: string;
  /** 27 or 28 for message signatures. */
  v: number;
}

export class SignatureMalleabilityError extends Error {
  readonly code = "signature_malleability";
  constructor() {
    super("Refusing to emit a high-s signature: it would be malleable.");
    this.name = "SignatureMalleabilityError";
  }
}

function assertLowS(signature: { s: bigint }): void {
  if (signature.s > secp256k1.CURVE.n / 2n) throw new SignatureMalleabilityError();
}

/**
 * Signs a 32-byte digest that has ALREADY been hashed.
 *
 * Takes a digest rather than a message on purpose. Every Ethereum signing
 * scheme (EIP-191, EIP-712, transactions) has its own domain-separated hashing,
 * and a function that accepted raw bytes would invite a caller to sign an
 * un-prefixed payload — the flaw that lets a malicious dApp get a user to "sign
 * a login message" that is actually a valid transaction.
 */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): EcdsaSignature {
  if (digest.length !== 32) {
    throw new Error("A digest must be exactly 32 bytes.");
  }
  const signature = secp256k1.sign(digest, privateKey, { prehash: false });
  assertLowS(signature);
  return { r: signature.r, s: signature.s, recovery: signature.recovery };
}

function toPaddedHex(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** Serialises to the 65-byte r||s||v form, with v = recovery + 27. */
export function serializeSignature({ r, s, recovery }: EcdsaSignature): SerializedSignature {
  const v = recovery + 27;
  return {
    hex: `0x${toPaddedHex(r)}${toPaddedHex(s)}${v.toString(16).padStart(2, "0")}`,
    r: `0x${toPaddedHex(r)}`,
    s: `0x${toPaddedHex(s)}`,
    v,
  };
}

/** Recovers the signer's uncompressed public key, used to self-verify. */
export function recoverPublicKeyFromDigest(
  digest: Uint8Array,
  signature: EcdsaSignature,
): Uint8Array {
  return new secp256k1.Signature(signature.r, signature.s)
    .addRecoveryBit(signature.recovery)
    .recoverPublicKey(digest)
    .toBytes(false);
}

export function recoverPublicKeyHexFromDigest(
  digest: Uint8Array,
  signature: EcdsaSignature,
): string {
  return encodeHex(recoverPublicKeyFromDigest(digest, signature));
}
