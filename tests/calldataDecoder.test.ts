import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import {
  decodeTransactionIntent,
  describeTransactionIntent,
} from "@/core/transaction/calldataDecoder";
import { USDC_MAINNET, UNLIMITED_ALLOWANCE } from "@/core/token/tokenRegistry";

const RECIPIENT = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
const SPENDER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const KNOWN_TOKENS = [USDC_MAINNET];

describe("native transfer", () => {
  it("decodes a plain value transfer", () => {
    expect(decodeTransactionIntent({ to: RECIPIENT, value: 10n ** 18n, data: "0x" })).toMatchObject({
      kind: "nativeTransfer",
      recipient: RECIPIENT,
      amount: 10n ** 18n,
      isBlindSigning: false,
      warnings: [],
    });
  });

  it("treats undefined data as a plain transfer", () => {
    expect(decodeTransactionIntent({ to: RECIPIENT, value: 1n, data: undefined }).kind).toBe(
      "nativeTransfer",
    );
  });
});

describe("ERC-20 transfer", () => {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [RECIPIENT, 5_000_000n],
  });

  it("decodes recipient and amount", () => {
    expect(
      decodeTransactionIntent({
        to: USDC_MAINNET.address,
        value: 0n,
        data,
        knownTokens: KNOWN_TOKENS,
      }),
    ).toMatchObject({ kind: "tokenTransfer", recipient: RECIPIENT, amount: 5_000_000n });
  });

  /** 5000000 base units at 6 decimals is 5 USDC, not 0.000000000005. */
  it("formats the amount using the token's real decimals", () => {
    const intent = decodeTransactionIntent({
      to: USDC_MAINNET.address,
      value: 0n,
      data,
      knownTokens: KNOWN_TOKENS,
    });
    expect(intent).toMatchObject({ formattedAmount: "5" });
    expect(describeTransactionIntent(intent)).toBe(`Send 5 USDC to ${RECIPIENT}`);
  });

  /** Unknown decimals means we cannot state the amount, so say so. */
  it("marks a transfer of an unknown token as blind signing", () => {
    expect(
      decodeTransactionIntent({
        to: "0x1111111111111111111111111111111111111111",
        value: 0n,
        data,
        knownTokens: KNOWN_TOKENS,
      }),
    ).toMatchObject({ kind: "tokenTransfer", isBlindSigning: true, formattedAmount: undefined });
  });

  it("warns when sending a token to its own contract address", () => {
    const selfSend = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [USDC_MAINNET.address as `0x${string}`, 1_000_000n],
    });
    expect(
      decodeTransactionIntent({
        to: USDC_MAINNET.address,
        value: 0n,
        data: selfSend,
        knownTokens: KNOWN_TOKENS,
      }).warnings,
    ).toContain("transfer_to_token_contract");
  });
});

describe("ERC-20 approve", () => {
  it("decodes a bounded approval without warning", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SPENDER, 100_000_000n],
    });
    expect(
      decodeTransactionIntent({
        to: USDC_MAINNET.address,
        value: 0n,
        data,
        knownTokens: KNOWN_TOKENS,
      }),
    ).toMatchObject({
      kind: "tokenApproval",
      spender: SPENDER,
      isUnlimited: false,
      formattedAmount: "100",
      warnings: [],
    });
  });

  /** The highest-value warning in the wallet. */
  it("flags an unlimited approval", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SPENDER, UNLIMITED_ALLOWANCE],
    });
    const intent = decodeTransactionIntent({
      to: USDC_MAINNET.address,
      value: 0n,
      data,
      knownTokens: KNOWN_TOKENS,
    });
    expect(intent).toMatchObject({ kind: "tokenApproval", isUnlimited: true });
    expect(intent.warnings).toContain("unlimited_approval");
    expect(describeTransactionIntent(intent)).toBe(`Give unlimited USDC access to ${SPENDER}`);
  });

  /** Drainers use merely-enormous values to dodge exact-sentinel checks. */
  it("flags a merely-enormous approval as unlimited too", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SPENDER, (1n << 255n) + 99n],
    });
    expect(
      decodeTransactionIntent({
        to: USDC_MAINNET.address,
        value: 0n,
        data,
        knownTokens: KNOWN_TOKENS,
      }).warnings,
    ).toContain("unlimited_approval");
  });
});

describe("NFT setApprovalForAll", () => {
  const abi = parseAbi(["function setApprovalForAll(address operator, bool approved)"]);

  it("flags granting collection-wide access", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "setApprovalForAll",
      args: [SPENDER, true],
    });
    const intent = decodeTransactionIntent({ to: RECIPIENT, value: 0n, data });
    expect(intent).toMatchObject({ kind: "nftApprovalForAll", operator: SPENDER, approved: true });
    expect(intent.warnings).toContain("unlimited_approval");
    expect(describeTransactionIntent(intent)).toBe(
      `Give ${SPENDER} access to your entire collection`,
    );
  });

  it("does not warn when revoking", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "setApprovalForAll",
      args: [SPENDER, false],
    });
    const intent = decodeTransactionIntent({ to: RECIPIENT, value: 0n, data });
    expect(intent.warnings).toEqual([]);
    expect(describeTransactionIntent(intent)).toContain("Revoke");
  });
});

describe("unrecognised calldata", () => {
  /**
   * The default must be to admit ignorance. Rendering an undecodable call as an
   * ordinary transfer is how users approve drainers.
   */
  it("is labelled blind signing rather than guessed at", () => {
    const intent = decodeTransactionIntent({
      to: RECIPIENT,
      value: 0n,
      data: "0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001",
    });
    expect(intent).toMatchObject({
      kind: "unknownContractCall",
      functionSelector: "0xdeadbeef",
      isBlindSigning: true,
    });
    expect(intent.warnings).toContain("blind_signing");
  });

  it("reports the calldata size", () => {
    expect(decodeTransactionIntent({ to: RECIPIENT, value: 0n, data: "0xdeadbeef" })).toMatchObject({
      dataByteLength: 4,
    });
  });
});

describe("contract deployment", () => {
  it("flags a missing `to` as deployment and blind signing", () => {
    const intent = decodeTransactionIntent({ to: undefined, value: 0n, data: "0x6080604052" });
    expect(intent).toMatchObject({ kind: "contractDeployment", isBlindSigning: true });
    expect(intent.warnings).toContain("contract_deployment");
    expect(describeTransactionIntent(intent)).toBe("Deploy a new contract");
  });
});
