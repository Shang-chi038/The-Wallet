import { describe, expect, it } from "vitest";
import {
  parseAddChainParams,
  parsePersonalSignParams,
  parseQuantity,
  parseSendTransactionParams,
  parseSwitchChainParams,
  parseTypedDataParams,
} from "@/core/messaging/requestParams";
import { ProviderError } from "@/core/messaging/protocol";

/**
 * Every value these functions see was chosen by a hostile website. The tests
 * below are the shapes that either occur in the wild or would be catastrophic
 * if mis-parsed.
 */

const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

describe("parseQuantity", () => {
  it("returns bigint, not number", () => {
    expect(parseQuantity("0x0de0b6b3a7640000", "value")).toBe(1_000_000_000_000_000_000n);
  });

  /**
   * The reason quantities are never parsed as numbers. Above 2^53 a double
   * silently loses precision, and losing precision on a transfer amount means
   * signing for a different amount than the user approved.
   */
  it("keeps full precision beyond what a double can represent", () => {
    const huge = "0xffffffffffffffffffffffffffffffff";
    expect(parseQuantity(huge, "value")).toBe(BigInt(huge));
    expect(Number(parseQuantity(huge, "value"))).not.toBe(parseQuantity(huge, "value"));
  });

  it("treats absent and empty as zero", () => {
    expect(parseQuantity(undefined, "value")).toBe(0n);
    expect(parseQuantity("0x", "value")).toBe(0n);
  });

  it("accepts an unambiguously decimal string", () => {
    expect(parseQuantity("1000", "value")).toBe(1000n);
  });

  /**
   * A bare "10" is decimal, never hex. Guessing hex would make it 16 -- a 60%
   * difference in the amount signed, from a value the site typed as ten.
   */
  it("does not read a bare decimal string as hex", () => {
    expect(parseQuantity("10", "value")).toBe(10n);
  });

  it("rejects anything that is neither", () => {
    expect(() => parseQuantity("0xzz", "value")).toThrow(ProviderError);
    expect(() => parseQuantity({}, "value")).toThrow(ProviderError);
  });
});

describe("personal_sign argument order", () => {
  it("accepts the spec order [message, address]", () => {
    expect(parsePersonalSignParams(["hello", ADDRESS])).toEqual({
      address: ADDRESS,
      payload: "hello",
    });
  });

  /**
   * A large share of dApps send the legacy `eth_sign` order. Positional parsing
   * would sign the user's own ADDRESS as a message on every one of them.
   */
  it("accepts the legacy order [address, message]", () => {
    expect(parsePersonalSignParams([ADDRESS, "hello"])).toEqual({
      address: ADDRESS,
      payload: "hello",
    });
  });

  it("prefers the spec order when both arguments look like addresses", () => {
    expect(parsePersonalSignParams([OTHER, ADDRESS])).toEqual({
      address: ADDRESS,
      payload: OTHER,
    });
  });

  it("rejects a call with no address at all", () => {
    expect(() => parsePersonalSignParams(["hello", "world"])).toThrow(ProviderError);
  });

  it("rejects a call with too few arguments", () => {
    expect(() => parsePersonalSignParams([ADDRESS])).toThrow(ProviderError);
  });
});

describe("eth_signTypedData_v4", () => {
  const definition = {
    domain: { name: "Test", chainId: "0x1", verifyingContract: OTHER },
    types: { Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "hi" },
  };

  it("accepts typed data as a JSON string", () => {
    const parsed = parseTypedDataParams([ADDRESS, JSON.stringify(definition)]);
    expect(parsed.address).toBe(ADDRESS);
    expect(parsed.definition.primaryType).toBe("Mail");
  });

  it("accepts typed data as an object", () => {
    expect(parseTypedDataParams([ADDRESS, definition]).definition.primaryType).toBe("Mail");
  });

  /**
   * viem types the domain chainId as a number; dApps send it as a hex string.
   * If normalisation were skipped, the cross-chain replay check would compare a
   * string to a number, never match, and silently stop protecting anyone.
   */
  it("normalises a hex-string domain chainId to a number", () => {
    const parsed = parseTypedDataParams([ADDRESS, definition]);
    expect(parsed.declaredChainId).toBe(1);
    expect((parsed.definition.domain as { chainId?: unknown }).chainId).toBe(1);
  });

  it("accepts a numeric domain chainId unchanged", () => {
    const numeric = { ...definition, domain: { ...definition.domain, chainId: 137 } };
    expect(parseTypedDataParams([ADDRESS, numeric]).declaredChainId).toBe(137);
  });

  it("rejects data that is not valid JSON", () => {
    expect(() => parseTypedDataParams([ADDRESS, "{not json"])).toThrow(ProviderError);
  });

  it("rejects data with no primaryType", () => {
    const broken = { ...definition, primaryType: undefined };
    expect(() => parseTypedDataParams([ADDRESS, broken])).toThrow(ProviderError);
  });
});

describe("eth_sendTransaction", () => {
  it("parses a plain transfer", () => {
    const parsed = parseSendTransactionParams([
      { from: ADDRESS, to: OTHER, value: "0x2386f26fc10000" },
    ]);
    expect(parsed).toMatchObject({ from: ADDRESS, to: OTHER, value: 10_000_000_000_000_000n });
  });

  it("treats an absent `to` as contract deployment", () => {
    expect(parseSendTransactionParams([{ from: ADDRESS, data: "0x6080" }]).to).toBeUndefined();
  });

  /**
   * An EMPTY STRING `to` is a malformed request some libraries emit for an
   * ordinary transfer. Collapsing it to undefined would publish the calldata as
   * contract code instead of sending the value.
   */
  it("refuses an empty-string `to` rather than reading it as a deployment", () => {
    expect(() => parseSendTransactionParams([{ from: ADDRESS, to: "" }])).toThrow(ProviderError);
  });

  it("reads calldata from either `data` or `input`", () => {
    expect(parseSendTransactionParams([{ from: ADDRESS, to: OTHER, input: "0xabcd" }]).data).toBe(
      "0xabcd",
    );
  });

  it("rejects odd-length calldata", () => {
    expect(() => parseSendTransactionParams([{ from: ADDRESS, to: OTHER, data: "0xabc" }])).toThrow(
      ProviderError,
    );
  });

  it("accepts a gas limit under either name", () => {
    expect(parseSendTransactionParams([{ from: ADDRESS, to: OTHER, gas: "0x5208" }]).gasLimit).toBe(
      21_000n,
    );
    expect(
      parseSendTransactionParams([{ from: ADDRESS, to: OTHER, gasLimit: "0x5208" }]).gasLimit,
    ).toBe(21_000n);
  });

  it("rejects a malformed from address", () => {
    expect(() => parseSendTransactionParams([{ from: "0xnope", to: OTHER }])).toThrow(ProviderError);
  });
});

describe("chain params", () => {
  it("parses a hex chain id for a switch", () => {
    expect(parseSwitchChainParams([{ chainId: "0xaa36a7" }])).toBe(11155111);
  });

  /**
   * Base-10 parsing of "0x89" yields 0, and of "0x1" yields 1 by luck -- which
   * is exactly the kind of bug that passes every test written against mainnet.
   */
  it("parses a large hex chain id correctly", () => {
    expect(parseSwitchChainParams([{ chainId: "0x89" }])).toBe(137);
  });

  it("rejects a decimal chain id, which the EIP does not allow", () => {
    expect(() => parseSwitchChainParams([{ chainId: 137 }])).toThrow(ProviderError);
  });

  it("parses an add-chain request", () => {
    const parsed = parseAddChainParams([
      {
        chainId: "0x89",
        chainName: "Polygon",
        rpcUrls: ["https://polygon-rpc.com"],
        nativeCurrency: { name: "Polygon", symbol: "POL", decimals: 18 },
        blockExplorerUrls: ["https://polygonscan.com"],
      },
    ]);
    expect(parsed).toMatchObject({
      chainId: 137,
      chainName: "Polygon",
      rpcUrl: "https://polygon-rpc.com",
      blockExplorerUrl: "https://polygonscan.com",
    });
  });

  it("rejects an add-chain request with no rpc url", () => {
    expect(() =>
      parseAddChainParams([{ chainId: "0x89", chainName: "Polygon", rpcUrls: [] }]),
    ).toThrow(ProviderError);
  });

  it("rejects nonsense decimals on a proposed currency", () => {
    expect(() =>
      parseAddChainParams([
        {
          chainId: "0x89",
          chainName: "Polygon",
          rpcUrls: ["https://polygon-rpc.com"],
          nativeCurrency: { name: "X", symbol: "X", decimals: 999 },
        },
      ]),
    ).toThrow(ProviderError);
  });
});
