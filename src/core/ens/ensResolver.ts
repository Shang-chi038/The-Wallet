/**
 * Name resolution contract.
 *
 * Declared in `core` so the send flow can depend on the shape without dragging
 * in a resolver, and so a test can exercise "the name did not resolve" without
 * a network. The viem-backed implementation is in `platform/ens`.
 *
 * ===========================================================================
 * WHY BOTH DIRECTIONS RETURN undefined RATHER THAN THROWING
 * ===========================================================================
 * A name that does not resolve is a normal outcome, not an error: the user
 * mistyped, or the name exists but has no address record. The send screen shows
 * "no address for this name" and lets them keep typing. Modelling it as a
 * thrown error pushes callers into a catch block where it gets lumped in with
 * a dead RPC, and the user is told something went wrong when the truth is
 * simply that nobody owns that name.
 */

export interface EnsResolver {
  /**
   * Name -> address. The name must already be ENSIP-15 normalised; passing raw
   * user input here defeats the homograph protection entirely.
   */
  resolveName(params: { normalizedName: string; chainId: number }): Promise<string | undefined>;

  /**
   * Address -> name, FORWARD-VERIFIED.
   *
   * Anyone can point a reverse record at any name they like, so an unverified
   * reverse lookup would let an attacker make their own address display as
   * "binance.eth" in a transaction preview. The implementation must confirm the
   * name's forward record resolves back to this address, and return undefined
   * when it does not.
   */
  lookupAddress(params: { address: string; chainId: number }): Promise<string | undefined>;
}

/** The resolver used on chains with no ENS deployment we trust. */
export function createUnavailableEnsResolver(): EnsResolver {
  return {
    async resolveName() {
      return undefined;
    },
    async lookupAddress() {
      return undefined;
    },
  };
}
