import { describe, expect, it } from "vitest";
import {
  assertChainIdMatches,
  ChainIdMismatchError,
  ETHEREUM_MAINNET,
  findBuiltInChain,
  InvalidChainError,
  isValidChainId,
  parseHexChainId,
  toHexChainId,
  validateCustomChain,
} from "@/core/network/chain";
import {
  findBuiltInToken,
  isUnlimitedAllowance,
  listBuiltInTokens,
  UNLIMITED_ALLOWANCE,
  USDC_MAINNET,
  USDT_MAINNET,
} from "@/core/token/tokenRegistry";
import { isValidChecksumAddress } from "@/core/account/ethereumAddress";

describe("chain ID encoding", () => {
  it("parses EIP-3085 hex chain IDs as hex, not decimal", () => {
    expect(parseHexChainId("0x1")).toBe(1);
    expect(parseHexChainId("0xaa36a7")).toBe(11155111);
    // The classic bug: parseInt("0x89") in base 10 would not give 137.
    expect(parseHexChainId("0x89")).toBe(137);
  });

  it("round-trips", () => {
    expect(parseHexChainId(toHexChainId(11155111))).toBe(11155111);
  });

  it("rejects non-hex input", () => {
    expect(() => parseHexChainId("1")).toThrow(InvalidChainError);
    expect(() => parseHexChainId("0xzz")).toThrow(InvalidChainError);
  });

  it("validates chain IDs", () => {
    expect(isValidChainId(1)).toBe(true);
    expect(isValidChainId(0)).toBe(false);
    expect(isValidChainId(-1)).toBe(false);
    expect(isValidChainId("1")).toBe(false);
    expect(isValidChainId(1.5)).toBe(false);
  });
});

describe("validateCustomChain", () => {
  const valid = { chainId: 137, name: "Polygon", rpcUrl: "https://polygon-rpc.com" };

  it("accepts a well-formed custom chain", () => {
    expect(validateCustomChain(valid).chainId).toBe(137);
  });

  /** The core attack: a dApp redefining mainnet to point at its own RPC. */
  it("refuses to redefine a built-in chain", () => {
    expect(() =>
      validateCustomChain({ chainId: 1, name: "Ethereum", rpcUrl: "https://evil.example" }),
    ).toThrow(/already configured/);
  });

  it("requires https", () => {
    expect(() => validateCustomChain({ ...valid, rpcUrl: "http://insecure.example" })).toThrow(
      /must use https/,
    );
  });

  /**
   * The localhost exemption is GONE, and this test asserts its absence.
   *
   * It was written for a developer pointing at a local node, but the only
   * caller that reaches `validateCustomChain` is `wallet_addEthereumChain` --
   * a method any website can call. So it was never a developer affordance; it
   * was a way for a page to make the service worker connect to the user's own
   * machine, with this extension's `<all_urls>` access, which is a loopback
   * port scanner. There is no user-facing custom-RPC screen for it to serve.
   */
  it("refuses plain http even for localhost", () => {
    expect(() => validateCustomChain({ ...valid, rpcUrl: "http://localhost:8545" })).toThrow(
      /must use https/,
    );
  });

  it.each([
    "https://localhost:8545",
    "https://127.0.0.1:8545",
    "https://10.0.0.1/rpc",
    "https://192.168.1.1/rpc",
    "https://172.16.0.1/rpc",
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://[::1]:8545",
    "https://node.local/rpc",
  ])("refuses the private or loopback endpoint %s", (rpcUrl) => {
    expect(() => validateCustomChain({ ...valid, rpcUrl })).toThrow(/publicly routable/);
  });

  it("still allows an ordinary public endpoint", () => {
    expect(() =>
      validateCustomChain({ ...valid, rpcUrl: "https://rpc.example.com/v1" }),
    ).not.toThrow();
  });

  /**
   * The explorer URL ends up in an `href` in the popup with a transaction hash
   * appended, so it is a page-chosen navigation target persisted in the
   * wallet. It used to be passed through unvalidated while `rpcUrl` beside it
   * was held to https. Dropped rather than thrown: the field is optional and a
   * chain is usable without it.
   */
  it.each([
    "javascript:fetch('https://evil.example')",
    "data:text/html,<script>0</script>",
    "http://explorer.example",
    "not a url",
  ])("drops the unusable block explorer URL %s", (blockExplorerUrl) => {
    expect(validateCustomChain({ ...valid, blockExplorerUrl }).blockExplorerUrl).toBe("");
  });

  it("keeps an https block explorer URL", () => {
    expect(
      validateCustomChain({ ...valid, blockExplorerUrl: "https://explorer.example" })
        .blockExplorerUrl,
    ).toBe("https://explorer.example");
  });

  it("rejects a malformed URL", () => {
    expect(() => validateCustomChain({ ...valid, rpcUrl: "not a url" })).toThrow(InvalidChainError);
  });

  it("rejects an empty name", () => {
    expect(() => validateCustomChain({ ...valid, name: "   " })).toThrow(InvalidChainError);
  });
});

describe("assertChainIdMatches", () => {
  it("passes when the RPC agrees", () => {
    expect(() => assertChainIdMatches(1, 1)).not.toThrow();
  });

  it("throws when the RPC serves a different chain", () => {
    expect(() => assertChainIdMatches(1, 137)).toThrow(ChainIdMismatchError);
  });
});

describe("token registry", () => {
  it("stores checksummed addresses", () => {
    for (const token of [USDC_MAINNET, USDT_MAINNET]) {
      expect(isValidChecksumAddress(token.address)).toBe(true);
    }
  });

  /** The single most common stablecoin-wallet bug. */
  it("uses 6 decimals for both stablecoins, not 18", () => {
    expect(USDC_MAINNET.decimals).toBe(6);
    expect(USDT_MAINNET.decimals).toBe(6);
  });

  it("finds tokens by address case-insensitively", () => {
    expect(findBuiltInToken(1, USDC_MAINNET.address.toLowerCase())?.symbol).toBe("USDC");
  });

  it("does not leak tokens across chains", () => {
    expect(findBuiltInToken(11155111, USDC_MAINNET.address)).toBeUndefined();
    expect(
      listBuiltInTokens(1)
        .map((t) => t.symbol)
        .sort(),
    ).toEqual(["USDC", "USDT"]);
  });

  it("ships no Sepolia USDT, because Tether publishes none", () => {
    expect(listBuiltInTokens(11155111).some((t) => t.symbol === "USDT")).toBe(false);
  });

  it("knows the built-in mainnet chain", () => {
    expect(findBuiltInChain(1)).toBe(ETHEREUM_MAINNET);
    expect(findBuiltInChain(999999)).toBeUndefined();
  });
});

describe("unlimited allowance detection", () => {
  it("flags the exact 2^256-1 sentinel", () => {
    expect(isUnlimitedAllowance(UNLIMITED_ALLOWANCE)).toBe(true);
  });

  /** Drainers often ask for merely-enormous values to dodge naive checks. */
  it("flags merely-enormous approvals too", () => {
    expect(isUnlimitedAllowance(1n << 255n)).toBe(true);
    expect(isUnlimitedAllowance((1n << 256n) - 12345n)).toBe(true);
  });

  it("does not flag ordinary approvals", () => {
    expect(isUnlimitedAllowance(1_000_000n)).toBe(false);
    expect(isUnlimitedAllowance(0n)).toBe(false);
  });
});
