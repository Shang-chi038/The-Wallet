import { describe, expect, it } from "vitest";
import type { TypedDataDefinition } from "viem";
import { assessTypedDataWarnings } from "@/core/signing/typedDataSigning";

/**
 * A signed permit is the drainer technique that needs no transaction, so the
 * approval screen is the only place it can be caught. These pin WHICH shapes
 * the wallet claims to recognise -- a claim is worth exactly the tests behind
 * it, and an unrecognised shape must fall through to blind signing rather than
 * be silently treated as harmless.
 */

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const SOON = NOW_SECONDS + 3600;
const FAR = NOW_SECONDS + 400 * 24 * 60 * 60;
const MAX = (1n << 256n) - 1n;
const SPENDER = "0xaaaa000000000000000000000000000000000aaa";

function assess(primaryType: string, message: unknown) {
  return assessTypedDataWarnings({
    definition: { domain: {}, types: {}, primaryType, message } as unknown as TypedDataDefinition,
    now: NOW,
  });
}

describe("EIP-2612", () => {
  it("recognises a permit and escalates an unlimited one", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: MAX.toString(), deadline: SOON }),
    ).toEqual(["spending_permission", "unlimited_permission"]);
  });

  it("accepts the value as hex as well as decimal", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: `0x${MAX.toString(16)}`, deadline: SOON }),
    ).toContain("unlimited_permission");
  });

  it("treats a merely enormous amount as unlimited, like an on-chain approve", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: (1n << 255n).toString(), deadline: SOON }),
    ).toContain("unlimited_permission");
  });

  it("leaves a capped, short-lived permit with the base warning only", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: "1000000", deadline: SOON }),
    ).toEqual(["spending_permission"]);
  });

  it("flags a far-future deadline", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: "1000000", deadline: FAR }),
    ).toEqual(["spending_permission", "long_lived_permission"]);
  });

  it("does not flag an expiry already in the past, which is dead on arrival", () => {
    expect(
      assess("Permit", { owner: SPENDER, spender: SPENDER, value: "1", deadline: NOW_SECONDS - 60 }),
    ).toEqual(["spending_permission"]);
  });

  it("flags a permit carrying no deadline at all", () => {
    expect(assess("Permit", { owner: SPENDER, spender: SPENDER, value: "1" })).toEqual([
      "spending_permission",
      "long_lived_permission",
    ]);
  });
});

describe("DAI-style permit", () => {
  it("reads `allowed: true` as unlimited, since there is no amount field", () => {
    expect(
      assess("Permit", { holder: SPENDER, spender: SPENDER, allowed: true, expiry: SOON }),
    ).toEqual(["spending_permission", "unlimited_permission"]);
  });

  it("reads `allowed: false` as a revocation, not a grant of everything", () => {
    expect(
      assess("Permit", { holder: SPENDER, spender: SPENDER, allowed: false, expiry: SOON }),
    ).toEqual(["spending_permission"]);
  });
});

describe("Permit2", () => {
  it("recognises PermitSingle", () => {
    expect(
      assess("PermitSingle", {
        details: { token: SPENDER, amount: MAX.toString(), expiration: SOON, nonce: 0 },
        spender: SPENDER,
        sigDeadline: SOON,
      }),
    ).toEqual(["spending_permission", "unlimited_permission"]);
  });

  it("takes the worst leg of a PermitBatch", () => {
    expect(
      assess("PermitBatch", {
        details: [
          { token: SPENDER, amount: "1000", expiration: SOON },
          { token: SPENDER, amount: MAX.toString(), expiration: FAR },
        ],
        spender: SPENDER,
        sigDeadline: SOON,
      }),
    ).toEqual(["spending_permission", "unlimited_permission", "long_lived_permission"]);
  });

  it("recognises PermitTransferFrom", () => {
    expect(
      assess("PermitTransferFrom", {
        permitted: { token: SPENDER, amount: MAX.toString() },
        spender: SPENDER,
        deadline: SOON,
      }),
    ).toEqual(["spending_permission", "unlimited_permission"]);
  });
});

describe("Seaport", () => {
  it("recognises an order as a spending permission with no single amount", () => {
    expect(
      assess("OrderComponents", {
        offerer: SPENDER,
        offer: [{ token: SPENDER, startAmount: "1" }],
        consideration: [{ token: SPENDER, startAmount: "1" }],
        endTime: SOON,
      }),
    ).toEqual(["spending_permission"]);
  });
});

describe("anything else is blind signing", () => {
  it.each([
    ["an unknown struct", "Thing", { a: "1" }],
    ["a type NAMED Permit that is not one", "Permit", { greeting: "hello" }],
    ["a PermitSingle with no spender", "PermitSingle", { details: { amount: "1" } }],
    ["a non-object message", "Permit", "just a string"],
  ])("labels %s", (_label, primaryType, message) => {
    expect(assess(primaryType, message)).toEqual(["blind_signing"]);
  });
});
