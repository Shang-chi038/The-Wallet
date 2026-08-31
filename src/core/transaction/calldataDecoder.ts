import { decodeFunctionData, erc20Abi, parseAbi } from "viem";
import { toChecksumAddress } from "../account/ethereumAddress";
import { formatTokenAmount } from "../token/tokenAmount";
import { isUnlimitedAllowance, type TokenDefinition } from "../token/tokenRegistry";

/**
 * Calldata decoding for clear signing.
 *
 * A wallet that shows "0xa9059cbb000000..." and an Approve button has not
 * obtained informed consent — the user is authorising something neither they
 * nor the wallet can describe. Most drainer losses are a user clicking approve
 * on exactly that screen.
 *
 * So every transaction is classified into one of a small set of intents the UI
 * can state in a sentence, and anything we cannot decode is labelled BLIND
 * SIGNING rather than quietly rendered as an ordinary transfer. Failing to
 * decode is a fact the user needs, not an error to hide.
 */

export const ERC20_APPROVAL_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
]);

export type TransactionIntent =
  | NativeTransferIntent
  | TokenTransferIntent
  | TokenApprovalIntent
  | NftApprovalForAllIntent
  | ContractDeploymentIntent
  | UnknownContractCallIntent;

export interface TransactionIntentBase {
  /** True when the user cannot be told what this does. Must be surfaced loudly. */
  isBlindSigning: boolean;
  /** Elevated-risk actions the approval UI must call out. */
  warnings: TransactionWarning[];
}

export type TransactionWarning =
  | "unlimited_approval"
  /**
   * The token in this transaction is one the USER imported, so its symbol,
   * name and decimals are whatever its own contract reported -- not values
   * this wallet checked against an issuer.
   *
   * Worth saying because the preview is otherwise indistinguishable from one
   * for a token we vouch for. Anyone can deploy a contract that calls itself
   * "USDC", and a site that talked a user into importing one has bought itself
   * a preview that reads exactly like the real thing.
   */
  | "imported_token"
  | "approval_to_unverified_contract"
  | "blind_signing"
  | "contract_deployment"
  | "transfer_to_token_contract";

export interface NativeTransferIntent extends TransactionIntentBase {
  kind: "nativeTransfer";
  recipient: string;
  amount: bigint;
}

export interface TokenTransferIntent extends TransactionIntentBase {
  kind: "tokenTransfer";
  tokenAddress: string;
  token: TokenDefinition | undefined;
  recipient: string;
  amount: bigint;
  /** Present only when the token is known, since decimals are required. */
  formattedAmount: string | undefined;
}

export interface TokenApprovalIntent extends TransactionIntentBase {
  kind: "tokenApproval";
  tokenAddress: string;
  token: TokenDefinition | undefined;
  spender: string;
  amount: bigint;
  isUnlimited: boolean;
  formattedAmount: string | undefined;
}

export interface NftApprovalForAllIntent extends TransactionIntentBase {
  kind: "nftApprovalForAll";
  collectionAddress: string;
  operator: string;
  approved: boolean;
}

export interface ContractDeploymentIntent extends TransactionIntentBase {
  kind: "contractDeployment";
  dataByteLength: number;
}

export interface UnknownContractCallIntent extends TransactionIntentBase {
  kind: "unknownContractCall";
  contractAddress: string;
  /** First 4 bytes; lets the UI link to a selector directory. */
  functionSelector: string;
  dataByteLength: number;
}

export interface DecodeTransactionParams {
  to: string | undefined;
  value: bigint;
  data: string | undefined;
  /** Known tokens on the active chain, for symbol and decimals resolution. */
  knownTokens?: readonly TokenDefinition[];
}

export function decodeTransactionIntent({
  to,
  value,
  data,
  knownTokens = [],
}: DecodeTransactionParams): TransactionIntent {
  const calldata = data && data !== "0x" ? data : undefined;

  // No `to` means contract creation. Always flagged: the user is publishing
  // code, and no preview can summarise what that code will do.
  if (to === undefined) {
    return {
      kind: "contractDeployment",
      dataByteLength: calldata ? (calldata.length - 2) / 2 : 0,
      isBlindSigning: true,
      warnings: ["contract_deployment", "blind_signing"],
    };
  }

  const recipient = toChecksumAddress(to);

  if (!calldata) {
    return { kind: "nativeTransfer", recipient, amount: value, isBlindSigning: false, warnings: [] };
  }

  const findToken = (address: string): TokenDefinition | undefined =>
    knownTokens.find((token) => token.address.toLowerCase() === address.toLowerCase());

  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata as `0x${string}` });

    if (decoded.functionName === "transfer") {
      const [rawRecipient, amount] = decoded.args as readonly [string, bigint];
      const token = findToken(recipient);
      const warnings: TransactionWarning[] = [];
      // Sending a token to its own contract address is almost always a mistake
      // and the funds are usually unrecoverable.
      if (rawRecipient.toLowerCase() === recipient.toLowerCase()) {
        warnings.push("transfer_to_token_contract");
      }
      // LAST, deliberately. The approval window renders warnings in array
      // order, and this one is an advisory about where the metadata came from.
      // Putting it above a danger-tone warning would push the dangerous thing
      // down the screen.
      if (token && !token.isBuiltIn) warnings.push("imported_token");
      return {
        kind: "tokenTransfer",
        tokenAddress: recipient,
        token,
        recipient: toChecksumAddress(rawRecipient),
        amount,
        formattedAmount: token ? formatTokenAmount(amount, token.decimals) : undefined,
        isBlindSigning: token === undefined,
        warnings,
      };
    }

    if (decoded.functionName === "approve") {
      const [spender, amount] = decoded.args as readonly [string, bigint];
      const token = findToken(recipient);
      const isUnlimited = isUnlimitedAllowance(amount);
      const warnings: TransactionWarning[] = [];
      // The single highest-value warning in the whole wallet: an unlimited
      // approval lets the spender move the user's entire balance of this token,
      // forever, with no further interaction.
      if (isUnlimited) warnings.push("unlimited_approval");
      // After it, for the reason given in the transfer branch above.
      if (token && !token.isBuiltIn) warnings.push("imported_token");
      return {
        kind: "tokenApproval",
        tokenAddress: recipient,
        token,
        spender: toChecksumAddress(spender),
        amount,
        isUnlimited,
        formattedAmount: token ? formatTokenAmount(amount, token.decimals) : undefined,
        isBlindSigning: false,
        warnings,
      };
    }
  } catch {
    // Not an ERC-20 call. Fall through to the NFT and unknown paths.
  }

  try {
    const decoded = decodeFunctionData({
      abi: ERC20_APPROVAL_ABI,
      data: calldata as `0x${string}`,
    });
    if (decoded.functionName === "setApprovalForAll") {
      const [operator, approved] = decoded.args as readonly [string, boolean];
      return {
        kind: "nftApprovalForAll",
        collectionAddress: recipient,
        operator: toChecksumAddress(operator),
        approved,
        isBlindSigning: false,
        // Grants control of EVERY token in the collection, including ones
        // acquired later. A favourite of NFT drainers.
        warnings: approved ? ["unlimited_approval"] : [],
      };
    }
  } catch {
    // Not setApprovalForAll either.
  }

  return {
    kind: "unknownContractCall",
    contractAddress: recipient,
    functionSelector: calldata.slice(0, 10),
    dataByteLength: (calldata.length - 2) / 2,
    isBlindSigning: true,
    warnings: ["blind_signing"],
  };
}

/** One-line summary for the approval header. */
export function describeTransactionIntent(intent: TransactionIntent): string {
  switch (intent.kind) {
    case "nativeTransfer":
      return `Send to ${intent.recipient}`;
    case "tokenTransfer":
      return intent.token
        ? `Send ${intent.formattedAmount} ${intent.token.symbol} to ${intent.recipient}`
        : `Send tokens to ${intent.recipient}`;
    case "tokenApproval":
      if (intent.isUnlimited) {
        return `Give unlimited ${intent.token?.symbol ?? "token"} access to ${intent.spender}`;
      }
      return `Allow ${intent.spender} to spend ${intent.formattedAmount ?? intent.amount.toString()} ${
        intent.token?.symbol ?? "tokens"
      }`;
    case "nftApprovalForAll":
      return intent.approved
        ? `Give ${intent.operator} access to your entire collection`
        : `Revoke ${intent.operator}'s collection access`;
    case "contractDeployment":
      return "Deploy a new contract";
    case "unknownContractCall":
      return `Call ${intent.contractAddress}`;
  }
}
