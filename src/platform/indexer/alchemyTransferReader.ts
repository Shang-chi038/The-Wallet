import type { PublicClient } from "viem";
import { toChecksumAddress } from "@/core/account/ethereumAddress";
import {
  classifyDirection,
  mergeActivity,
  type ActivityAssetKind,
  type ActivityEntry,
  type TransferReader,
} from "@/core/activity/transactionHistory";

/**
 * `alchemy_getAssetTransfers`-backed history.
 *
 * ===========================================================================
 * THE TRAP THAT MAKES THIS FILE WORTH READING CAREFULLY
 * ===========================================================================
 * Every transfer in the response carries TWO amounts:
 *
 *   value        a JSON number, already divided by the token's decimals
 *   rawContract.value  a hex string in base units
 *
 * `value` is a DOUBLE. For anything above 2^53 base units -- which is roughly
 * 0.009 ETH, i.e. almost every transfer worth looking at -- it has already lost
 * precision by the time it reaches us, and JSON.parse cannot get it back. A
 * history built on it displays balances that do not match the chain, and any
 * code that later reused the figure would sign for the wrong amount.
 *
 * So `value` is ignored entirely and `rawContract.value` is parsed as a bigint.
 * This is the same rule as everywhere else in the codebase -- no `Number()`
 * touches an amount -- and it is easiest to break here, because the wrong field
 * is the convenient one.
 *
 * ===========================================================================
 * TWO QUERIES, NOT ONE
 * ===========================================================================
 * The API filters by `fromAddress` OR `toAddress`, never both, so a complete
 * history needs one call in each direction. A transfer between two of the
 * user's own accounts appears in both, which is why `mergeActivity` deduplicates
 * on the transfer id rather than concatenating.
 *
 * ===========================================================================
 * WHAT IS NOT INCLUDED, AND WHY
 * ===========================================================================
 * The `internal` category -- ETH moved by a contract rather than by an
 * externally-owned account -- is deliberately omitted. It is not available on
 * every network and every plan, and a single unsupported category fails the
 * WHOLE request rather than degrading. Losing contract-initiated ETH from the
 * list is a smaller harm than losing the entire history, and the explorer link
 * on each row is where the complete picture lives.
 */

/** Alchemy caps a single page at 1000; we want a screenful. */
export const DEFAULT_TRANSFER_LIMIT = 25;

export const TRANSFER_CATEGORIES = ["external", "erc20", "erc721", "erc1155"] as const;

/** Kept short: the activity tab must render rather than hang on a slow index. */
export const TRANSFER_REQUEST_TIMEOUT_MS = 8_000;

interface AlchemyTransfer {
  uniqueId?: unknown;
  hash?: unknown;
  blockNum?: unknown;
  from?: unknown;
  to?: unknown;
  asset?: unknown;
  category?: unknown;
  tokenId?: unknown;
  rawContract?: { value?: unknown; address?: unknown; decimal?: unknown };
  metadata?: { blockTimestamp?: unknown };
}

/**
 * Only an Alchemy endpoint serves this method.
 *
 * Detected from the URL rather than attempted-and-caught, so a user on their own
 * node gets an honest "history is not available on this endpoint" instead of a
 * failed request reported as an outage. Privacy note worth stating: this is also
 * the point where the user's whole transaction history passes through a third
 * party, which is a reason someone might choose a custom RPC and accept losing
 * the feature.
 */
export function supportsAssetTransfers(rpcUrls: readonly string[]): boolean {
  return rpcUrls.some((url) => url.includes("alchemy.com"));
}

export interface AlchemyTransferReaderOptions {
  client: PublicClient;
  chainId: number;
}

export function createAlchemyTransferReader({
  client,
  chainId,
}: AlchemyTransferReaderOptions): TransferReader {
  async function query(
    direction: "from" | "to",
    address: string,
    limit: number,
  ): Promise<ActivityEntry[]> {
    const parameters = {
      category: [...TRANSFER_CATEGORIES],
      order: "desc",
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: `0x${limit.toString(16)}`,
      ...(direction === "from" ? { fromAddress: address } : { toAddress: address }),
    };

    // viem's request() types only the standard methods, so this cast is the
    // honest way to reach a vendor extension without pretending it is standard.
    const response = (await (client as unknown as {
      request(args: { method: string; params: unknown[] }, options?: unknown): Promise<unknown>;
    }).request({ method: "alchemy_getAssetTransfers", params: [parameters] })) as {
      transfers?: unknown;
    };

    const transfers = Array.isArray(response?.transfers) ? response.transfers : [];
    return transfers
      .map((transfer) => toActivityEntry(transfer as AlchemyTransfer, address, chainId))
      .filter((entry): entry is ActivityEntry => entry !== undefined);
  }

  return {
    async listTransfers({ address, limit }) {
      const requested = Math.max(1, Math.min(limit, 100));
      // allSettled, not all: an index that answers one direction and fails the
      // other should show half a history rather than none. A user checking
      // whether a payment arrived is served by the "received" half alone.
      const [sent, received] = await Promise.allSettled([
        query("from", address, requested),
        query("to", address, requested),
      ]);

      /**
       * A PARTIAL failure degrades; a TOTAL failure must propagate.
       *
       * Returning [] when both queries failed would reach the caller as a
       * perfectly ordinary empty history, and the Activity screen would tell a
       * user with a busy account that they have never transacted. That is the
       * exact ambiguity `ActivityResult.status` exists to remove, and swallowing
       * the error here defeats it.
       */
      if (sent.status === "rejected" && received.status === "rejected") {
        throw sent.reason instanceof Error
          ? sent.reason
          : new Error("The transfer index did not respond.");
      }

      return mergeActivity(
        sent.status === "fulfilled" ? sent.value : [],
        received.status === "fulfilled" ? received.value : [],
      ).slice(0, requested);
    },
  };
}

function toActivityEntry(
  transfer: AlchemyTransfer,
  owner: string,
  chainId: number,
): ActivityEntry | undefined {
  const transactionHash = asHexString(transfer.hash);
  const from = asAddress(transfer.from);
  if (!transactionHash || !from) return undefined;

  const to = asAddress(transfer.to);
  const category = typeof transfer.category === "string" ? transfer.category : "";
  const assetKind = toAssetKind(category);

  const rawValue = transfer.rawContract?.value;
  // NEVER `transfer.value`. See the header: that field is a double and has
  // already lost precision for any meaningful amount.
  const amount = typeof rawValue === "string" ? parseHexOrZero(rawValue) : 0n;

  const decimals = toDecimals(transfer.rawContract?.decimal, assetKind);
  const tokenAddress = asAddress(transfer.rawContract?.address);

  return {
    // `uniqueId` is per-transfer, not per-transaction. Falling back to the hash
    // alone would collapse a multi-asset transaction into one row and hide the
    // rest of what it did.
    id: typeof transfer.uniqueId === "string" ? transfer.uniqueId : `${transactionHash}:${from}`,
    transactionHash,
    blockNumber: typeof transfer.blockNum === "string" ? parseHexOrZero(transfer.blockNum) : 0n,
    timestamp: toTimestamp(transfer.metadata?.blockTimestamp),
    direction: classifyDirection({ from, to, owner }),
    from,
    to,
    counterparty: from.toLowerCase() === owner.toLowerCase() ? to : from,
    assetKind,
    symbol: typeof transfer.asset === "string" && transfer.asset !== "" ? transfer.asset : "?",
    decimals,
    amount,
    tokenAddress,
    chainId,
    // Anything the indexer returns is already in a block.
    status: "confirmed",
  };
}

function toAssetKind(category: string): ActivityAssetKind {
  if (category === "external" || category === "internal") return "native";
  if (category === "erc721" || category === "erc1155") return "nft";
  return "token";
}

/**
 * Token decimals, defaulting to 18 for native and 0 for an NFT.
 *
 * A wrong default here misplaces a decimal point in the user's history, so the
 * indexer's own figure wins whenever it supplied one. `decimal` arrives as hex.
 */
function toDecimals(value: unknown, assetKind: ActivityAssetKind): number {
  if (typeof value === "string") {
    const parsed = Number(parseHexOrZero(value));
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 36) return parsed;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 36) {
    return value;
  }
  return assetKind === "nft" ? 0 : 18;
}

function parseHexOrZero(value: string): bigint {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return 0n;
  if (value === "0x") return 0n;
  return BigInt(value);
}

function asHexString(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value : undefined;
}

function asAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return undefined;
  return toChecksumAddress(value);
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
