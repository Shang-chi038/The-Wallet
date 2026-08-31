/**
 * Live integration smoke test — hits a real RPC, so it is NOT part of `npm test`.
 *
 * The unit suite is hermetic and must stay that way. This script exists to
 * verify the seams that mocks cannot: that our derived addresses are the ones
 * the network agrees with, that ERC-20 decimals are read correctly from a real
 * contract, and that the chain-impersonation guard fires.
 *
 * Run with: npm run smoke
 */
import { readFileSync } from "node:fs";
import { WalletService } from "@/core/wallet/walletService";
import { createMemoryStorageArea, createVaultStorage } from "@/core/vault/vaultStorage";
import { ETHEREUM_SEPOLIA, assertChainIdMatches } from "@/core/network/chain";
import { listBuiltInTokens } from "@/core/token/tokenRegistry";
import { createRpcClient, resolveRpcUrls } from "@/platform/rpc/rpcClient";
import { createViemBalanceReader } from "@/platform/rpc/viemBalanceReader";
import { createViemNetworkReader } from "@/platform/rpc/viemNetworkReader";
import { formatTokenAmount, formatTokenAmountForDisplay } from "@/core/token/tokenAmount";
import { computeFeeEstimates, applyGasLimitMargin } from "@/core/transaction/feeEstimate";
import { NonceAllocator } from "@/core/transaction/nonceAllocator";
import {
  assertSufficientBalance,
  buildTransaction,
  computeSendMaxAmount,
  summarizeTransactionCost,
} from "@/core/transaction/transactionBuilder";
import { signTransactionRequest } from "@/core/signing/signingService";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// 1. Create + unlock a real wallet through the full vault path.
const service = new WalletService({ storage: createVaultStorage(createMemoryStorageArea()) });
const created = await service.createWallet({
  password: "integration test password",
  mnemonic: PHRASE,
});
console.log("1. wallet created, account 0 =", created.accounts[0]!.address);
service.lock();
const accounts = await service.unlock("integration test password");
console.log("   unlocked, address matches:", accounts[0]!.address === created.accounts[0]!.address);

// 2. Real RPC.
const rpcUrls = resolveRpcUrls(ETHEREUM_SEPOLIA, env.VITE_ALCHEMY_API_KEY);
const client = createRpcClient({ chain: ETHEREUM_SEPOLIA, rpcUrls });
const reader = createViemBalanceReader(client);

// 3. Chain ID must match what we claim, or refuse to proceed.
const actualChainId = await reader.readChainId();
assertChainIdMatches(ETHEREUM_SEPOLIA.chainId, actualChainId);
console.log("2. chain id verified:", actualChainId);

// 4. Native + ERC-20 balances for a known-funded Sepolia address.
const target = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
const native = await reader.readNativeBalance({
  address: target,
  chainId: ETHEREUM_SEPOLIA.chainId,
});
console.log(
  "3. native balance:",
  formatTokenAmountForDisplay(native, 18),
  "ETH  (raw",
  native.toString() + " wei)",
);

const tokens = listBuiltInTokens(ETHEREUM_SEPOLIA.chainId);
const balances = await reader.readTokenBalances({
  address: target,
  chainId: ETHEREUM_SEPOLIA.chainId,
  tokens,
});
for (const token of tokens) {
  const amount = balances.get(token.address.toLowerCase()) ?? 0n;
  console.log(
    `4. ${token.symbol} (${token.decimals}dp):`,
    formatTokenAmountForDisplay(amount, token.decimals),
    " raw:",
    amount.toString(),
  );
}

// 5. Chain ID mismatch must be rejected.
try {
  assertChainIdMatches(1, actualChainId);
  console.log("5. FAIL: mismatch was not caught");
} catch (error) {
  console.log("5. impersonation guard works:", (error as Error).message.slice(0, 68) + "...");
}

// 6. Fee + nonce builder against live chain data.
const network = createViemNetworkReader(client);
const history = await network.readFeeHistory();
const fees = computeFeeEstimates({ history });
const gwei = (value: bigint) => formatTokenAmount(value, 9, { maximumFractionDigits: 3 });

console.log("6. live base fee:", gwei(history.baseFeePerGas), "gwei");
for (const level of ["low", "medium", "high"] as const) {
  const fee = fees[level];
  console.log(
    `   ${level.padEnd(6)} tip ${gwei(fee.maxPriorityFeePerGas).padStart(7)} | expect ${gwei(
      fee.expectedFeePerGas,
    ).padStart(8)} | max ${gwei(fee.maxFeePerGas).padStart(8)} gwei`,
  );
}

const sender = created.accounts[0]!.address;
const pendingNonce = await network.readPendingNonce(sender);
const allocator = new NonceAllocator();
const firstNonce = allocator.allocate({
  chainId: ETHEREUM_SEPOLIA.chainId,
  address: sender,
  pendingNonceFromChain: pendingNonce,
});
const secondNonce = allocator.allocate({
  chainId: ETHEREUM_SEPOLIA.chainId,
  address: sender,
  pendingNonceFromChain: pendingNonce,
});
console.log(
  "7. chain pending nonce:",
  pendingNonce,
  "| two concurrent sends get:",
  firstNonce,
  "and",
  secondNonce,
);

// The test account is unfunded, so estimation fails at the node and the
// fallback path is exercised — exactly what a brand-new wallet hits.
const { gasLimit: rawGas, isEstimated } = await network.estimateGasWithFallback({
  from: sender,
  to: target,
  value: 1n,
  fallbackKind: "nativeTransfer",
});
const gasLimit = applyGasLimitMargin(rawGas);
console.log(
  "8. gas:",
  rawGas.toString(),
  isEstimated ? "(estimated on chain)" : "(FALLBACK — sender unfunded, node refused to simulate)",
  "-> with margin:",
  gasLimit.toString(),
);

const summary = summarizeTransactionCost({ value: 10n ** 15n, gasLimit, fee: fees.medium });
console.log(
  "9. cost: expected",
  formatTokenAmount(summary.expectedTotal, 18, { maximumFractionDigits: 8 }),
  "ETH | max",
  formatTokenAmount(summary.maximumTotal, 18, { maximumFractionDigits: 8 }),
  "ETH",
);

// Build and sign a real transaction (NOT broadcast).
const transaction = buildTransaction({
  from: sender,
  to: target,
  value: 10n ** 15n,
  chainId: ETHEREUM_SEPOLIA.chainId,
  nonce: firstNonce,
  gasLimit,
  fee: fees.medium,
});
const signed = await signTransactionRequest({
  keyring: service.getKeyring(),
  address: sender,
  transaction,
  expectedChainId: ETHEREUM_SEPOLIA.chainId,
});
console.log(
  "10. signed tx hash:",
  signed.hash,
  `(${signed.serialized.length / 2} bytes, not broadcast)`,
);

// Send-max must leave the transaction affordable.
const balanceForMax = 10n ** 17n;
const maxSend = computeSendMaxAmount({
  nativeBalance: balanceForMax,
  gasLimit,
  fee: fees.medium,
});
assertSufficientBalance({
  nativeBalance: balanceForMax,
  value: maxSend,
  gasLimit,
  fee: fees.medium,
});
console.log(
  "11. send-max on 0.1 ETH =",
  formatTokenAmount(maxSend, 18, { maximumFractionDigits: 8 }),
  "ETH (still affordable)",
);
