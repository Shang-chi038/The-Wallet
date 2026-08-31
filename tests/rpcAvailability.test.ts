import { describe, expect, it } from "vitest";
import {
  RpcUnavailableError,
  findTransportFailureName,
  rethrowAsRpcFailure,
} from "@/core/network/rpcAvailability";

/**
 * ===========================================================================
 * TWO BAD DAYS ON THE RPC, AND THEY NEED OPPOSITE REACTIONS
 * ===========================================================================
 * A node that answers with a revert is telling the user something about their
 * transaction. A node that cannot be reached is telling them something about
 * their connection. Only the second is classified here -- widening it would
 * send someone to check their wifi over a transaction the chain refused.
 */

/** viem nests: an action error wrapping the transport error that caused it. */
function viemError(name: string, cause?: Error): Error {
  const error = new Error(`${name} (quotes the request body, which has addresses in it)`);
  error.name = name;
  if (cause) (error as { cause?: unknown }).cause = cause;
  return error;
}

describe("RPC availability", () => {
  it("finds a transport failure nested behind an action error", () => {
    // The shape a failed `getBalance` actually arrives in. Checking only the
    // outermost name would classify every one of these as "something else".
    const nested = viemError("CallExecutionError", viemError("HttpRequestError"));

    expect(findTransportFailureName(nested)).toBe("HttpRequestError");
  });

  it("treats a timeout as unreachable", () => {
    expect(findTransportFailureName(viemError("TimeoutError"))).toBe("TimeoutError");
  });

  it("leaves an answered-and-refused error alone", () => {
    // `RpcRequestError` means the node replied and the reply was an error.
    // Reachable, and refusing: a different fact, with its own wording on the
    // send screen that must not be overwritten.
    const revert = viemError("ContractFunctionRevertedError", viemError("RpcRequestError"));

    expect(findTransportFailureName(revert)).toBeUndefined();
    expect(() => rethrowAsRpcFailure(revert, "Sepolia")).toThrow(revert);
  });

  it("does not hang on a self-referential cause chain", () => {
    const looping = viemError("CallExecutionError");
    (looping as { cause?: unknown }).cause = looping;

    expect(findTransportFailureName(looping)).toBeUndefined();
  });

  it("stops walking a chain deeper than the bound", () => {
    let chain = viemError("HttpRequestError");
    for (let depth = 0; depth < 12; depth += 1) chain = viemError("CallExecutionError", chain);

    // Bounded on purpose: a wallet must not spend an unbounded walk on a
    // malformed error, and a transport failure twelve levels down is not a
    // shape viem produces.
    expect(findTransportFailureName(chain)).toBeUndefined();
  });

  it("names the chain for the user and keeps the cause for the developer", () => {
    const failure = (() => {
      try {
        rethrowAsRpcFailure(viemError("TimeoutError"), "Sepolia");
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(failure).toBeInstanceOf(RpcUnavailableError);
    const error = failure as RpcUnavailableError;
    // The `code` is what carries the message past `toErrorPayload`, which
    // withholds the message of an unexpected throw from our own pages too.
    expect(error.code).toBe("rpc_unavailable");
    // Rendered under a balance: the network the user chose, nothing else.
    expect(error.message).toBe("Can't reach Sepolia");
    expect(error.detail).toContain("timed out");
    // viem's messages quote request bodies, and a request body here holds an
    // address. Neither string may carry one through.
    expect(error.message).not.toContain("addresses");
    expect(error.detail).not.toContain("addresses");
  });
});
