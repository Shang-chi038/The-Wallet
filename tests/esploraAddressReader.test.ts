import { describe, expect, it } from "vitest";
import { IndexerUnavailableError } from "@/core/bitcoin/addressIndexReader";
import {
  createEsploraAddressReader,
  MAX_RETRY_DELAY_MS,
} from "@/platform/indexer/esploraAddressReader";

/**
 * ===========================================================================
 * THE MAINNET FAILURE THIS FILE IS ABOUT
 * ===========================================================================
 * A gap scan is 40 lookups, in bursts of five, and `scanBitcoinAccountAddresses`
 * fails the whole scan if any ONE of them fails -- deliberately, because a
 * partial answer is a balance that is wrong by exactly the addresses that did
 * not answer.
 *
 * The consequence is that the scan is only as reliable as its least reliable
 * request. On signet, pointed at a host serving a tiny chain, that is
 * invisible. On mainnet the built-in indexer is a public host that throttles by
 * IP and slows under load, so the same code fails the moment someone switches
 * to their real money -- and, before this, failed as a bare `Error` the router
 * would not forward, leaving "The wallet could not complete this request." and
 * a Bitcoin card that had silently disappeared.
 *
 * Two strings come out of a failure and they have different jobs: `message` is
 * rendered on the balance card and names the network, `detail` names the host
 * and the cause and never leaves the worker.
 *
 * Every test here runs against a fake fetch and an injected clock. No network,
 * no real sleeping.
 */

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  body?: unknown;
  /** Raw text, for the "200 with an HTML interstitial" case. */
  text?: string;
  headers?: Record<string, string>;
}

function fakeResponse({
  status = 200,
  statusText = "OK",
  body,
  text,
  headers = {},
}: FakeResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => {
      if (text !== undefined) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  } as unknown as Response;
}

function addressBody(address: string, txCount = 0) {
  return {
    address,
    chain_stats: {
      funded_txo_sum: 5000,
      spent_txo_sum: 1000,
      tx_count: txCount,
    },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
  };
}

/** Records what was requested and how long the reader agreed to wait. */
function createHarness(responses: Array<Response | Error>) {
  const requestedUrls: string[] = [];
  const waits: number[] = [];
  let call = 0;

  const reader = createEsploraAddressReader({
    retryBaseDelayMs: 100,
    fetchImplementation: (async (url: string) => {
      requestedUrls.push(url);
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    waitImplementation: async (ms: number) => {
      waits.push(ms);
    },
  });

  return { reader, requestedUrls, waits, callCount: () => call };
}

const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

describe("Esplora address reader", () => {
  it("retries a throttled lookup and succeeds on a later attempt", async () => {
    const harness = createHarness([
      fakeResponse({ status: 429, statusText: "Too Many Requests" }),
      fakeResponse({ body: addressBody(ADDRESS, 2) }),
    ]);

    const stats = await harness.reader.readAddressStats({
      addresses: [ADDRESS],
      network: "mainnet",
    });

    expect(harness.callCount()).toBe(2);
    expect(stats.get(ADDRESS)?.chainTxCount).toBe(2);
    // A single 429 must not cost the caller a scan.
    expect(stats.get(ADDRESS)?.chainFundedSats).toBe(5000n);
  });

  it("retries a timeout, which is how a slow public indexer fails", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const harness = createHarness([timeout, fakeResponse({ body: addressBody(ADDRESS) })]);

    await expect(
      harness.reader.readAddressStats({ addresses: [ADDRESS], network: "mainnet" }),
    ).resolves.toBeDefined();
    expect(harness.callCount()).toBe(2);
  });

  it("retries a 200 that is not JSON, which is what a throttling proxy sends", async () => {
    const harness = createHarness([
      fakeResponse({ text: "<html>Rate limited</html>" }),
      fakeResponse({ body: addressBody(ADDRESS) }),
    ]);

    await expect(
      harness.reader.readAddressStats({ addresses: [ADDRESS], network: "mainnet" }),
    ).resolves.toBeDefined();
    expect(harness.callCount()).toBe(2);
  });

  it("gives up after the attempt budget with a coded, forwardable error", async () => {
    const harness = createHarness([
      fakeResponse({ status: 429, statusText: "Too Many Requests" }),
    ]);

    const failure = await harness.reader
      .readAddressStats({ addresses: [ADDRESS], network: "mainnet" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(IndexerUnavailableError);
    const error = failure as IndexerUnavailableError;
    // The `code` is what moves this off the router's "unexpected throw" path,
    // where the message is withheld from our own pages too.
    expect(error.code).toBe("indexer_unavailable");
    expect(error.host).toBe("mempool.space");

    // What the balance card renders: the network the user picked, and nothing
    // about hosts or milliseconds. Asserted exactly, because this string is UI.
    expect(error.message).toBe("Can't contact mainnet");

    // What a developer needs, kept off the screen and on the error.
    expect(error.detail).toContain("mempool.space");
    expect(error.detail).toContain("429");

    // The path carries the user's address; neither string may.
    expect(error.message).not.toContain(ADDRESS);
    expect(error.detail).not.toContain(ADDRESS);
  });

  it("does not retry a status that describes the request itself", async () => {
    const harness = createHarness([fakeResponse({ status: 404, statusText: "Not Found" })]);

    await expect(
      harness.reader.readAddressStats({ addresses: [ADDRESS], network: "mainnet" }),
    ).rejects.toBeInstanceOf(IndexerUnavailableError);
    // Asking an identical question a second time cannot change a 404, and the
    // delay would only postpone the message.
    expect(harness.callCount()).toBe(1);
  });

  it("backs off exponentially and caps what Retry-After can ask for", async () => {
    const harness = createHarness([
      fakeResponse({
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "600" },
      }),
    ]);

    await harness.reader
      .readAddressStats({ addresses: [ADDRESS], network: "mainnet" })
      .catch(() => undefined);

    // Two waits for three attempts: nothing sleeps after the last one.
    expect(harness.waits).toHaveLength(2);
    for (const wait of harness.waits) {
      expect(wait).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS);
    }
    // A ten-minute hint inside a 40-lookup scan is indistinguishable from a
    // hang, and under MV3 the worker would be collected long before it elapsed.
    expect(harness.waits[0]).toBe(MAX_RETRY_DELAY_MS);
  });

  it("keys stats by the address it asked about, not the one echoed back", async () => {
    // A host that normalises case would otherwise fail every lookup with
    // "reader failed to return stats" -- a message about our own code, for a
    // difference of opinion about a string.
    const harness = createHarness([
      fakeResponse({ body: addressBody(ADDRESS.toUpperCase(), 1) }),
    ]);

    const stats = await harness.reader.readAddressStats({
      addresses: [ADDRESS],
      network: "mainnet",
    });

    expect(stats.get(ADDRESS)).toBeDefined();
    expect(stats.get(ADDRESS)?.address).toBe(ADDRESS);
  });

  it("uses the built-in mainnet host when the configured override is another network's", async () => {
    // The override is per-network on purpose: Esplora hosts serve one chain,
    // and pointing mainnet's requests at a signet host reports a confident zero
    // rather than failing.
    const requested: string[] = [];
    const reader = createEsploraAddressReader({
      customIndexerUrls: { signet: "https://blockstream.info/signet/api" },
      retryBaseDelayMs: 0,
      waitImplementation: async () => {},
      fetchImplementation: (async (url: string) => {
        requested.push(url);
        return fakeResponse({ body: addressBody(ADDRESS) });
      }) as unknown as typeof fetch,
    });

    await reader.readAddressStats({ addresses: [ADDRESS], network: "mainnet" });

    expect(requested[0]).toBe(`https://mempool.space/api/address/${ADDRESS}`);
  });
});
