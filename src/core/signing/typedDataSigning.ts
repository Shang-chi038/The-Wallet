import { hashTypedData, type TypedDataDefinition } from "viem";
import { decodeHex } from "../crypto/encoding";
import { serializeSignature, signDigest, type SerializedSignature } from "./signature";
import { parseHexChainId } from "../network/chain";

/**
 * EIP-712 typed structured data signing.
 *
 * EIP-712 exists so users can see WHAT they are signing instead of a hash. Two
 * properties matter and are enforced here:
 *
 * 1. DOMAIN SEPARATION. The domain binds a signature to one contract on one
 *    chain. Without it, a signature harvested from a test dApp on Sepolia
 *    replays against the real contract on mainnet. `assertDomainMatchesChain`
 *    is what stops a dApp from asking for a mainnet-domain signature while the
 *    user believes they are on a testnet.
 *
 * 2. THE HASH IS NOT HAND-ROLLED. encodeType/hashStruct recursion, array
 *    encoding, and the exact treatment of `bytes` vs `string` are subtle, and a
 *    bug produces signatures that verify nowhere. We delegate to viem's audited
 *    implementation rather than writing our own.
 */

export class TypedDataDomainMismatchError extends Error {
  readonly code = "typed_data_domain_mismatch";
  constructor(
    readonly domainChainId: number,
    readonly activeChainId: number,
  ) {
    super(
      `This request asks you to sign data for chain ${domainChainId}, but your wallet is on ` +
        `chain ${activeChainId}. Signing could authorise an action on a different network.`,
    );
    this.name = "TypedDataDomainMismatchError";
  }
}

/**
 * Rejects a typed-data request whose domain names a chain other than the one
 * the user is actually on.
 *
 * A domain with no chainId is permitted (the spec makes every domain field
 * optional) but the approval UI must say so, because such a signature is not
 * bound to any network.
 */
export function assertDomainMatchesChain(
  definition: TypedDataDefinition,
  activeChainId: number,
): void {
  const domainChainId = (definition.domain as { chainId?: number | string } | undefined)?.chainId;
  if (domainChainId === undefined) return;
  const normalized =
    typeof domainChainId === "string" ? parseHexChainId(domainChainId) : domainChainId;
  if (normalized !== activeChainId) {
    throw new TypedDataDomainMismatchError(normalized, activeChainId);
  }
}

export function hashTypedDataPayload(definition: TypedDataDefinition): Uint8Array {
  return decodeHex(hashTypedData(definition));
}

export function signTypedData(
  definition: TypedDataDefinition,
  privateKey: Uint8Array,
): SerializedSignature {
  return serializeSignature(signDigest(hashTypedDataPayload(definition), privateKey));
}

export interface TypedDataPreviewField {
  path: string;
  value: string;
}

/**
 * Flattens typed data into label/value rows for the approval screen.
 *
 * The whole point of EIP-712 is human-readable signing, which is defeated if
 * the UI renders a JSON blob. Nested structures are flattened to dotted paths
 * so every leaf the user is authorising is individually visible.
 */
export function createTypedDataPreview(definition: TypedDataDefinition): TypedDataPreviewField[] {
  const fields: TypedDataPreviewField[] = [];

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) {
      fields.push({ path, value: String(value) });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    fields.push({ path, value: typeof value === "bigint" ? value.toString() : String(value) });
  };

  walk(definition.message, "");
  return fields;
}

// ---------------------------------------------------------------------------
// What signing this actually authorises
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS, AND WHY THE FIELD DUMP ABOVE IS NOT ENOUGH.
 *
 * `createTypedDataPreview` lists every leaf, which is the right thing to do and
 * is not the same as explaining. An unlimited EIP-2612 permit renders as five
 * true rows -- owner, spender, value, nonce, deadline -- one of which is a
 * 78-digit integer, and nothing on the screen says that approving it lets a
 * stranger move that token out of the account forever.
 *
 * That is not a hypothetical shape. A signed permit is THE dominant drainer
 * technique: no transaction, no gas, nothing in Activity, and no later step
 * where the wallet could catch it. The attacker calls `permit()` and
 * `transferFrom()` from their own wallet, afterwards. `eth_sendTransaction`
 * has had `unlimited_approval` since the calldata decoder was written; the one
 * surface where the same grant needs no transaction at all had no warnings
 * array to put it in.
 *
 * THE HOUSE RULE APPLIES UNCHANGED: never guess. A shape is either recognised
 * structurally -- the field names of a known standard -- or it is reported as
 * blind signing. There is no "probably a permit" branch.
 */
export type TypedDataWarning =
  /** A recognised standard whose whole purpose is to let someone else move tokens. */
  | "spending_permission"
  /** That permission is for an effectively unbounded amount. */
  | "unlimited_permission"
  /** It does not expire for a long time, or carries no expiry at all. */
  | "long_lived_permission"
  /** The wallet does not recognise this structure and cannot say what it does. */
  | "blind_signing";

/** A year. Past this, "expires" is not a meaningful protection for the user. */
const LONG_LIVED_SECONDS = 365 * 24 * 60 * 60;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * A uint256 as it actually arrives: bigint, number, decimal string or hex
 * string. Anything else is not a quantity and must not be guessed at as one.
 */
function readQuantity(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== "string") return undefined;
  try {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
    if (/^[0-9]+$/.test(value)) return BigInt(value);
  } catch {
    return undefined;
  }
  return undefined;
}

interface SpendingPermission {
  /** The largest amount any leg of this permission covers. */
  amount: bigint | undefined;
  /** Unix seconds, or undefined when the structure carries no expiry. */
  expiresAt: bigint | undefined;
}

/**
 * Recognises the standard token-spending permissions, by field shape.
 *
 * Matched on the fields rather than on `primaryType` alone, because the type
 * name is chosen by the site: a struct called "Permit" that is nothing of the
 * sort must not inherit the warning, and one called "Permit" that IS one must
 * not escape it by renaming. `primaryType` narrows; the fields decide.
 */
function readSpendingPermission(
  primaryType: string,
  message: Record<string, unknown>,
): SpendingPermission | undefined {
  // EIP-2612: owner, spender, value, nonce, deadline.
  if (
    primaryType === "Permit" &&
    typeof message["spender"] === "string" &&
    message["value"] !== undefined
  ) {
    return {
      amount: readQuantity(message["value"]),
      expiresAt: readQuantity(message["deadline"]),
    };
  }

  // DAI-style: holder, spender, nonce, expiry, allowed (a boolean, where true
  // means unlimited -- there is no amount field to read).
  if (
    primaryType === "Permit" &&
    typeof message["spender"] === "string" &&
    typeof message["allowed"] === "boolean"
  ) {
    return {
      amount: message["allowed"] === true ? (1n << 255n) : 0n,
      expiresAt: readQuantity(message["expiry"]),
    };
  }

  // Permit2 single / batch: { details, spender, sigDeadline }, where details is
  // one record or an array of them, each { token, amount, expiration, nonce }.
  if (
    (primaryType === "PermitSingle" || primaryType === "PermitBatch") &&
    typeof message["spender"] === "string"
  ) {
    const rawDetails = message["details"];
    const legs = (Array.isArray(rawDetails) ? rawDetails : [rawDetails])
      .map(readRecord)
      .filter((leg): leg is Record<string, unknown> => leg !== undefined);

    let amount: bigint | undefined;
    let expiresAt: bigint | undefined;
    for (const leg of legs) {
      const legAmount = readQuantity(leg["amount"]);
      if (legAmount !== undefined && (amount === undefined || legAmount > amount)) {
        amount = legAmount;
      }
      // The soonest expiry across the batch is the honest one to report; a
      // batch is only as short-lived as its longest-lived leg, so take the max.
      const legExpiry = readQuantity(leg["expiration"]);
      if (legExpiry !== undefined && (expiresAt === undefined || legExpiry > expiresAt)) {
        expiresAt = legExpiry;
      }
    }
    return { amount, expiresAt: expiresAt ?? readQuantity(message["sigDeadline"]) };
  }

  // Permit2 signature transfer: { permitted: { token, amount }, spender, deadline }.
  if (
    (primaryType === "PermitTransferFrom" || primaryType === "PermitBatchTransferFrom") &&
    message["permitted"] !== undefined
  ) {
    const rawPermitted = message["permitted"];
    const legs = (Array.isArray(rawPermitted) ? rawPermitted : [rawPermitted])
      .map(readRecord)
      .filter((leg): leg is Record<string, unknown> => leg !== undefined);
    let amount: bigint | undefined;
    for (const leg of legs) {
      const legAmount = readQuantity(leg["amount"]);
      if (legAmount !== undefined && (amount === undefined || legAmount > amount)) {
        amount = legAmount;
      }
    }
    return { amount, expiresAt: readQuantity(message["deadline"]) };
  }

  // Seaport orders. There is no single "amount" -- the order lists the items it
  // gives away -- so the amount is left undefined and the permission warning
  // carries the weight on its own.
  if (
    (primaryType === "OrderComponents" || primaryType === "BulkOrder") &&
    message["offer"] !== undefined &&
    message["consideration"] !== undefined
  ) {
    return { amount: undefined, expiresAt: readQuantity(message["endTime"]) };
  }

  return undefined;
}

export interface AssessTypedDataWarningsParams {
  definition: TypedDataDefinition;
  /** Milliseconds, so this can be driven by the router's injected clock. */
  now: number;
}

/**
 * What the approval screen must say about this payload, beyond listing it.
 *
 * Returns codes, never sentences. The copy lives in the approval window
 * alongside the transaction warnings, which keeps the wording in one place and
 * keeps this module out of the popup bundle.
 */
export function assessTypedDataWarnings({
  definition,
  now,
}: AssessTypedDataWarningsParams): TypedDataWarning[] {
  const message = readRecord(definition.message);
  const primaryType = definition.primaryType;
  if (!message || typeof primaryType !== "string") return ["blind_signing"];

  const permission = readSpendingPermission(primaryType, message);
  if (!permission) {
    /**
     * Not a shape this wallet knows. Said plainly rather than left to the field
     * list to imply, for the same reason undecodable calldata is labelled
     * blind signing: a screen that looks informative but is not is worse than
     * one that admits it, because the user reads the rows and concludes they
     * have understood.
     */
    return ["blind_signing"];
  }

  const warnings: TypedDataWarning[] = ["spending_permission"];

  // Deliberately the same threshold as an on-chain `approve`: a drainer asking
  // for "merely enormous" rather than exactly 2^256-1 is the same grant.
  if (permission.amount !== undefined && permission.amount >= 1n << 255n) {
    warnings.push("unlimited_permission");
  }

  const nowSeconds = BigInt(Math.floor(now / 1000));
  const expiresAt = permission.expiresAt;
  if (expiresAt === undefined || expiresAt > nowSeconds + BigInt(LONG_LIVED_SECONDS)) {
    // An expiry already in the past is NOT flagged -- that permission is dead
    // on arrival and warning about it would be noise.
    warnings.push("long_lived_permission");
  }

  return warnings;
}
