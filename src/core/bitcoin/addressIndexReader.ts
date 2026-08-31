import type { BitcoinNetworkName } from "./bitcoinNetwork";

/**
 * Address indexing and stats contract.
 *
 * This abstraction separates business logic (gap scanning, balance calculation,
 * history classification) from the network indexer (Esplora / Mempool.space).
 */

export interface AddressStats {
  readonly address: string;
  readonly chainFundedSats: bigint;
  readonly chainSpentSats: bigint;
  readonly chainTxCount: number;
  readonly mempoolFundedSats: bigint;
  readonly mempoolSpentSats: bigint;
  readonly mempoolTxCount: number;
}

export function isAddressUsed(stats: AddressStats): boolean {
  return stats.chainTxCount + stats.mempoolTxCount > 0;
}

export function computeConfirmedBalance(stats: AddressStats): bigint {
  return stats.chainFundedSats - stats.chainSpentSats;
}

export function computeUnconfirmedBalance(stats: AddressStats): bigint {
  return stats.mempoolFundedSats - stats.mempoolSpentSats;
}

export function computeTotalBalance(stats: AddressStats): bigint {
  return computeConfirmedBalance(stats) + computeUnconfirmedBalance(stats);
}

export interface BitcoinTxInput {
  readonly txid: string;
  readonly vout: number;
  readonly prevout?:
    | {
        readonly scriptpubkey_address?: string | undefined;
        readonly value: bigint;
      }
    | undefined;
  readonly sequence: number;
}

export interface BitcoinTxOutput {
  readonly scriptpubkey_address?: string | undefined;
  readonly value: bigint;
}

export interface BitcoinTxStatus {
  readonly confirmed: boolean;
  readonly block_height?: number | undefined;
  readonly block_hash?: string | undefined;
  readonly block_time?: number | undefined;
}

export interface BitcoinTransaction {
  readonly txid: string;
  readonly version: number;
  readonly locktime: number;
  readonly vin: readonly BitcoinTxInput[];
  readonly vout: readonly BitcoinTxOutput[];
  readonly size: number;
  readonly weight: number;
  readonly fee: bigint;
  readonly status: BitcoinTxStatus;
}

export interface ReadAddressStatsParams {
  readonly addresses: readonly string[];
  readonly network: BitcoinNetworkName;
}

export interface ListAddressTransactionsParams {
  readonly address: string;
  readonly network: BitcoinNetworkName;
}

export interface AddressIndexReader {
  readAddressStats(params: ReadAddressStatsParams): Promise<Map<string, AddressStats>>;
  listAddressTransactions(
    params: ListAddressTransactionsParams,
  ): Promise<BitcoinTransaction[]>;
}

/**
 * The indexer could not be reached, or answered with something unusable.
 *
 * ===========================================================================
 * WHY THIS IS A CODED ERROR AND NOT A BARE `Error`
 * ===========================================================================
 * A gap scan is 40 lookups against a public host nobody here operates, so
 * "the indexer is not answering" is a NORMAL outcome, not a bug. It used to be
 * thrown as a plain `Error`, and a plain `Error` is treated by
 * `messageRouter.toErrorPayload` as an unexpected throw: the message is
 * withheld from BOTH audiences (correct, because raw exception text can quote
 * a mnemonic), and `reportUnexpectedError` logs only the error CLASS. The
 * popup was therefore left with "The wallet could not complete this request."
 * and the service-worker console with "threw an unhandled Error", for a
 * failure whose entire content is a hostname and an HTTP status.
 *
 * Carrying a `code` puts this on the domain-error path instead, where the
 * message reaches privileged senders -- our own pages -- and `data.reason` lets
 * the popup branch without matching on prose.
 *
 * ===========================================================================
 * THE MESSAGE NAMES THE NETWORK. THE DETAIL STAYS BEHIND.
 * ===========================================================================
 * `message` is what the popup renders, so it says the one thing the person
 * reading it can act on: which network is unreachable. Naming the host, the
 * status code and the timeout instead produced a true sentence and the wrong
 * one for a balance card -- it cited a host the user never chose, in units
 * they have no use for, and ran longer than the card it sat in.
 *
 * `detail` keeps that text for whoever is debugging, on the error object rather
 * than on screen. Both strings are assembled from a host and a status line
 * ONLY; neither interpolates a caught exception's text, because the rule that
 * keeps seed phrases out of error strings does not have exceptions for the
 * cases where it looks safe.
 */
export class IndexerUnavailableError extends Error {
  readonly code = "indexer_unavailable";
  /** Host only -- never the full URL, which carries the queried address. */
  readonly host: string;
  /** Host and cause, for a developer. Not forwarded, not rendered. */
  readonly detail: string;

  constructor({
    network,
    host,
    reason,
  }: {
    network: BitcoinNetworkName;
    host: string;
    reason: string;
  }) {
    super(`Can't contact ${network}`);
    this.name = "IndexerUnavailableError";
    this.host = host;
    this.detail = `${host}: ${reason}`;
  }
}
