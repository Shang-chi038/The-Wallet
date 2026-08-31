import type { TypedDataDefinition } from "viem";
import { isValidAddress, toChecksumAddress } from "../account/ethereumAddress";
import { parseHexChainId } from "../network/chain";
import { ProviderError, PROVIDER_ERROR_CODES } from "./protocol";

/**
 * Parsers for the params a web page sends.
 *
 * ===========================================================================
 * EVERY VALUE HERE IS ATTACKER-CONTROLLED
 * ===========================================================================
 * These are the exact bytes a hostile site chose. There is no schema
 * validation upstream and there must not be a "well it's probably fine" path
 * downstream, so parsing is total: each function either returns a fully
 * validated value or throws a ProviderError with the JSON-RPC code the dApp
 * expects (-32602 invalid params).
 *
 * Kept pure and separate from the router so the nasty cases -- wrong argument
 * order, hex where a number was typed, a chainId that is a string, a `to` that
 * is an empty string rather than absent -- are unit-testable without a browser.
 */

function invalidParams(message: string): ProviderError {
  return new ProviderError(PROVIDER_ERROR_CODES.invalidParams, message);
}

function asArray(params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) {
    throw invalidParams("Params must be an array.");
  }
  return params;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParams(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function looksLikeAddress(value: unknown): value is string {
  return typeof value === "string" && isValidAddress(value);
}

/**
 * Parses a JSON-RPC QUANTITY.
 *
 * Returns bigint, never number: a `value` field can hold up to 2^256-1, and
 * `Number("0x...")` silently loses precision above 2^53. Losing precision on a
 * transfer amount means signing for a different amount than the user approved.
 *
 * Accepts leading zeros. The spec forbids them, but real dApps and real
 * libraries emit them, and rejecting a well-formed transfer over a formatting
 * nicety just breaks the wallet for the user.
 */
export function parseQuantity(value: unknown, label: string): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidParams(`${label} is not a valid quantity.`);
    }
    return BigInt(value);
  }
  if (typeof value === "bigint") return value;
  if (typeof value !== "string") throw invalidParams(`${label} must be a hex quantity string.`);
  if (value === "" || value === "0x") return 0n;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    // Some libraries send decimal strings. Accept them rather than fail, but
    // only when they are unambiguously decimal -- never guess a bare "10" as
    // hex, which would be a 6x difference in the amount signed.
    if (/^[0-9]+$/.test(value)) return BigInt(value);
    throw invalidParams(`${label} is not a valid hex quantity.`);
  }
  return BigInt(value);
}

export function parseAddress(value: unknown, label: string): string {
  if (!looksLikeAddress(value)) {
    throw invalidParams(`${label} is not a valid Ethereum address.`);
  }
  return toChecksumAddress(value);
}

function parseOptionalData(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "" || value === "0x") return undefined;
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw invalidParams("Transaction data must be an even-length hex string.");
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// personal_sign
// ---------------------------------------------------------------------------

export interface PersonalSignParams {
  address: string;
  /** Raw payload exactly as sent: UTF-8 text or 0x-prefixed hex. */
  payload: string;
}

/**
 * personal_sign takes [message, address] -- but a large fraction of dApps send
 * [address, message], because that is the argument order of the older, now
 * discouraged `eth_sign`, and MetaMask has always accepted both.
 *
 * We accept both too, and disambiguate STRUCTURALLY rather than positionally:
 * whichever argument is a syntactically valid address is the address. Guessing
 * by position would mean signing the user's own address as a message on every
 * dApp that uses the legacy order -- and, worse, treating a message that
 * happens to look like an address as the signer.
 */
export function parsePersonalSignParams(params: unknown): PersonalSignParams {
  const values = asArray(params);
  if (values.length < 2) throw invalidParams("personal_sign requires a message and an address.");

  const [first, second] = values;
  if (looksLikeAddress(second) && typeof first === "string") {
    return { address: toChecksumAddress(second), payload: first };
  }
  if (looksLikeAddress(first) && typeof second === "string") {
    return { address: toChecksumAddress(first), payload: second };
  }
  throw invalidParams("personal_sign needs one address argument and one message argument.");
}

// ---------------------------------------------------------------------------
// eth_signTypedData_v4
// ---------------------------------------------------------------------------

export interface TypedDataParams {
  address: string;
  definition: TypedDataDefinition;
  /** Chain the payload claims. Undefined when the domain omits it. */
  declaredChainId: number | undefined;
}

/**
 * eth_signTypedData_v4 takes [address, typedData], where typedData is usually a
 * JSON STRING and occasionally an object. Both are accepted.
 *
 * The domain's chainId arrives as a hex string over the wire even though viem
 * types it as a number, so it is normalised here rather than at the signing
 * layer -- see the trap note in CLAUDE.md. The value is returned separately so
 * the router can compare it against the active chain BEFORE any key is lent.
 */
export function parseTypedDataParams(params: unknown): TypedDataParams {
  const values = asArray(params);
  if (values.length < 2) throw invalidParams("eth_signTypedData_v4 requires an address and data.");

  const [first, second] = values;
  const address = looksLikeAddress(first)
    ? toChecksumAddress(first)
    : looksLikeAddress(second)
      ? toChecksumAddress(second)
      : undefined;
  if (!address) throw invalidParams("eth_signTypedData_v4 requires a valid signer address.");

  const rawPayload = looksLikeAddress(first) ? second : first;
  let parsed: unknown;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      throw invalidParams("Typed data is not valid JSON.");
    }
  } else {
    parsed = rawPayload;
  }

  const record = asRecord(parsed, "Typed data");
  const { domain, types, primaryType, message } = record;

  if (typeof primaryType !== "string" || primaryType === "") {
    throw invalidParams("Typed data has no primaryType.");
  }
  if (typeof types !== "object" || types === null) {
    throw invalidParams("Typed data has no types.");
  }
  if (message === undefined || message === null) {
    throw invalidParams("Typed data has no message.");
  }

  const domainRecord = domain === undefined ? {} : asRecord(domain, "Typed data domain");
  const declaredChainId = normalizeDomainChainId(domainRecord["chainId"]);

  const normalizedDomain =
    declaredChainId === undefined
      ? domainRecord
      : { ...domainRecord, chainId: declaredChainId };

  return {
    address,
    // The cast is the honest one: we have validated the fields viem requires
    // and it will reject anything structurally wrong when it hashes.
    definition: {
      domain: normalizedDomain,
      types,
      primaryType,
      message,
    } as unknown as TypedDataDefinition,
    declaredChainId,
  };
}

/**
 * The domain chainId is typed as a number by viem but arrives as "0x1" from
 * real dApps. Accepting only one form would either break half of them or, worse,
 * skip the cross-chain replay check when the comparison silently fails on a
 * type mismatch.
 */
function normalizeDomainChainId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return parseHexChainId(value);
    if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// eth_sendTransaction
// ---------------------------------------------------------------------------

export interface SendTransactionParams {
  from: string;
  /** Undefined means contract deployment. */
  to: string | undefined;
  value: bigint;
  data: string | undefined;
  /** dApp-supplied gas limit, honoured when present. */
  gasLimit: bigint | undefined;
  maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined;
  /** Legacy pricing. Converted to 1559 fields by the fee layer. */
  gasPrice: bigint | undefined;
  /** dApp-supplied nonce. Almost always absent; honoured for replacements. */
  nonce: number | undefined;
}

export function parseSendTransactionParams(params: unknown): SendTransactionParams {
  const values = asArray(params);
  const request = asRecord(values[0], "Transaction");

  const from = parseAddress(request["from"], "Transaction `from`");

  // An absent `to` is contract deployment. An EMPTY STRING `to` is a malformed
  // request that some libraries emit for a plain transfer, and treating it as
  // deployment would publish the calldata as contract code. Both collapse to
  // undefined only when genuinely absent; "" is rejected outright.
  const rawTo = request["to"];
  let to: string | undefined;
  if (rawTo === undefined || rawTo === null) {
    to = undefined;
  } else if (rawTo === "") {
    throw invalidParams("Transaction `to` is an empty string. Omit it to deploy a contract.");
  } else {
    to = parseAddress(rawTo, "Transaction `to`");
  }

  const nonceValue = request["nonce"];
  let nonce: number | undefined;
  if (nonceValue !== undefined && nonceValue !== null) {
    const parsedNonce = parseQuantity(nonceValue, "Transaction `nonce`");
    if (parsedNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidParams("Transaction `nonce` is out of range.");
    }
    nonce = Number(parsedNonce);
  }

  const optionalQuantity = (key: string, label: string): bigint | undefined => {
    const raw = request[key];
    return raw === undefined || raw === null ? undefined : parseQuantity(raw, label);
  };

  return {
    from,
    to,
    value: parseQuantity(request["value"], "Transaction `value`"),
    data: parseOptionalData(request["data"] ?? request["input"]),
    gasLimit: optionalQuantity("gas", "Transaction `gas`") ?? optionalQuantity("gasLimit", "Transaction `gasLimit`"),
    maxFeePerGas: optionalQuantity("maxFeePerGas", "Transaction `maxFeePerGas`"),
    maxPriorityFeePerGas: optionalQuantity(
      "maxPriorityFeePerGas",
      "Transaction `maxPriorityFeePerGas`",
    ),
    gasPrice: optionalQuantity("gasPrice", "Transaction `gasPrice`"),
    nonce,
  };
}

// ---------------------------------------------------------------------------
// wallet_switchEthereumChain / wallet_addEthereumChain
// ---------------------------------------------------------------------------

export function parseSwitchChainParams(params: unknown): number {
  const values = asArray(params);
  const request = asRecord(values[0], "Chain switch request");
  const chainId = request["chainId"];
  if (typeof chainId !== "string") {
    throw invalidParams("wallet_switchEthereumChain requires a hex chainId string.");
  }
  return parseHexChainId(chainId);
}

export interface AddChainParams {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number } | undefined;
  blockExplorerUrl: string | undefined;
}

export function parseAddChainParams(params: unknown): AddChainParams {
  const values = asArray(params);
  const request = asRecord(values[0], "Add chain request");

  const chainId = request["chainId"];
  if (typeof chainId !== "string") {
    throw invalidParams("wallet_addEthereumChain requires a hex chainId string.");
  }

  const chainName = request["chainName"];
  if (typeof chainName !== "string" || chainName.trim() === "") {
    throw invalidParams("wallet_addEthereumChain requires a chainName.");
  }

  const rpcUrls = request["rpcUrls"];
  if (!Array.isArray(rpcUrls) || typeof rpcUrls[0] !== "string") {
    throw invalidParams("wallet_addEthereumChain requires at least one rpcUrl.");
  }

  const explorers = request["blockExplorerUrls"];
  const blockExplorerUrl =
    Array.isArray(explorers) && typeof explorers[0] === "string" ? explorers[0] : undefined;

  return {
    chainId: parseHexChainId(chainId),
    chainName: chainName.trim(),
    rpcUrl: rpcUrls[0],
    nativeCurrency: parseNativeCurrency(request["nativeCurrency"]),
    blockExplorerUrl,
  };
}

function parseNativeCurrency(
  value: unknown,
): { name: string; symbol: string; decimals: number } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "nativeCurrency");
  const { name, symbol, decimals } = record;
  if (typeof symbol !== "string" || symbol === "") {
    throw invalidParams("nativeCurrency.symbol is required.");
  }
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw invalidParams("nativeCurrency.decimals must be an integer between 0 and 36.");
  }
  return { name: typeof name === "string" && name !== "" ? name : symbol, symbol, decimals };
}

// ---------------------------------------------------------------------------
// wallet_watchAsset (EIP-747)
// ---------------------------------------------------------------------------

export interface WatchAssetParams {
  address: string;
}

/**
 * EIP-747, and note what does NOT come back: `symbol`, `decimals` and `image`.
 *
 * The spec lets the page supply all three. Honouring `symbol` and `decimals`
 * would let any site register "USDC, 6 decimals" pointing at a contract it
 * wrote, producing a row indistinguishable from the real thing in the list the
 * user picks from when sending. So the page chooses the ADDRESS and nothing
 * else; the wallet reads the rest from the contract, exactly as it does for an
 * address typed by hand. `image` is dropped outright -- a remote URL in the
 * popup is a per-render callback to a server the site controls.
 *
 * Params arrive as a bare object here, unlike every other method on this
 * surface, because that is what EIP-747 specifies. Libraries disagree about it,
 * so a single-element array is accepted too rather than failing on a wrapper
 * the caller cannot control.
 */
export function parseWatchAssetParams(params: unknown): WatchAssetParams {
  const request = asRecord(
    Array.isArray(params) ? params[0] : params,
    "wallet_watchAsset request",
  );

  const type = request["type"];
  if (typeof type !== "string" || type.toUpperCase() !== "ERC20") {
    // Only fungible tokens. An NFT has no `decimals`, does not appear in the
    // holdings list, and would need a different screen entirely.
    throw invalidParams("Only ERC20 assets can be watched.");
  }

  const options = asRecord(request["options"], "wallet_watchAsset options");
  const address = options["address"];
  if (typeof address !== "string" || !isValidAddress(address)) {
    throw invalidParams("wallet_watchAsset requires the token's contract address.");
  }

  return { address: toChecksumAddress(address) };
}
