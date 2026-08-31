import { erc20Abi, erc20Abi_bytes32, hexToString, type PublicClient } from "viem";
import type {
  TokenMetadataClaims,
  TokenMetadataReader,
} from "@/core/token/tokenMetadataReader";

/**
 * viem-backed TokenMetadataReader.
 *
 * ===========================================================================
 * THREE INDEPENDENT READS, THREE INDEPENDENT FAILURES
 * ===========================================================================
 * `allSettled`, not `all`. `symbol()` and `name()` are optional in ERC-20 and
 * plenty of real tokens omit one; letting a missing name take the decimals down
 * with it would make a perfectly importable token unimportable.
 *
 * `decimals` is the one that must not be papered over -- an absent value is
 * returned as absent so `validateCustomToken` can refuse. See the header of
 * core/token/tokenMetadataReader.ts.
 *
 * ===========================================================================
 * bytes32 SYMBOLS
 * ===========================================================================
 * Tokens deployed before the ABI settled -- MKR is the famous one -- return
 * `bytes32` from `symbol()` and `name()` rather than `string`. The strict
 * binding fails to decode those, so a bytes32 read is tried second. Without it
 * a legitimate token reports no symbol and the import refuses for the wrong
 * reason.
 */
export function createViemTokenMetadataReader(client: PublicClient): TokenMetadataReader {
  return {
    async readTokenMetadata({ address }): Promise<TokenMetadataClaims> {
      const contract = address as `0x${string}`;

      const [decimals, symbol, name] = await Promise.all([
        readOrUndefined(() =>
          client.readContract({ address: contract, abi: erc20Abi, functionName: "decimals" }),
        ),
        readText(client, contract, "symbol"),
        readText(client, contract, "name"),
      ]);

      return {
        // Anything that is not a plain integer is treated as no answer at all.
        // A contract returning a bigint, a string or NaN here has not told us
        // its decimals, and guessing is the failure this whole path exists to
        // avoid.
        decimals: typeof decimals === "number" && Number.isInteger(decimals) ? decimals : undefined,
        symbol,
        name,
      };
    },
  };
}

async function readOrUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    // A revert, a missing function, an EOA at that address, an unreachable
    // node -- all indistinguishable here and all mean the same thing to the
    // caller: the contract did not tell us.
    return undefined;
  }
}

async function readText(
  client: PublicClient,
  address: `0x${string}`,
  functionName: "symbol" | "name",
): Promise<string | undefined> {
  const asString = await readOrUndefined(() =>
    client.readContract({ address, abi: erc20Abi, functionName }),
  );
  if (typeof asString === "string") return asString;

  const asBytes32 = await readOrUndefined(() =>
    client.readContract({ address, abi: erc20Abi_bytes32, functionName }),
  );
  if (typeof asBytes32 !== "string" || !asBytes32.startsWith("0x")) return undefined;

  // Right-padded with zero bytes, which `hexToString` trims. A decode failure
  // means the bytes were not text, so there is nothing to show the user.
  try {
    const decoded = hexToString(asBytes32 as `0x${string}`, { size: 32 });
    return decoded === "" ? undefined : decoded;
  } catch {
    return undefined;
  }
}
