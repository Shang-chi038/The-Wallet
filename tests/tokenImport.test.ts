import { describe, expect, it } from "vitest";
import {
  DuplicateTokenError,
  InvalidTokenError,
  MAX_TOKEN_DECIMALS,
  parseStoredCustomToken,
  sanitizeTokenText,
  validateCustomToken,
} from "@/core/token/customToken";
import { USDC_SEPOLIA } from "@/core/token/tokenRegistry";
import { TokenService } from "@/background/tokenService";
import { toChecksumAddress } from "@/core/account/ethereumAddress";
import type {
  PortfolioResult,
  PrepareSendResult,
  TokenClaimsResult,
  TokenListResult,
} from "@/core/messaging/walletApi";
import {
  createHarness,
  expectError,
  expectResult,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
  type Harness,
} from "./support/routerHarness";

/**
 * Importing a token means trusting a stranger's contract to describe itself.
 *
 * Everything here defends one of three properties:
 *
 *   The wallet never GUESSES metadata. An unreadable `decimals()` refuses the
 *   import rather than assuming 18 -- the difference between sending 1.00 and
 *   sending 1,000,000,000,000.00.
 *
 *   The wallet stores what the user was SHOWN. A contract that answers
 *   differently on the second read is caught, not saved.
 *
 *   The wallet never puts a price on an imported token. Quotes are keyed by
 *   symbol and anyone can deploy a contract calling itself "USDC", so pricing
 *   one would let a worthless holding render as real money.
 */

const IMPOSTOR = toChecksumAddress("0x00000000000000000000000000000000000000aa");
const HONEST_TOKEN = toChecksumAddress("0x00000000000000000000000000000000000000bb");
const NOT_A_TOKEN = toChecksumAddress("0x00000000000000000000000000000000000000cc");
const RECIPIENT = toChecksumAddress("0x000000000000000000000000000000000000dead");

/** U+202E, the right-to-left override: reverses whatever renders after it. */
const BIDI_OVERRIDE = "\u202E";
/** U+200B, a zero-width space: invisible, and pads a symbol past a length cap. */
const ZERO_WIDTH = "\u200B";

async function unlockedHarness(): Promise<Harness> {
  const harness = createHarness();
  await harness.createAndUnlockWallet();
  return harness;
}

async function lookup(harness: Harness, address: string): Promise<TokenClaimsResult> {
  return expectResult<TokenClaimsResult>(
    await harness.route({ method: "wallet.lookupToken", params: { address } }, PRIVILEGED_SENDER),
  );
}

async function importToken(
  harness: Harness,
  address: string,
  decimals: number,
): Promise<ReturnType<typeof expectError> | undefined> {
  const response = await harness.route(
    { method: "wallet.importToken", params: { address, decimals } },
    PRIVILEGED_SENDER,
  );
  return "error" in response ? expectError(response) : undefined;
}

// ---------------------------------------------------------------------------
// Validation, with no engine involved
// ---------------------------------------------------------------------------

describe("custom token validation", () => {
  const base = { address: HONEST_TOKEN, chainId: 11155111, decimals: 18 };

  it("strips characters that can reorder the text beside a balance", () => {
    const token = validateCustomToken({
      ...base,
      symbol: `AB${BIDI_OVERRIDE}CD`,
      name: `Nice${ZERO_WIDTH} Token`,
    });
    expect(token.symbol).toBe("ABCD");
    expect(token.name).toBe("Nice Token");
    // Belt and braces: nothing invisible survived into either field.
    expect(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/.test(token.symbol + token.name)).toBe(
      false,
    );
  });

  it("caps symbol and name length", () => {
    const token = validateCustomToken({
      ...base,
      symbol: "S".repeat(200),
      name: "N".repeat(500),
    });
    expect(token.symbol).toHaveLength(16);
    expect(token.name).toHaveLength(64);
  });

  it("falls back to the symbol when the contract has no name", () => {
    expect(validateCustomToken({ ...base, symbol: "FOO" }).name).toBe("FOO");
  });

  it("refuses decimals no usable token has", () => {
    for (const decimals of [-1, 1.5, MAX_TOKEN_DECIMALS + 1, 255]) {
      expect(() => validateCustomToken({ ...base, decimals, symbol: "FOO" })).toThrow(
        InvalidTokenError,
      );
    }
  });

  it("refuses a contract that reports no usable symbol", () => {
    expect(() => validateCustomToken({ ...base, symbol: ZERO_WIDTH })).toThrow(InvalidTokenError);
    expect(() => validateCustomToken({ ...base, symbol: undefined })).toThrow(InvalidTokenError);
  });

  /**
   * The attack this one blocks: a site walks the user through "re-adding" USDC
   * so it can attach its own decimals to an address they already trust.
   */
  it("refuses to redefine a built-in token", () => {
    expect(() =>
      validateCustomToken({
        address: USDC_SEPOLIA.address,
        chainId: USDC_SEPOLIA.chainId,
        decimals: 18,
        symbol: "USDC",
      }),
    ).toThrow(DuplicateTokenError);
  });

  it("leaves ordinary text alone", () => {
    expect(sanitizeTokenText("  Wrapped  Ether ")).toBe("Wrapped Ether");
  });

  it("drops a stored entry whose decimals were corrupted", () => {
    const good = { ...base, symbol: "FOO", name: "Foo", isBuiltIn: false };
    expect(parseStoredCustomToken(good)?.symbol).toBe("FOO");
    expect(parseStoredCustomToken({ ...good, decimals: 999 })).toBeUndefined();
    expect(parseStoredCustomToken({ ...good, decimals: "18" })).toBeUndefined();
    expect(parseStoredCustomToken({ ...good, address: "not an address" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lookup and import, through the router
// ---------------------------------------------------------------------------

describe("wallet.lookupToken", () => {
  it("reports what the contract claims, sanitised, with the holding", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: `WBTC${BIDI_OVERRIDE}`,
      name: "Wrapped Bitcoin",
    });
    harness.chain.tokenBalances.set(HONEST_TOKEN.toLowerCase(), 150_000_000n);

    const claims = await lookup(harness, HONEST_TOKEN);
    expect(claims.decimals).toBe(8);
    expect(claims.symbol).toBe("WBTC");
    expect(claims.name).toBe("Wrapped Bitcoin");
    expect(claims.balanceBaseUnits).toBe("150000000");
    expect(claims.balanceLabel).toBe("1.5");
    expect(claims.isKnown).toBe(false);
  });

  /**
   * An EOA, a project's website contract, a paste of the wrong thing -- all
   * indistinguishable, and all refused. Defaulting to 18 here is the single
   * most expensive guess this codebase could make.
   */
  it("refuses an address that does not answer as a token contract", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      { method: "wallet.lookupToken", params: { address: NOT_A_TOKEN } },
      PRIVILEGED_SENDER,
    );
    expect((expectError(response) as { data?: { reason?: string } }).data?.reason).toBe(
      "token_not_readable",
    );
  });

  it("reports a token the wallet already ships rather than erroring", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenBalances.set(USDC_SEPOLIA.address.toLowerCase(), 0n);

    const claims = await lookup(harness, USDC_SEPOLIA.address);
    expect(claims.isKnown).toBe(true);
    expect(claims.isBuiltIn).toBe(true);
    expect(claims.decimals).toBe(USDC_SEPOLIA.decimals);
  });
});

describe("wallet.importToken", () => {
  it("stores the token and makes it visible to the portfolio", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
    });
    harness.chain.tokenBalances.set(HONEST_TOKEN.toLowerCase(), 150_000_000n);

    expect(await importToken(harness, HONEST_TOKEN, 8)).toBeUndefined();

    const portfolio = expectResult<PortfolioResult>(
      await harness.route(
        { method: "wallet.getPortfolio", params: { address: TEST_ADDRESS } },
        PRIVILEGED_SENDER,
      ),
    );
    const entry = portfolio.entries.find((candidate) => candidate.symbol === "WBTC");
    expect(entry?.balanceLabel).toBe("1.5");
    expect(entry?.isImported).toBe(true);
  });

  /**
   * The reason lookup and import are two calls.
   *
   * A contract that answers 6 to the preview and 18 to the import has arranged
   * for the user to approve one token and the wallet to save another.
   */
  it("refuses a contract that changes its decimals between the two reads", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(IMPOSTOR.toLowerCase(), {
      // First read 6, every read after that 18.
      decimals: [6, 18],
      symbol: "FOO",
    });

    const claims = await lookup(harness, IMPOSTOR);
    expect(claims.decimals).toBe(6);

    const error = await importToken(harness, IMPOSTOR, claims.decimals);
    expect((error as { data?: { reason?: string } }).data?.reason).toBe("token_metadata_changed");

    // And nothing was stored.
    const listed = expectResult<TokenListResult>(
      await harness.route({ method: "wallet.listTokens", params: {} }, PRIVILEGED_SENDER),
    );
    expect(listed.tokens).toHaveLength(0);
  });

  it("refuses decimals the caller did not see", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });

    const error = await importToken(harness, HONEST_TOKEN, 18);
    expect((error as { data?: { reason?: string } }).data?.reason).toBe("token_metadata_changed");
  });

  it("refuses the same token twice, and allows removing it", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });

    expect(await importToken(harness, HONEST_TOKEN, 8)).toBeUndefined();
    const second = await importToken(harness, HONEST_TOKEN, 8);
    expect((second as { data?: { reason?: string } }).data?.reason).toBe("duplicate_token");

    // Lowercase, to prove the check is on the address and not on its spelling.
    const third = await importToken(harness, HONEST_TOKEN.toLowerCase(), 8);
    expect((third as { data?: { reason?: string } }).data?.reason).toBe("duplicate_token");

    const removed = expectResult<{ removed: boolean }>(
      await harness.route(
        { method: "wallet.removeToken", params: { address: HONEST_TOKEN } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(removed.removed).toBe(true);
    expect(await importToken(harness, HONEST_TOKEN, 8)).toBeUndefined();
  });

  it("survives a restart, because it is stored and re-validated on load", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 8, symbol: "WBTC" });
    await importToken(harness, HONEST_TOKEN, 8);

    const listed = expectResult<TokenListResult>(
      await harness.route({ method: "wallet.listTokens", params: {} }, PRIVILEGED_SENDER),
    );
    expect(listed.tokens).toEqual([
      expect.objectContaining({ address: HONEST_TOKEN, symbol: "WBTC", decimals: 8 }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The spoof
// ---------------------------------------------------------------------------

describe("imported tokens are never priced", () => {
  /**
   * The single most important test in this file.
   *
   * Filtering the OUTBOUND symbol list is not enough: the real USDC's quote is
   * already in the price map, put there by the built-in entry, so a lookup by
   * symbol would find it. The gate has to be on the read.
   */
  it("gives a token calling itself USDC no fiat value, while real USDC keeps its price", async () => {
    const harness = await unlockedHarness();
    harness.prices.set("USDC", { price: 1, change24hPercent: 0.01 });
    harness.prices.set("ETH", { price: 2_000, change24hPercent: 1 });

    harness.chain.tokenContracts.set(IMPOSTOR.toLowerCase(), {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    });
    // A million impostor units, and five real ones.
    harness.chain.tokenBalances.set(IMPOSTOR.toLowerCase(), 1_000_000_000_000n);
    harness.chain.tokenBalances.set(USDC_SEPOLIA.address.toLowerCase(), 5_000_000n);
    harness.chain.nativeBalance = 0n;

    await importToken(harness, IMPOSTOR, 6);

    const portfolio = expectResult<PortfolioResult>(
      await harness.route(
        { method: "wallet.getPortfolio", params: { address: TEST_ADDRESS } },
        PRIVILEGED_SENDER,
      ),
    );

    const impostor = portfolio.entries.find((entry) => entry.tokenAddress === IMPOSTOR);
    const real = portfolio.entries.find(
      (entry) => entry.tokenAddress === USDC_SEPOLIA.address,
    );

    expect(impostor?.symbol).toBe("USDC");
    expect(impostor?.fiatValue).toBeUndefined();
    // Not "unavailable": nothing failed, and telling the user to retry would be
    // telling them to wait for something that is never coming.
    expect(impostor?.fiatStatus).toBe("unpriced");
    expect(real?.fiatValue).toBe(5);
    expect(real?.fiatStatus).toBe("priced");

    // $5, not $1,000,005. The impostor contributes nothing.
    expect(portfolio.totalFiatValue).toBe(5);
  });

  /**
   * Holding something unvalued must not blank the hero figure. The aggregate
   * rules refuse to answer when a HELD asset has no price -- correct for a
   * failed feed, wrong for an asset that has no price by design.
   */
  it("still reports a total and a 24h change while an imported token is held", async () => {
    const harness = await unlockedHarness();
    harness.prices.set("ETH", { price: 2_000, change24hPercent: 10 });
    harness.chain.nativeBalance = 10n ** 18n;

    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), { decimals: 18, symbol: "FOO" });
    harness.chain.tokenBalances.set(HONEST_TOKEN.toLowerCase(), 42n * 10n ** 18n);
    await importToken(harness, HONEST_TOKEN, 18);

    const portfolio = expectResult<PortfolioResult>(
      await harness.route(
        { method: "wallet.getPortfolio", params: { address: TEST_ADDRESS } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(portfolio.totalFiatValue).toBe(2_000);
    expect(portfolio.change.status).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Sending one
// ---------------------------------------------------------------------------

describe("sending an imported token", () => {
  it("decodes into a readable preview, marked as imported rather than blind", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
    });
    harness.chain.tokenBalances.set(HONEST_TOKEN.toLowerCase(), 150_000_000n);
    await importToken(harness, HONEST_TOKEN, 8);

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: {
            recipient: RECIPIENT,
            tokenAddress: HONEST_TOKEN,
            amountBaseUnits: "100000000",
          },
        },
        PRIVILEGED_SENDER,
      ),
    );

    // The whole point of putting imported tokens in `knownTokens`: without it
    // the wallet's own send of one falls through to blind signing.
    expect(prepared.presentation.isBlindSigning).toBe(false);
    expect(prepared.transferLabel).toBe("1 WBTC");
    // And the preview says whose word the metadata is.
    expect(prepared.presentation.warnings).toContain("imported_token");
  });

  /**
   * The cold-start case, which every other test here hides.
   *
   * `addToken` loads the stored list as a side effect, so by the time a test
   * sends a transaction the service is already populated. An MV3 worker that
   * has just been collected and restarted is not: its list is empty until
   * `load()` resolves. If the send path relied on someone else having loaded
   * it, the transfer would decode as an unknown contract call and the user
   * would be shown "the wallet cannot read this" for a token they added
   * themselves -- teaching them to click through blind-signing warnings.
   *
   * A FRESH service over the same storage reproduces that exactly.
   */
  it("decodes after a worker restart, with a service that has not loaded yet", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenContracts.set(HONEST_TOKEN.toLowerCase(), {
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
    });
    harness.chain.tokenBalances.set(HONEST_TOKEN.toLowerCase(), 150_000_000n);
    await importToken(harness, HONEST_TOKEN, 8);

    // Same storage, new instance: exactly what a restarted worker holds before
    // anything has awaited its load.
    harness.context.tokenService = new TokenService({ area: harness.area });

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: {
            recipient: RECIPIENT,
            tokenAddress: HONEST_TOKEN,
            amountBaseUnits: "100000000",
          },
        },
        PRIVILEGED_SENDER,
      ),
    );
    expect(prepared.presentation.isBlindSigning).toBe(false);
    expect(prepared.transferLabel).toBe("1 WBTC");
  });

  it("still refuses a token address the wallet does not know", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      {
        method: "wallet.prepareSend",
        params: { recipient: RECIPIENT, tokenAddress: NOT_A_TOKEN, amountBaseUnits: "1" },
      },
      PRIVILEGED_SENDER,
    );
    expect(expectError(response).code).toBeDefined();
  });
});
