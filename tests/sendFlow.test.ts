import { describe, expect, it } from "vitest";
import type {
  PrepareSendResult,
  RecipientResolution,
  SendMaxResult,
  SubmitSendResult,
} from "@/core/messaging/walletApi";
import { USDC_SEPOLIA } from "@/core/token/tokenRegistry";
import { PreparedTransactionStore } from "@/background/preparedTransactionStore";
import type { PreparedTransaction } from "@/background/transactionPreparation";
import {
  createHarness,
  expectError,
  expectResult,
  PAGE_SENDER,
  PRIVILEGED_SENDER,
  TEST_ADDRESS,
} from "./support/routerHarness";

/**
 * The wallet's own send flow.
 *
 * Two properties matter more than the rest, and both are about the gap between
 * reviewing a transaction and confirming it:
 *
 *   the object shown is the object signed -- nothing is rebuilt on confirm
 *   every abandoned preparation returns its nonce -- or the account is stranded
 */

const RECIPIENT = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

async function unlockedHarness() {
  const harness = createHarness();
  await harness.createAndUnlockWallet();
  return harness;
}

describe("resolveRecipient", () => {
  it("accepts an address and returns it checksummed", async () => {
    const harness = await unlockedHarness();
    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: RECIPIENT.toLowerCase() } },
        PRIVILEGED_SENDER,
      ),
    );
    // Checksummed on the way back so a later visual comparison against an
    // explorer is meaningful.
    expect(result).toEqual({ kind: "address", address: RECIPIENT });
  });

  it("resolves a name to an address", async () => {
    const harness = await unlockedHarness();
    harness.chain.ensForward.set("vitalik.eth", RECIPIENT);

    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: "vitalik.eth" } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(result).toMatchObject({ kind: "name", address: RECIPIENT, wasNormalized: false });
  });

  it("reports a name with no address record as unresolved, not invalid", async () => {
    const harness = await unlockedHarness();
    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: "nobody.eth" } },
        PRIVILEGED_SENDER,
      ),
    );
    // A different message to the user than "that is not a valid name".
    expect(result).toEqual({ kind: "unresolved", reason: "no_address_record" });
  });

  it("normalises before resolving, and says that it did", async () => {
    const harness = await unlockedHarness();
    harness.chain.ensForward.set("vitalik.eth", RECIPIENT);

    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: "Vitalik.ETH" } },
        PRIVILEGED_SENDER,
      ),
    );
    // Resolved under the normalised key, and flagged so the UI can show the
    // form that was actually looked up.
    expect(result).toMatchObject({ kind: "name", address: RECIPIENT, wasNormalized: true });
  });

  /**
   * A name that fails ENSIP-15 has no correct interpretation. Resolving it
   * anyway would resolve a name no registrar legitimately issued -- which is
   * precisely what a homograph attack needs.
   */
  it("refuses a confusable name rather than looking it up", async () => {
    const harness = await unlockedHarness();
    // U+0430 CYRILLIC SMALL LETTER A, as an escape rather than pasted -- an
    // invisible or confusable character in source is unreviewable.
    const confusable = "vit\u0430lik.eth";
    expect(confusable).not.toBe("vitalik.eth");
    // The resolver WOULD answer for it. The refusal has to happen before the
    // lookup, or a mapping an attacker controls reaches the user.
    harness.chain.ensForward.set(confusable, RECIPIENT);

    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: confusable } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects nonsense as invalid", async () => {
    const harness = await unlockedHarness();
    const result = expectResult<RecipientResolution>(
      await harness.route(
        { method: "wallet.resolveRecipient", params: { value: "0xnope" } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(result.kind).toBe("invalid");
  });

  /** A page must never reach the wallet's own send surface. */
  it("is not reachable from a web page", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      { method: "wallet.resolveRecipient", params: { value: RECIPIENT } },
      PAGE_SENDER,
    );
    expect("error" in response).toBe(true);
  });
});

describe("getSendMax", () => {
  /**
   * Putting the full balance in the value field produces a transaction that
   * cannot pay its own fee and is rejected outright -- which reads to the user
   * as the wallet refusing to send their own money.
   */
  it("reserves the worst-case fee out of a native max", async () => {
    const harness = await unlockedHarness();
    harness.chain.nativeBalance = 10n ** 18n;

    const max = expectResult<SendMaxResult>(
      await harness.route({ method: "wallet.getSendMax", params: {} }, PRIVILEGED_SENDER),
    );

    expect(BigInt(max.amountBaseUnits)).toBeLessThan(harness.chain.nativeBalance);
    expect(BigInt(max.reservedForFeeBaseUnits)).toBeGreaterThan(0n);
    expect(BigInt(max.amountBaseUnits) + BigInt(max.reservedForFeeBaseUnits)).toBe(
      harness.chain.nativeBalance,
    );
  });

  it("returns zero rather than a negative when the balance cannot cover the fee", async () => {
    const harness = await unlockedHarness();
    harness.chain.nativeBalance = 1n;

    const max = expectResult<SendMaxResult>(
      await harness.route({ method: "wallet.getSendMax", params: {} }, PRIVILEGED_SENDER),
    );
    expect(max.amountBaseUnits).toBe("0");
  });

  /** A token's fee is paid in ETH, so the whole token balance is sendable. */
  it("reserves nothing from a token max", async () => {
    const harness = await unlockedHarness();
    harness.chain.tokenBalances.set(USDC_SEPOLIA.address.toLowerCase(), 12_340_000n);

    const max = expectResult<SendMaxResult>(
      await harness.route(
        { method: "wallet.getSendMax", params: { tokenAddress: USDC_SEPOLIA.address } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(max.amountBaseUnits).toBe("12340000");
    expect(max.reservedForFeeBaseUnits).toBe("0");
    expect(max.symbol).toBe("USDC");
  });

  /**
   * Only tokens we shipped an address for. An arbitrary contract's `decimals()`
   * can report anything, and a token claiming 6 while holding 18 turns a 1.00
   * send into a 1,000,000,000,000.00 one.
   */
  it("refuses an unknown token contract", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      { method: "wallet.getSendMax", params: { tokenAddress: RECIPIENT } },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });
});

describe("prepare and submit", () => {
  it("prepares, reviews and broadcasts a native send", async () => {
    const harness = await unlockedHarness();

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: { recipient: RECIPIENT, amountBaseUnits: (10n ** 16n).toString() },
        },
        PRIVILEGED_SENDER,
      ),
    );

    expect(prepared.presentation.recipient).toBe(RECIPIENT);
    expect(prepared.transferLabel).toBe("0.01 ETH");
    expect(prepared.presentation.nonce).toBe(harness.chain.pendingNonce);

    const submitted = expectResult<SubmitSendResult>(
      await harness.route(
        { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
        PRIVILEGED_SENDER,
      ),
    );
    expect(submitted.transactionHash).toBe(harness.chain.nextTransactionHash);
    expect(harness.chain.broadcasts).toHaveLength(1);
  });

  /**
   * A token transfer moves nothing natively; the amount is in the calldata. A
   * label built from the transaction's value would say the user sent 0 ETH.
   */
  it("describes a token send by the token amount, not the native value", async () => {
    const harness = await unlockedHarness();
    harness.chain.gasEstimate = 60_000n;

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: {
            recipient: RECIPIENT,
            tokenAddress: USDC_SEPOLIA.address,
            amountBaseUnits: "12340000",
          },
        },
        PRIVILEGED_SENDER,
      ),
    );

    expect(prepared.transferLabel).toBe("12.34 USDC");
    expect(prepared.presentation.valueBaseUnits).toBe("0");
    // The transaction goes to the TOKEN contract, not the recipient.
    expect(prepared.presentation.recipient).toBe(USDC_SEPOLIA.address);
  });

  /**
   * Single use by construction. A preparation that could be submitted twice
   * would broadcast the same nonce twice, and the user would have no way to
   * tell which of the two they are waiting on.
   */
  it("cannot submit the same preparation twice", async () => {
    const harness = await unlockedHarness();
    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: { recipient: RECIPIENT, amountBaseUnits: "1000" },
        },
        PRIVILEGED_SENDER,
      ),
    );

    await harness.route(
      { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
      PRIVILEGED_SENDER,
    );
    const second = await harness.route(
      { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
      PRIVILEGED_SENDER,
    );

    expect("error" in second).toBe(true);
    expect(harness.chain.broadcasts).toHaveLength(1);
  });

  it("releases the nonce when a review is cancelled", async () => {
    const harness = await unlockedHarness();
    const key = { chainId: harness.chain.chainId, address: TEST_ADDRESS };

    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        {
          method: "wallet.prepareSend",
          params: { recipient: RECIPIENT, amountBaseUnits: "1000" },
        },
        PRIVILEGED_SENDER,
      ),
    );
    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([
      harness.chain.pendingNonce,
    ]);

    await harness.route(
      { method: "wallet.cancelSend", params: { preparationId: prepared.preparationId } },
      PRIVILEGED_SENDER,
    );
    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([]);
  });

  it("releases the nonce when the wallet locks mid-review", async () => {
    const harness = await unlockedHarness();
    const key = { chainId: harness.chain.chainId, address: TEST_ADDRESS };

    await harness.route(
      { method: "wallet.prepareSend", params: { recipient: RECIPIENT, amountBaseUnits: "1000" } },
      PRIVILEGED_SENDER,
    );
    await harness.route({ method: "wallet.lock" }, PRIVILEGED_SENDER);

    expect(harness.context.nonceAllocator.listInFlight(key)).toEqual([]);
  });

  it("refuses an unaffordable send before preparing anything", async () => {
    const harness = await unlockedHarness();
    harness.chain.nativeBalance = 1n;

    const response = await harness.route(
      {
        method: "wallet.prepareSend",
        params: { recipient: RECIPIENT, amountBaseUnits: (10n ** 18n).toString() },
      },
      PRIVILEGED_SENDER,
    );
    expect(expectError(response).message).toContain("enough ETH");
  });

  /**
   * Names are resolved before this point, by `resolveRecipient`. Accepting one
   * here would mean resolving at confirm time -- a different resolver call than
   * the one whose answer the user actually looked at.
   */
  it("refuses an unresolved name as a recipient", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      {
        method: "wallet.prepareSend",
        params: { recipient: "vitalik.eth", amountBaseUnits: "1000" },
      },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });

  it("refuses a zero or negative amount", async () => {
    const harness = await unlockedHarness();
    for (const amountBaseUnits of ["0", "-1", "1.5", ""]) {
      const response = await harness.route(
        { method: "wallet.prepareSend", params: { recipient: RECIPIENT, amountBaseUnits } },
        PRIVILEGED_SENDER,
      );
      expect("error" in response, `amount ${amountBaseUnits}`).toBe(true);
    }
  });

  it("refuses to send from an account this wallet does not hold", async () => {
    const harness = await unlockedHarness();
    const response = await harness.route(
      {
        method: "wallet.prepareSend",
        params: { from: RECIPIENT, recipient: TEST_ADDRESS, amountBaseUnits: "1000" },
      },
      PRIVILEGED_SENDER,
    );
    expect("error" in response).toBe(true);
  });

  it("records the send so activity shows it before it is mined", async () => {
    const harness = await unlockedHarness();
    const prepared = expectResult<PrepareSendResult>(
      await harness.route(
        { method: "wallet.prepareSend", params: { recipient: RECIPIENT, amountBaseUnits: "1000" } },
        PRIVILEGED_SENDER,
      ),
    );
    await harness.route(
      { method: "wallet.submitSend", params: { preparationId: prepared.preparationId } },
      PRIVILEGED_SENDER,
    );

    const pending = harness.context.pendingTransactions.list(harness.chain.chainId, TEST_ADDRESS);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.transactionHash).toBe(harness.chain.nextTransactionHash);
  });

  it("is not reachable from a web page", async () => {
    const harness = await unlockedHarness();
    for (const method of ["wallet.prepareSend", "wallet.submitSend", "wallet.cancelSend"]) {
      const response = await harness.route({ method, params: {} }, PAGE_SENDER);
      expect("error" in response, method).toBe(true);
    }
  });
});

describe("prepared transaction store", () => {
  function fakePrepared(id: string): PreparedTransaction {
    return { transferSummary: { recipient: id } } as unknown as PreparedTransaction;
  }

  it("hands a preparation back exactly once", () => {
    const released: PreparedTransaction[] = [];
    const store = new PreparedTransactionStore({ onRelease: (p) => released.push(p) });
    const id = store.store(fakePrepared("a"));

    expect(store.take(id)).toBeDefined();
    expect(store.take(id)).toBeUndefined();
  });

  /**
   * Expiry is not a cleanup detail. A preparation holds a nonce, and one that
   * is dropped without releasing it strands every later transaction from that
   * account behind a gap the chain will never fill.
   */
  it("releases the nonce of an expired preparation", () => {
    let clock = 1_000;
    const released: PreparedTransaction[] = [];
    const store = new PreparedTransactionStore({
      onRelease: (p) => released.push(p),
      now: () => clock,
    });
    const id = store.store(fakePrepared("a"));

    clock += 3 * 60 * 1000;
    expect(store.take(id)).toBeUndefined();
    expect(released).toHaveLength(1);
  });

  it("releases every held nonce on reset", () => {
    const released: PreparedTransaction[] = [];
    const store = new PreparedTransactionStore({ onRelease: (p) => released.push(p) });
    store.store(fakePrepared("a"));
    store.store(fakePrepared("b"));

    store.reset();
    expect(released).toHaveLength(2);
  });

  it("releases the oldest when the cap is reached, rather than refusing the newest", () => {
    const released: PreparedTransaction[] = [];
    const store = new PreparedTransactionStore({ onRelease: (p) => released.push(p) });
    // The user is looking at the newest one; it is the one they will confirm.
    for (let index = 0; index < 9; index += 1) store.store(fakePrepared(String(index)));
    expect(released).toHaveLength(1);
  });
});
