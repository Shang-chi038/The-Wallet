import type { TransactionSerializable, TypedDataDefinition } from "viem";
import { withAccountPrivateKey, type Keyring } from "../keyring/keyring";
import { normalizePersonalSignPayload, signPersonalMessage } from "./messageSigning";
import { assertDomainMatchesChain, signTypedData } from "./typedDataSigning";
import { signTransaction, type SignedTransaction } from "./transactionSigning";
import type { SerializedSignature } from "./signature";

/**
 * The wallet's only signing entry point.
 *
 * Every signature in the extension goes through this module, and every method
 * here obtains its key via `withAccountPrivateKey` — which lends the key for
 * exactly one call and zeroizes it in a `finally`. There is deliberately no way
 * to get a key out of the keyring and sign with it elsewhere, so "the key is
 * wiped immediately after use" is a structural property rather than a rule
 * contributors have to remember.
 *
 * Runs in the background service worker only.
 */

export interface SignPersonalMessageRequest {
  keyring: Keyring;
  address: string;
  /** Raw payload as the dApp sent it: UTF-8 text or a 0x-prefixed hex string. */
  payload: string;
}

export async function signPersonalMessageRequest({
  keyring,
  address,
  payload,
}: SignPersonalMessageRequest): Promise<SerializedSignature> {
  const messageBytes = normalizePersonalSignPayload(payload);
  return withAccountPrivateKey({
    keyring,
    address,
    operation: (privateKey) => signPersonalMessage(messageBytes, privateKey),
  });
}

export interface SignTypedDataRequest {
  keyring: Keyring;
  address: string;
  definition: TypedDataDefinition;
  activeChainId: number;
}

export async function signTypedDataRequest({
  keyring,
  address,
  definition,
  activeChainId,
}: SignTypedDataRequest): Promise<SerializedSignature> {
  // Checked BEFORE the key is lent, so a cross-chain replay attempt never gets
  // as far as touching key material.
  assertDomainMatchesChain(definition, activeChainId);
  return withAccountPrivateKey({
    keyring,
    address,
    operation: (privateKey) => signTypedData(definition, privateKey),
  });
}

export interface SignTransactionRequest {
  keyring: Keyring;
  address: string;
  transaction: TransactionSerializable;
  expectedChainId: number;
}

export async function signTransactionRequest({
  keyring,
  address,
  transaction,
  expectedChainId,
}: SignTransactionRequest): Promise<SignedTransaction> {
  return withAccountPrivateKey({
    keyring,
    address,
    // assertSignableTransaction runs inside signTransaction, on the exact
    // object being serialised — never on an earlier copy that could have
    // diverged from what the preview showed.
    operation: (privateKey) => signTransaction({ transaction, expectedChainId, privateKey }),
  });
}
