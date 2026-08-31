import type { BitcoinTransaction } from "./addressIndexReader";
import { formatBitcoinAmountForDisplay } from "./bitcoinAmount";

/**
 * Bitcoin transaction history classification and deduplication.
 *
 * Ground rules:
 * - Deduplication is keyed by txid: one multi-input/output transaction is ONE row.
 * - Direction is classified from the owner's perspective:
 *     * sent: coins left the wallet (net amount = external outputs paid)
 *     * received: coins entered the wallet (net amount = wallet outputs received)
 *     * self: rebalance between wallet addresses (net amount = miner fee)
 * - All amount math uses exact bigint satoshis.
 */

export type BitcoinActivityDirection = "sent" | "received" | "self";

export interface BitcoinActivityEntry {
  readonly id: string;
  readonly transactionHash: string;
  readonly blockNumber: number | undefined;
  readonly timestamp: number | undefined;
  readonly direction: BitcoinActivityDirection;
  readonly amountSats: bigint;
  readonly amountLabel: string;
  readonly feeSats: bigint;
  readonly status: "pending" | "confirmed";
  readonly counterparty: string | undefined;
  readonly explorerUrl: string;
}

export interface ClassifyBitcoinTransactionParams {
  readonly transaction: BitcoinTransaction;
  readonly ownedAddresses: ReadonlySet<string>;
  readonly explorerBaseUrl: string;
}

export function classifyBitcoinTransaction({
  transaction,
  ownedAddresses,
  explorerBaseUrl,
}: ClassifyBitcoinTransactionParams): BitcoinActivityEntry {
  let userInputSum = 0n;
  let userOutputSum = 0n;
  let externalInputAddress: string | undefined;
  let externalOutputAddress: string | undefined;

  for (const vin of transaction.vin) {
    const addr = vin.prevout?.scriptpubkey_address;
    const value = vin.prevout?.value ?? 0n;
    if (addr && ownedAddresses.has(addr)) {
      userInputSum += value;
    } else if (addr && !externalInputAddress) {
      externalInputAddress = addr;
    }
  }

  for (const vout of transaction.vout) {
    const addr = vout.scriptpubkey_address;
    const value = vout.value ?? 0n;
    if (addr && ownedAddresses.has(addr)) {
      userOutputSum += value;
    } else if (addr && !externalOutputAddress) {
      externalOutputAddress = addr;
    }
  }

  const hasUserInput = userInputSum > 0n;
  const hasUserOutput = userOutputSum > 0n;

  let direction: BitcoinActivityDirection;
  let amountSats: bigint;
  let counterparty: string | undefined;

  if (hasUserInput && hasUserOutput) {
    if (userInputSum >= userOutputSum) {
      const netSpent = userInputSum - userOutputSum;
      if (netSpent === transaction.fee || !externalOutputAddress) {
        // Self-transfer (all outputs went back to wallet, or only fee was lost)
        direction = "self";
        amountSats = transaction.fee;
        counterparty = undefined;
      } else {
        // Send with change returned to wallet
        direction = "sent";
        amountSats = netSpent - transaction.fee;
        counterparty = externalOutputAddress;
      }
    } else {
      // Net positive with both (rare edge case)
      direction = "received";
      amountSats = userOutputSum - userInputSum;
      counterparty = externalInputAddress;
    }
  } else if (hasUserInput) {
    // Send without change
    direction = "sent";
    amountSats = userInputSum - transaction.fee;
    counterparty = externalOutputAddress;
  } else if (hasUserOutput) {
    // Receive
    direction = "received";
    amountSats = userOutputSum;
    counterparty = externalInputAddress;
  } else {
    // Should not happen for queries scoped to owned addresses
    direction = "self";
    amountSats = 0n;
  }

  // Ensure amount is non-negative
  if (amountSats < 0n) {
    amountSats = 0n;
  }

  const timestampMs = transaction.status.block_time
    ? transaction.status.block_time * 1000
    : undefined;

  const explorerUrl = `${explorerBaseUrl.replace(/\/+$/, "")}/tx/${transaction.txid}`;

  return {
    id: transaction.txid,
    transactionHash: transaction.txid,
    blockNumber: transaction.status.block_height,
    timestamp: timestampMs,
    direction,
    amountSats,
    amountLabel: formatBitcoinAmountForDisplay(amountSats),
    feeSats: transaction.fee,
    status: transaction.status.confirmed ? "confirmed" : "pending",
    counterparty,
    explorerUrl,
  };
}

export interface MergeAndClassifyBitcoinActivityParams {
  readonly transactions: readonly BitcoinTransaction[];
  readonly ownedAddresses: ReadonlySet<string>;
  readonly explorerBaseUrl: string;
}

export function mergeAndClassifyBitcoinActivity({
  transactions,
  ownedAddresses,
  explorerBaseUrl,
}: MergeAndClassifyBitcoinActivityParams): BitcoinActivityEntry[] {
  const uniqueTxs = new Map<string, BitcoinTransaction>();
  for (const tx of transactions) {
    if (!uniqueTxs.has(tx.txid)) {
      uniqueTxs.set(tx.txid, tx);
    }
  }

  const entries: BitcoinActivityEntry[] = [];
  for (const tx of uniqueTxs.values()) {
    entries.push(
      classifyBitcoinTransaction({
        transaction: tx,
        ownedAddresses,
        explorerBaseUrl,
      }),
    );
  }

  // Sort: pending first, then by timestamp / block number descending
  return entries.sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;

    const timeA = a.timestamp ?? Number.MAX_SAFE_INTEGER;
    const timeB = b.timestamp ?? Number.MAX_SAFE_INTEGER;
    if (timeA !== timeB) {
      return timeB - timeA;
    }

    const blockA = a.blockNumber ?? Number.MAX_SAFE_INTEGER;
    const blockB = b.blockNumber ?? Number.MAX_SAFE_INTEGER;
    return blockB - blockA;
  });
}
