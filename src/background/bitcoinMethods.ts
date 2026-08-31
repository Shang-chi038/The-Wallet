import { ProviderError, PROVIDER_ERROR_CODES } from "@/core/messaging/protocol";
import type {
  BitcoinActivityRequestParams,
  BitcoinActivityResult,
  BitcoinPortfolioRequestParams,
  BitcoinPortfolioResult,
  BitcoinReceiveAddressRequestParams,
  BitcoinReceiveAddressResult,
} from "@/core/messaging/walletApi";
import {
  isValidBitcoinNetworkName,
  type BitcoinNetworkName,
} from "@/core/bitcoin/bitcoinNetwork";
import {
  listSeedDerivedAccounts,
  requireUnlocked,
  resolveBitcoinAccountIndex,
  type RouterContext,
} from "./routerContext";

/**
 * Handlers for privileged Bitcoin wallet methods.
 */

function invalidParams(message: string): ProviderError {
  return new ProviderError(PROVIDER_ERROR_CODES.invalidParams, message);
}

function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  return params as Record<string, unknown>;
}

function requireBitcoinService(context: RouterContext) {
  if (!context.bitcoinService) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.unsupportedMethod,
      "Bitcoin support is not enabled.",
    );
  }
  return context.bitcoinService;
}

/**
 * Which BIP-84 account a request is about.
 *
 * Every handler used to read `params.accountIndex ?? 0`, and nothing on the
 * popup side ever supplied one -- so the wallet derived account 0 for every
 * account in the switcher and showed the same receive address under all of
 * them. The default is now the SELECTED account, resolved here rather than in
 * three handlers, because a default that differs between the balance and the
 * receive address is a deposit shown against a balance that will never
 * include it.
 *
 * An explicitly supplied index is checked against the accounts that actually
 * exist, for the reason `wallet.getPortfolio` checks its address: an
 * out-of-range index derives a perfectly valid address that nothing in this
 * wallet will ever scan again, so anything sent to it becomes invisible money.
 */
function resolveAccountIndex(context: RouterContext, requested: unknown): number {
  if (requested !== undefined) {
    if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 0) {
      throw invalidParams("`accountIndex` must be a non-negative integer.");
    }
    const exists = listSeedDerivedAccounts(context).some(
      (account) => account.addressIndex === requested,
    );
    if (!exists) {
      throw invalidParams(
        `This wallet has no recovery-phrase account ${requested}. Add the account first.`,
      );
    }
    return requested;
  }

  const selected = resolveBitcoinAccountIndex(context);
  if (selected === undefined) {
    throw invalidParams(
      "The selected account was imported as a private key. Bitcoin accounts come " +
        "from the recovery phrase, so an imported key has none.",
    );
  }
  return selected;
}

export async function getBitcoinPortfolio(
  context: RouterContext,
  params: unknown,
): Promise<BitcoinPortfolioResult> {
  requireUnlocked(context);
  const service = requireBitcoinService(context);

  const raw = asRecord(params) as BitcoinPortfolioRequestParams;
  const accountIndex = resolveAccountIndex(context, raw.accountIndex);

  return service.getPortfolio(accountIndex);
}

export async function getBitcoinReceiveAddress(
  context: RouterContext,
  params: unknown,
): Promise<BitcoinReceiveAddressResult> {
  requireUnlocked(context);
  const service = requireBitcoinService(context);

  const raw = asRecord(params) as BitcoinReceiveAddressRequestParams;
  const accountIndex = resolveAccountIndex(context, raw.accountIndex);

  return service.getReceiveAddress(accountIndex);
}

export async function getBitcoinActivity(
  context: RouterContext,
  params: unknown,
): Promise<BitcoinActivityResult> {
  requireUnlocked(context);
  const service = requireBitcoinService(context);

  const raw = asRecord(params) as BitcoinActivityRequestParams;
  const accountIndex = resolveAccountIndex(context, raw.accountIndex);

  return service.getActivity(accountIndex);
}

export async function switchBitcoinNetwork(
  context: RouterContext,
  params: unknown,
): Promise<{ network: BitcoinNetworkName }> {
  const service = requireBitcoinService(context);
  const raw = asRecord(params);
  const network = raw["network"];
  if (!isValidBitcoinNetworkName(network)) {
    throw invalidParams(`Invalid Bitcoin network: "${String(network)}".`);
  }

  // Awaited: the write is what makes the choice outlive the worker, and a
  // handler that returned before it landed would report a switch that a
  // collection a moment later would undo.
  await service.setActiveNetwork(network);
  return { network };
}
