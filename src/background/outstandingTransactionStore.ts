import type { KeyValueStorageArea } from "@/core/vault/vaultStorage";
import type { OutstandingTransaction } from "@/core/transaction/stuckTransaction";

/**
 * Transactions this wallet broadcast that the chain has not yet accepted.
 *
 * ===========================================================================
 * WHY THIS ONE IS PERSISTED WHEN `pendingTransactionLog` IS NOT
 * ===========================================================================
 * They look like the same data and they answer different questions, on
 * different timescales.
 *
 * `pendingTransactionLog` answers "did my send go out?" -- a question that
 * lasts twelve seconds, asked while the popup is still open. Memory is the
 * right home for it, and losing it costs a row that the indexer supplies a
 * moment later.
 *
 * This answers "why has my send not gone through, and what can I do about
 * it?" -- a question that lasts hours and is asked by someone who closed the
 * popup, walked away, and came back. By then the service worker has been
 * collected several times over. A memory-only store would offer Speed up
 * exactly when the transaction is fresh and not stuck, and offer nothing at
 * all by the time it is.
 *
 * And a replacement cannot be reconstructed from the chain. Nodes will not
 * hand back your own pending transaction by nonce, so without the ORIGINAL
 * fees there is no way to bid the required amount over them -- geth wants
 * +10%, and a "speed up" that bids anything less is a button that appears to
 * do nothing. Losing this record does not degrade the feature; it removes it.
 *
 * ===========================================================================
 * WHAT IT COSTS, STATED PLAINLY
 * ===========================================================================
 * These records are PLAINTEXT in chrome.storage.local. They cannot be
 * encrypted under the session key -- reading them is what makes the Speed up
 * button appear, and that must work on a wallet that has locked itself since
 * the send.
 *
 * So this writes a recipient and an amount to disk, which nothing else in this
 * wallet does. The disclosure is bounded three ways: only transactions this
 * wallet BROADCAST are recorded, each record is deleted the moment the chain
 * moves past its nonce, and anything left behind expires. Anyone who can read
 * this file can already read the permission grants (which sites the user
 * uses), the imported token list and the selected address.
 *
 * ===========================================================================
 * RECONCILED AGAINST THE CHAIN, NOT TRUSTED
 * ===========================================================================
 * A stored "pending" record that confirmed hours ago is worse than no record:
 * it would offer to replace a transaction that has already happened. So the
 * account's `latest` nonce is the authority -- anything below it is settled,
 * one way or another, and is deleted on sight. The TTL is a backstop for
 * records whose account is never looked at again, not the primary mechanism.
 */

export const OUTSTANDING_TRANSACTIONS_STORAGE_KEY = "wallet.outstandingTransactions.v1";

/**
 * Backstop expiry. Long, because the whole point is to outlive the popup, the
 * worker and the user's attention span; bounded, because a record for an
 * account that is never opened again would otherwise sit there forever.
 */
export const OUTSTANDING_TRANSACTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounded so a scripted burst of sends cannot grow storage without limit. */
export const MAX_OUTSTANDING_TRANSACTIONS = 50;

/**
 * The stored form. Every `bigint` is a decimal STRING.
 *
 * `JSON.stringify` throws on a bigint rather than losing precision, which is
 * the right failure -- but it means the conversion has to be deliberate, and
 * it has to be exact. `Number` is not an option anywhere near an amount: the
 * whole codebase holds amounts as bigint end to end for this reason.
 */
export interface StoredOutstandingTransaction {
  chainId: number;
  from: string;
  nonce: number;
  transactionHash: string;
  to: string | undefined;
  valueBaseUnits: string;
  data: string | undefined;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  submittedAt: number;
  /** What the user thinks this transaction is, for the row that offers to fix it. */
  description: string;
}

export interface RecordOutstandingTransactionParams {
  chainId: number;
  from: string;
  nonce: number;
  transactionHash: string;
  to: string | undefined;
  value: bigint;
  data: string | undefined;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  description: string;
}

export interface OutstandingTransactionStoreOptions {
  area: KeyValueStorageArea;
  now?: (() => number) | undefined;
}

export class OutstandingTransactionStore {
  private records: StoredOutstandingTransaction[] = [];
  private loaded = false;
  private readonly area: KeyValueStorageArea;
  private readonly now: () => number;

  constructor({ area, now = Date.now }: OutstandingTransactionStoreOptions) {
    this.area = area;
    this.now = now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.area.get(OUTSTANDING_TRANSACTIONS_STORAGE_KEY);
    this.records = Array.isArray(stored) ? stored.filter(isStoredRecord) : [];
    this.loaded = true;
  }

  /**
   * Records a broadcast, replacing any record with the same nonce.
   *
   * Same-nonce replacement is not an optimisation -- it is what a speed-up IS.
   * Keeping both would leave the wallet offering to replace a transaction that
   * has already been replaced, at the fees of the one that lost.
   */
  async record(params: RecordOutstandingTransactionParams): Promise<void> {
    await this.load();
    const owner = params.from.toLowerCase();
    const next: StoredOutstandingTransaction = {
      chainId: params.chainId,
      from: params.from,
      nonce: params.nonce,
      transactionHash: params.transactionHash,
      to: params.to,
      valueBaseUnits: params.value.toString(),
      data: params.data,
      gasLimit: params.gasLimit.toString(),
      maxFeePerGas: params.maxFeePerGas.toString(),
      maxPriorityFeePerGas: params.maxPriorityFeePerGas.toString(),
      submittedAt: this.now(),
      description: params.description,
    };

    this.records = [
      next,
      ...this.records.filter(
        (record) =>
          !(
            record.chainId === params.chainId &&
            record.from.toLowerCase() === owner &&
            record.nonce === params.nonce
          ),
      ),
    ].slice(0, MAX_OUTSTANDING_TRANSACTIONS);

    await this.persist();
  }

  /**
   * Outstanding transactions for one account on one chain, oldest first.
   *
   * `latestNonce` is the account's confirmed nonce from the chain. Everything
   * below it has settled -- mined, or replaced by something that was -- and is
   * deleted here rather than filtered, so the store shrinks as transactions
   * land instead of accumulating a history nobody asked it to keep.
   */
  async reconcile({
    chainId,
    address,
    latestNonce,
  }: {
    chainId: number;
    address: string;
    latestNonce: number;
  }): Promise<OutstandingTransaction[]> {
    await this.load();
    const owner = address.toLowerCase();
    const cutoff = this.now() - OUTSTANDING_TRANSACTION_TTL_MS;

    const before = this.records.length;
    this.records = this.records.filter((record) => {
      if (record.submittedAt < cutoff) return false;
      const isThisAccount = record.chainId === chainId && record.from.toLowerCase() === owner;
      if (!isThisAccount) return true;
      return record.nonce >= latestNonce;
    });
    if (this.records.length !== before) await this.persist();

    return this.records
      .filter((record) => record.chainId === chainId && record.from.toLowerCase() === owner)
      .map(toOutstandingTransaction)
      .sort((left, right) => left.nonce - right.nonce);
  }

  /** One record, by the nonce it occupies. */
  async find({
    chainId,
    address,
    nonce,
  }: {
    chainId: number;
    address: string;
    nonce: number;
  }): Promise<OutstandingTransaction | undefined> {
    await this.load();
    const owner = address.toLowerCase();
    const found = this.records.find(
      (record) =>
        record.chainId === chainId && record.from.toLowerCase() === owner && record.nonce === nonce,
    );
    return found ? toOutstandingTransaction(found) : undefined;
  }

  /** Called on wallet reset, alongside every other stored trace of the wallet. */
  async clear(): Promise<void> {
    this.records = [];
    this.loaded = true;
    await this.area.remove(OUTSTANDING_TRANSACTIONS_STORAGE_KEY);
  }

  private async persist(): Promise<void> {
    await this.area.set(OUTSTANDING_TRANSACTIONS_STORAGE_KEY, this.records);
  }
}

function toOutstandingTransaction(record: StoredOutstandingTransaction): OutstandingTransaction {
  return {
    chainId: record.chainId,
    from: record.from,
    nonce: record.nonce,
    transactionHash: record.transactionHash,
    to: record.to,
    value: BigInt(record.valueBaseUnits),
    data: record.data,
    gasLimit: BigInt(record.gasLimit),
    maxFeePerGas: BigInt(record.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(record.maxPriorityFeePerGas),
    submittedAt: record.submittedAt,
    description: record.description,
  };
}

/**
 * Shape check on a stored record.
 *
 * Storage is not a trusted input, and a malformed record here is not cosmetic:
 * these numbers become the fees and the nonce of a transaction the wallet
 * signs. Anything that does not parse exactly is dropped rather than repaired.
 */
function isStoredRecord(value: unknown): value is StoredOutstandingTransaction {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredOutstandingTransaction>;
  return (
    typeof record.chainId === "number" &&
    typeof record.from === "string" &&
    typeof record.nonce === "number" &&
    Number.isSafeInteger(record.nonce) &&
    record.nonce >= 0 &&
    typeof record.transactionHash === "string" &&
    (record.to === undefined || typeof record.to === "string") &&
    (record.data === undefined || typeof record.data === "string") &&
    isDecimalString(record.valueBaseUnits) &&
    isDecimalString(record.gasLimit) &&
    isDecimalString(record.maxFeePerGas) &&
    isDecimalString(record.maxPriorityFeePerGas) &&
    typeof record.submittedAt === "number" &&
    typeof record.description === "string"
  );
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}
