import {
  findBitcoinNetwork,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";
import {
  IndexerUnavailableError,
  type AddressIndexReader,
  type AddressStats,
  type BitcoinTransaction,
  type ListAddressTransactionsParams,
  type ReadAddressStatsParams,
} from "@/core/bitcoin/addressIndexReader";

export interface EsploraAddressReaderOptions {
  /** Optional custom indexer URL overrides per network. */
  readonly customIndexerUrls?: Partial<Record<BitcoinNetworkName, string>>;
  readonly fetchImplementation?: typeof fetch;
  readonly concurrencyLimit?: number;
  /** Per-request deadline. See DEFAULT_REQUEST_TIMEOUT_MS. */
  readonly requestTimeoutMs?: number;
  /** Total tries per lookup, first attempt included. See DEFAULT_RETRY_ATTEMPTS. */
  readonly retryAttempts?: number;
  /** First backoff step; doubles per retry, capped at MAX_RETRY_DELAY_MS. */
  readonly retryBaseDelayMs?: number;
  /** Injectable for tests, which must not spend real time sleeping. */
  readonly waitImplementation?: (milliseconds: number) => Promise<void>;
}

/**
 * Every request gets a deadline, because a gap scan is 40 of them.
 *
 * `fetch` with no signal waits on the network stack's own timeout, which is
 * minutes. One unanswered address lookup would therefore stall the batch it is
 * in, and with it the whole scan, and the popup would sit on a Bitcoin balance
 * that never arrives or fails -- a state the UI cannot distinguish from "still
 * loading" and so cannot report. A public indexer under load is the normal
 * case, not the exceptional one: it is better to fail the scan (the UI keeps
 * the last good figure) than to hang holding a promise nothing will settle.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * ===========================================================================
 * WHY A GAP SCAN RETRIES AND A SINGLE RPC CALL DOES NOT
 * ===========================================================================
 * `scanBitcoinAccountAddresses` fails the WHOLE scan if any one address lookup
 * fails, deliberately: a partial answer is a balance that is wrong by exactly
 * the addresses that did not answer, and a wallet must not render that. The
 * cost of that rule is that the scan is only as reliable as its least reliable
 * request -- and it makes 40 of them, in bursts of five, against a public host.
 *
 * That is the shape of the mainnet failure this exists for. `mempool.space` is
 * the built-in mainnet indexer and it throttles by IP (429) and slows under
 * load; a testnet host serving a tiny chain does neither, so the same code
 * looks perfectly reliable on signet and fails the moment someone switches to
 * their real money. Without retries the arithmetic is unforgiving: 40 requests
 * at a 99% success rate is a two-in-three chance that the scan fails.
 *
 * So a lookup that failed for a reason that says "later" -- a timeout, a
 * throttle, a 5xx, a proxy page where JSON was expected -- is tried again with
 * exponential backoff. A reason that says "never" (404, 400) is not retried:
 * asking a second time cannot change a malformed URL, and the delay would only
 * postpone the message.
 */
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 400;

/**
 * `Retry-After` is a request, not an instruction we are obliged to honour in
 * full. A throttled public indexer commonly answers "60", and a wallet that
 * slept a minute per lookup inside a 40-lookup scan would be indistinguishable
 * from one that had hung -- and under MV3 the worker would very likely be
 * collected mid-scan anyway. We cap the wait and let the attempt budget run
 * out instead, which reports a throttle rather than pretending to wait it out.
 */
export const MAX_RETRY_DELAY_MS = 2_000;

interface RawEsploraStats {
  funded_txo_sum?: number | string;
  spent_txo_sum?: number | string;
  tx_count?: number;
}

interface RawEsploraAddressResponse {
  address: string;
  chain_stats?: RawEsploraStats;
  mempool_stats?: RawEsploraStats;
}

interface RawEsploraTxVin {
  txid: string;
  vout: number;
  prevout?: {
    scriptpubkey_address?: string;
    value?: number | string;
  };
  sequence: number;
}

interface RawEsploraTxVout {
  scriptpubkey_address?: string;
  value?: number | string;
}

interface RawEsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin?: RawEsploraTxVin[];
  vout?: RawEsploraTxVout[];
  size?: number;
  weight?: number;
  fee?: number | string;
  status?: {
    confirmed?: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

function parseBigIntAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Statuses worth asking again about.
 *
 * 429 is the throttle this is chiefly for; 5xx is the indexer's own trouble;
 * 408 and 425 are the two "you were early / too slow" codes a proxy in front of
 * one emits. Everything else -- notably 400 and 404 -- describes the REQUEST,
 * and repeating an identical request cannot change the answer.
 */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Host only. The path carries the queried address, and errors get displayed. */
function describeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function readRetryAfterMs(response: Response): number | undefined {
  const header = response.headers?.get?.("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  // Only the delta-seconds form. The HTTP-date form is legal and rare, and a
  // misparsed date is a wait of arbitrary length; falling back to our own
  // backoff is the safer failure.
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

/**
 * A cause, in words we chose.
 *
 * Never `error.message`: raw exception text is not forwarded anywhere in this
 * codebase, and this string is destined for the popup.
 */
function describeThrownFailure(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return `no answer within ${timeoutMs}ms`;
  if (name === "AbortError") return "the request was aborted";
  return "the request could not be sent";
}

/**
 * Builds the error, and puts its detail where a developer can find it.
 *
 * The popup now shows "Can't contact mainnet", which is the right thing to
 * render and no help at all when the question is WHY. The detail is logged
 * under DEV only, matching `reportUnexpectedError`: a shipped wallet that
 * narrates every throttled lookup to the console is noise, and the same string
 * is on the thrown error for anyone with a breakpoint.
 */
function reportUnavailable(params: {
  network: BitcoinNetworkName;
  host: string;
  reason: string;
}): IndexerUnavailableError {
  const error = new IndexerUnavailableError(params);
  // Not under vitest: the suite asserts on the thrown error, and a scan that
  // narrates 40 failed lookups to stderr teaches people to skim test output.
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    console.warn(`[wallet] Bitcoin indexer unavailable -- ${error.detail}`);
  }
  return error;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * AddressIndexReader implementation backed by Esplora / Mempool.space REST APIs.
 */
export function createEsploraAddressReader(
  options: EsploraAddressReaderOptions = {},
): AddressIndexReader {
  const fetchImpl = options.fetchImplementation ?? fetch;
  const concurrency = options.concurrencyLimit ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryAttempts = Math.max(1, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const retryBaseDelayMs = Math.max(
    0,
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const wait = options.waitImplementation ?? defaultWait;

  /**
   * `AbortSignal.timeout` rather than a tracked `setTimeout`: a timeout that
   * outlives its request is exactly the leak this exists to prevent, and the
   * service worker can be collected between the two.
   */
  function withDeadline(): RequestInit {
    return { signal: AbortSignal.timeout(requestTimeoutMs) };
  }

  function resolveBaseUrl(network: BitcoinNetworkName): string {
    const custom = options.customIndexerUrls?.[network];
    if (custom) return custom.replace(/\/+$/, "");
    const def = findBitcoinNetwork(network);
    return def.indexerUrl.replace(/\/+$/, "");
  }

  function backOffMs(attempt: number, hinted: number | undefined): number {
    const exponential = retryBaseDelayMs * 2 ** (attempt - 1);
    return Math.min(Math.max(exponential, hinted ?? 0), MAX_RETRY_DELAY_MS);
  }

  /**
   * One lookup, retried while the reason to retry holds.
   *
   * Throws `IndexerUnavailableError` and nothing else, so every caller in the
   * Bitcoin path -- and through it the popup -- gets a failure it can name.
   */
  async function requestJson<TResult>(
    url: string,
    baseUrl: string,
    network: BitcoinNetworkName,
  ): Promise<TResult> {
    const host = describeHost(baseUrl);
    let reason = "the request was never attempted";

    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      let response: Response;
      let hintedDelayMs: number | undefined;

      try {
        response = await fetchImpl(url, withDeadline());
      } catch (error) {
        reason = describeThrownFailure(error, requestTimeoutMs);
        if (attempt < retryAttempts) await wait(backOffMs(attempt, undefined));
        continue;
      }

      if (response.ok) {
        try {
          return (await response.json()) as TResult;
        } catch {
          // An indexer behind a throttling proxy answers 200 with an HTML
          // interstitial more often than it answers 429. Same cause, so the
          // same treatment.
          reason = "the answer was not JSON";
          if (attempt < retryAttempts) await wait(backOffMs(attempt, undefined));
          continue;
        }
      }

      reason = `HTTP ${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }`;
      if (!isTransientStatus(response.status)) {
        throw reportUnavailable({ network, host, reason });
      }
      hintedDelayMs = readRetryAfterMs(response);
      if (attempt < retryAttempts) await wait(backOffMs(attempt, hintedDelayMs));
    }

    throw reportUnavailable({
      network,
      host,
      reason: `${reason} (${retryAttempts} ${retryAttempts === 1 ? "try" : "tries"})`,
    });
  }

  async function fetchAddressStats(
    address: string,
    network: BitcoinNetworkName,
  ): Promise<AddressStats> {
    const baseUrl = resolveBaseUrl(network);
    const url = `${baseUrl}/address/${encodeURIComponent(address)}`;
    const data = await requestJson<RawEsploraAddressResponse>(url, baseUrl, network);

    const chainStats = data.chain_stats ?? {};
    const mempoolStats = data.mempool_stats ?? {};

    return {
      // Keyed back to the address WE asked about, not the one the host echoed.
      // The scan looks results up by the address it derived, and a host that
      // normalises case or omits the field would fail every lookup with
      // "reader failed to return stats" -- a message about our own code, for a
      // difference of opinion about a string.
      address,
      chainFundedSats: parseBigIntAmount(chainStats.funded_txo_sum),
      chainSpentSats: parseBigIntAmount(chainStats.spent_txo_sum),
      chainTxCount: chainStats.tx_count ?? 0,
      mempoolFundedSats: parseBigIntAmount(mempoolStats.funded_txo_sum),
      mempoolSpentSats: parseBigIntAmount(mempoolStats.spent_txo_sum),
      mempoolTxCount: mempoolStats.tx_count ?? 0,
    };
  }

  return {
    async readAddressStats({
      addresses,
      network,
    }: ReadAddressStatsParams): Promise<Map<string, AddressStats>> {
      const results = new Map<string, AddressStats>();
      if (addresses.length === 0) return results;

      // Batch execution with concurrency control
      for (let i = 0; i < addresses.length; i += concurrency) {
        const chunk = addresses.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          chunk.map((addr) => fetchAddressStats(addr, network)),
        );
        for (const stats of batchResults) {
          results.set(stats.address, stats);
        }
      }

      return results;
    },

    async listAddressTransactions({
      address,
      network,
    }: ListAddressTransactionsParams): Promise<BitcoinTransaction[]> {
      const baseUrl = resolveBaseUrl(network);
      const url = `${baseUrl}/address/${encodeURIComponent(address)}/txs`;
      const rawTxs = await requestJson<RawEsploraTx[]>(url, baseUrl, network);
      if (!Array.isArray(rawTxs)) return [];

      return rawTxs.map((raw) => ({
        txid: raw.txid,
        version: raw.version ?? 2,
        locktime: raw.locktime ?? 0,
        size: raw.size ?? 0,
        weight: raw.weight ?? 0,
        fee: parseBigIntAmount(raw.fee),
        vin: (raw.vin ?? []).map((vin) => ({
          txid: vin.txid,
          vout: vin.vout,
          sequence: vin.sequence,
          prevout: vin.prevout
            ? {
                scriptpubkey_address: vin.prevout.scriptpubkey_address,
                value: parseBigIntAmount(vin.prevout.value),
              }
            : undefined,
        })),
        vout: (raw.vout ?? []).map((vout) => ({
          scriptpubkey_address: vout.scriptpubkey_address,
          value: parseBigIntAmount(vout.value),
        })),
        status: {
          confirmed: raw.status?.confirmed ?? false,
          block_height: raw.status?.block_height,
          block_hash: raw.status?.block_hash,
          block_time: raw.status?.block_time,
        },
      }));
    },
  };
}
