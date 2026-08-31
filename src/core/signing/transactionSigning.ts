import { keccak256, serializeTransaction, type TransactionSerializable } from "viem";
import { decodeHex } from "../crypto/encoding";
import { signDigest } from "./signature";

/**
 * EIP-1559 transaction signing.
 *
 * REPLAY PROTECTION IS NOT OPTIONAL. EIP-155 folds the chain ID into the signed
 * payload so a transaction signed for one network cannot be rebroadcast on
 * another. Before EIP-155, a mainnet transaction was valid verbatim on every
 * EVM chain — someone who received a testnet payment could replay it on mainnet
 * and take real funds. A transaction without a chain ID must never be signed,
 * which is why `assertSignableTransaction` refuses rather than defaulting.
 *
 * Serialisation is delegated to viem: RLP encoding, typed-envelope prefixes and
 * access-list encoding are exacting, and a malformed payload either fails to
 * broadcast or — worse — commits to different values than the ones shown in the
 * preview.
 */

export class UnsignableTransactionError extends Error {
  readonly code = "unsignable_transaction";
  constructor(reason: string) {
    super(reason);
    this.name = "UnsignableTransactionError";
  }
}

export interface SignedTransaction {
  /** RLP-encoded signed transaction, ready for eth_sendRawTransaction. */
  serialized: string;
  /** The hash it will have once mined. */
  hash: string;
}

/**
 * Validates everything that must be true before a signature is produced.
 *
 * Runs immediately before signing, on the exact object being signed — not on an
 * earlier copy. Validating a different object than the one signed is how
 * preview-vs-payload mismatches happen.
 */
export function assertSignableTransaction(
  transaction: TransactionSerializable,
  expectedChainId: number,
): void {
  if (transaction.chainId === undefined) {
    throw new UnsignableTransactionError(
      "Transaction has no chain ID: it would be replayable on every EVM network.",
    );
  }
  if (transaction.chainId !== expectedChainId) {
    throw new UnsignableTransactionError(
      `Transaction targets chain ${transaction.chainId} but the wallet is on ${expectedChainId}.`,
    );
  }
  if (transaction.nonce === undefined) {
    throw new UnsignableTransactionError("Transaction has no nonce.");
  }
  if (transaction.nonce < 0) {
    throw new UnsignableTransactionError("Nonce cannot be negative.");
  }
}

export interface SignTransactionParams {
  transaction: TransactionSerializable;
  expectedChainId: number;
  privateKey: Uint8Array;
}

export function signTransaction({
  transaction,
  expectedChainId,
  privateKey,
}: SignTransactionParams): SignedTransaction {
  assertSignableTransaction(transaction, expectedChainId);

  const unsignedSerialized = serializeTransaction(transaction);
  const digest = decodeHex(keccak256(unsignedSerialized));
  const { r, s, recovery } = signDigest(digest, privateKey);

  const serialized = serializeTransaction(transaction, {
    r: `0x${r.toString(16).padStart(64, "0")}`,
    s: `0x${s.toString(16).padStart(64, "0")}`,
    // Typed (EIP-2718) transactions carry yParity, not the legacy v. Emitting v
    // here would produce a payload nodes reject.
    yParity: recovery,
  });

  return { serialized, hash: keccak256(serialized) };
}
