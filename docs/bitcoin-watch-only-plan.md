# Bitcoin, phase 1 — watch-only

Scope: derive a Bitcoin account from the phrase the wallet already holds, show
its balance, hand out a fresh receive address, and list its history. **No
signing, no spending, no PSBT.** Phase 2 (send) is a separate document and must
not start before this one is finished and vector-verified.

The point of doing watch-only first is that it needs no signing code and it
proves the one thing that is genuinely hard here: **discovery**. If address
discovery is wrong, every later phase is wrong in a way that costs money.

---

## What was measured, not assumed

All of the following was probed live before this plan was written.

**The Alchemy Bitcoin endpoint in `.env.local` cannot do discovery.**
`bitcoin-mainnet.g.alchemy.com` is a Bitcoin Core node RPC with `txindex` on.

| Answers | Rejected: `Unsupported method` |
|---|---|
| `sendrawtransaction` | `listunspent` |
| `getrawtransaction` (bare txid) | `getaddressinfo` |
| `gettxout` | `scantxoutset` |
| `estimatesmartfee` (563 sat/kvB at 6 blocks) | `scanblocks` |
| `getblock` / `getblockhash` / `getmempoolinfo` | `getdescriptorinfo` |

Every rejected method is an address index. The node can broadcast, price a fee,
and verify an outpoint we already name — it cannot tell us which coins an
address owns. Alchemy's Data/Portfolio API is EVM-only (it rejects a bech32
address as invalid), so there is no substitute on the key we already have.

**`bitcoin-signet`, `bitcoin-testnet4` and `bitcoin-testnet` are all live on the
same key.** All three answered `getblockchaininfo`.

**Blockbook's `xpub` endpoint is not a dependable public path.** The obvious
one-request answer to discovery is Blockbook's `/api/v2/xpub/<zpub>`, which does
the gap scan server-side. Trezor's public instance sits behind Cloudflare bot
protection and returns an interstitial, not JSON. Using it would mean
self-hosting Blockbook, which is a piece of infrastructure this project does not
have and does not want. **Rejected on availability, before privacy even comes
into it** — and the privacy cost is real too: an xpub hands over every address
the account will ever use, past and future, in one request.

**Esplora works, on every network we need.** `mempool.space` and
`blockstream.info` both answer `/api/address/<addr>` with `chain_stats` and
`mempool_stats`, send `access-control-allow-origin: *`, and expose
`/signet/api/` and `/testnet4/api/` paths. `/address/<addr>/utxo` also works
(phase 2's input, not this phase's).

`host_permissions` is already `["<all_urls>"]`, so **no manifest change is
needed.**

**Phase 1 makes no calls to the Alchemy Bitcoin endpoint at all.** Watch-only
runs entirely on Esplora, because discovery is the only thing it does and
discovery is the one thing that endpoint cannot answer. The key starts doing
real work in phase 2 — `gettxout` to verify every input before signing,
`estimatesmartfee` for the fee preview, `sendrawtransaction` to broadcast. It is
the right key to have added; it is simply not the key this phase exercises.

---

## Decisions

These follow the CLAUDE.md idiom: each looks like it could be simpler, and is
not.

### Bitcoin is NOT a chain in the existing registry

No synthetic `chainId`, no `ChainDefinition` entry, no row in `BUILT_IN_CHAINS`.

A `chainId` is what `wallet_switchEthereumChain`, `eth_chainId` and
`wallet_addEthereumChain` operate on. Giving Bitcoin one would put it inside
reach of methods any website can call — and there is no EIP-1193 for Bitcoin, so
there is nothing a site could correctly *do* with it. The only outcomes are a
dApp switching the wallet to a network it cannot transact on, or a site
proposing a "Bitcoin" whose indexer it controls.

Bitcoin therefore gets a **sibling namespace**: its own network type, its own
wire result types, its own methods, its own store. `ChainSummary.chainId: number`
stays exactly as it is.

This also satisfies ground rule 3 — delete `src/core/bitcoin/`,
`src/background/bitcoin*`, and the four `case` lines, and the EVM wallet is
untouched.

### No provider surface. Popup only.

`assertOriginMayUseAccount`, `eth_accounts` and `wallet_watchAsset` have no
Bitcoin analogue and get none. All new methods are `wallet.`-prefixed, which the
existing router already blocks for page senders and reports as
`unsupportedMethod` (4200), not `unauthorized` (4100) — the existing rule, for
the existing reason. The router keeps exactly one authorisation decision.

### Discovery is Esplora, per address, with a persisted index hint

The gap scan is ~40–50 HTTP requests for a typical account (receive + change,
each to a gap limit of 20). Three consequences, each handled:

1. **The scan window is sized by a persisted hint, not by guessing.**
   `wallet.bitcoinIndexHint.v1` stores, per (network, account, branch), the
   highest index ever observed *used*. On unlock we derive `hint + gapLimit`
   addresses per branch and fire the queries in parallel at a concurrency cap,
   instead of walking them one round trip at a time. If the scan finds a used
   address inside the top `gapLimit` of the window, it extends and repeats.

   **The hint is an optimisation; correctness comes from the gap rule alone.**
   A wiped or absent hint must produce an identical result, only slower. There
   is a test for this.

2. **The hint is a small integer, and the xpub is never persisted.** An xpub on
   disk is every address of the account, forever, in plaintext — a strictly
   worse disclosure than the outstanding-transaction store already documented in
   `docs/privacy-policy.md`. An integer reveals activity volume and nothing
   else. The account-level public node is derived on demand, held in worker
   memory, and dies with the worker like everything else — see the next
   decision for the call that produces it.

3. **The address set is cached in memory with a short TTL, and this diverges
   from the EVM rule on purpose.** `portfolioService.ts` reads balances live on
   every request and says why. That is free when a balance is one `eth_getBalance`;
   it is ~50 requests here, which would make the popup slow and would get the
   key rate-limited by ordinary use. So the *address set and its usedness* are
   cached per (network, account) for `BITCOIN_SCAN_TTL_MS`, and balances are
   recomputed from that set on each read. Memory only — it dies with the worker,
   same as the keyring.

### The account node comes from ONE new keyring call, and it is public-only

This is the decision most likely to be skipped, and skipping it dissolves the
central security invariant. `bitcoinService` needs an account-level HD node to
derive addresses from. The keyring's rule is that it holds the mnemonic, derives
what is needed at the moment it is needed, and hands out no secret material —
enforced today by `withAccountPrivateKey`, which derives, runs a callback, and
zeroizes. Built without a named call, someone reaches into
`getKeyring().sources[0].mnemonic` from a background service and the invariant
is gone, quietly, in a file nobody reviews again.

So `core/keyring/keyring.ts` gains exactly one function, alongside
`withAccountPrivateKey` and following its shape:

```ts
export function deriveBitcoinAccountPublicNode(params: {
  keyring: Keyring;
  accountIndex: number;
  network: BitcoinNetworkName;
}): HDKey;   // throws VaultLockedError when locked
```

Three properties it must have:

- **It returns a NEUTERED node.** The private material is derived inside, and
  the node handed back is reconstructed from its extended *public* key, so the
  caller cannot sign with it even by mistake. `branch` and `index` are
  non-hardened, so a public node derives every address the scan needs — this is
  not a compromise, it is exactly the right capability.
- **The seed is zeroized in a `finally`,** and the intermediate `HDKey` gets
  `wipePrivateData()`, matching `deriveAccountKeyFromSeed`.
- **It throws `VaultLockedError` when locked,** so the Bitcoin methods fail the
  same way every other privileged method does and the popup's existing
  `isSessionExpired` routing applies unchanged.

`bitcoinService` caches the returned node for the session and nothing else. A
cache holding an object that provably cannot sign is a cache with a much smaller
blast radius than one holding an xpub string that could be logged.

### BIP-84 only. Native segwit, `bc1q`.

One derivation scheme in phase 1: `m/84'/coin'/account'/branch/index`, P2WPKH.

BIP-86 taproot is deferred, not rejected — `@noble/curves` already carries the
Schnorr it needs. Legacy P2PKH is rejected outright: a P2PKH input needs the
full previous transaction to sign, where segwit needs only the single output
(`witness_utxo`), which is exactly what `gettxout` returns. Staying segwit-only
is what keeps the Alchemy node sufficient for phase 2 by construction rather
than by luck.

### The network is a parameter from the first line of derivation code

`coin_type` is `0'` on mainnet and `1'` on signet/testnet4/testnet, and the
address HRP is `bc` vs `tb`. Retrofitting that after the derivation code exists
is how you get valid-looking addresses on the wrong network — which in a wallet
means funds sent somewhere nobody holds a key. Every function in
`core/bitcoin/` takes the network; none reads a module-level default.

**Default network is signet**, mirroring `DEFAULT_CHAIN = ETHEREUM_SEPOLIA` and
for the same stated reason.

### One implementation of "what is this account's address"

Add `@scure/btc-signer` **pinned to 1.8.0**, and derive addresses through its
`p2wpkh` even though phase 1 never signs anything.

1.8.0 depends on `@noble/curves ~1.9.0` and `@noble/hashes ~1.8.0`, which the
existing pins (1.9.7 / 1.8.0) satisfy exactly. **2.x wants noble 2.x** and would
install a second copy of the curve library — two secp256k1 implementations in a
wallet bundle. Same authors as the already-pinned `@scure/bip32` / `@scure/bip39`,
pure JS, no WASM, so the constraint that chose scrypt over Argon2id is
respected.

Hand-rolling bech32 for phase 1 and switching to `btc-signer` for phase 2 would
mean two answers to "which address is this account's", and the failure mode is
watching a balance at an address the signer will not spend from.

### A failed indexer read fails the read. It never renders 0 BTC.

`portfolioService` can omit a token whose `balanceOf` failed, because the row
simply disappears. Bitcoin is a single number with nothing to omit, so it
follows the `readNativeBalance` rule instead: the read throws, and the UI keeps
the last good figure rather than replacing it with a zero. A wallet that renders
"0 BTC" because an indexer was slow has told the user their money is gone — the
same rule as `totalFiatValue` being `undefined` and never `0`.

A *partial* scan is the sharper case: if some address queries succeed and others
fail, the sum is an undercount that looks exactly like a real balance. **Any
failed address query fails the whole scan.** `Promise.allSettled` is the wrong
tool here for precisely the reason recorded in the CLAUDE.md trap table.

### The API never accepts an address

`wallet.getBitcoinPortfolio` takes an account index, never an address.

`activityMethods.ts` guards the EVM path by checking the requested address is in
`listWalletAddresses` — otherwise the wallet is a free history-lookup service
against the user's key and IP. For Bitcoin, "owned" is a *dynamic* set (whatever
is derivable within the gap limit), so that check would have to be reimplemented
and could drift. Not accepting an address at all makes the question unaskable.

---

## Module map

New, and nothing existing moves.

```
src/core/bitcoin/
  bitcoinNetwork.ts        network definitions; coin_type, HRP, explorer, indexer base
  derivationPath.ts        m/84'/coin'/account'/branch/index  (mirrors account/derivationPath.ts)
  bitcoinAccount.ts        HDKey -> account node -> address at (branch, index)
  addressScan.ts           THE GAP SCAN. Pure. Takes an AddressIndexReader.
  addressIndexReader.ts    the contract core/ declares (cf. balanceReader.ts)
  bitcoinAmount.ts         satoshi <-> display. bigint only, 8 decimals
  bitcoinActivity.ts       tx -> direction + net amount, given our address set

src/platform/indexer/
  esploraAddressReader.ts  the Esplora implementation of AddressIndexReader

src/background/
  bitcoinService.ts        account node (memory), scan cache, index-hint store
  bitcoinMethods.ts        the three wallet.* handlers

src/ui/popup/
  BitcoinCard.tsx          balance row on the portfolio
  BitcoinReceiveScreen.tsx fresh-address receive (NOT the EVM ReceiveScreen)
```

One existing file changes: `core/keyring/keyring.ts` gains
`deriveBitcoinAccountPublicNode` (see the decision above). Everything else is new.

`AddressIndexReader` is the inversion that keeps the scan hermetic — the same
shape as `BalanceReader` and `TransferReader`, injected the way `createClient`
and `createEnsResolver` already are in `NetworkServiceOptions`:

```ts
export interface AddressIndexReader {
  readAddressStats(params: {
    addresses: readonly string[];
    network: BitcoinNetworkName;
  }): Promise<Map<string, AddressStats>>;   // funded/spent sats, tx counts
  listAddressTransactions(params: {
    address: string;
    network: BitcoinNetworkName;
  }): Promise<BitcoinTransaction[]>;
}
```

---

## Wire surface

Three methods, all privileged-only by virtue of the `wallet.` prefix:

| Method | Returns |
|---|---|
| `wallet.getBitcoinPortfolio` | balance + fiat for one account index |
| `wallet.getBitcoinReceiveAddress` | the next unused receive address |
| `wallet.getBitcoinActivity` | merged, deduplicated history |

There is deliberately no `wallet.getBitcoinStatus`. Whether the feature is on,
and on which network, rides on `wallet.getStatus` as the facet below — a
separate status call would be a second round trip for something the popup
already asks for on every open, and two sources for one answer is how they drift.

New types in `walletApi.ts`, siblings to the existing ones, following every rule
already stated in that file's header:

```ts
export interface BitcoinNetworkSummary {
  network: "mainnet" | "signet" | "testnet4";
  name: string;
  isTestnet: boolean;
  explorerUrl: string;
}

export interface BitcoinPortfolioResult {
  accountIndex: number;
  network: BitcoinNetworkSummary;
  /** Satoshis, exact decimal string. Parse with BigInt(), never Number(). */
  confirmedSats: string;
  /** Signed: a pending spend makes this negative. */
  unconfirmedSats: string;
  totalSats: string;
  /** Pre-truncated, "<0.00000001" for a tiny non-zero balance. */
  balanceLabel: string;
  fiatValue: number | undefined;
  fiatStatus: "priced" | "unavailable";
  usedAddressCount: number;
  fetchedAt: number;
}
```

`fiatStatus` has no `"unpriced"` member: BTC is a built-in, it is always meant to
have a price, and an absent one is always an outage. The never-price rule is
about imported tokens and does not apply.

`BitcoinActivityResult` reuses `ActivityStatus` verbatim — `"ok"` /
`"unsupported_endpoint"` / `"unavailable"` already draws exactly the distinction
this feature needs, and the reason it exists (an empty array cannot say whether
you have no history or we have no index) is unchanged.

`WalletStatusResult` gains one optional facet:

```ts
  /** Undefined when the Bitcoin feature is disabled at build time. */
  bitcoin?: { network: BitcoinNetworkSummary; accountCount: number };
```

Optional so that the popup needs no second round trip to know whether to render
the card, and so that an absent key is a complete description of the feature
being off.

**`exactOptionalPropertyTypes` is on**, so this key cannot be *assigned*
`undefined` — it has to be omitted from the object entirely when the feature is
off. Build the result with a conditional spread, not `bitcoin: undefined`.
Otherwise this surfaces as a typecheck failure at step 4, several files away
from the line that caused it.

### Feature flag

`VITE_BITCOIN_INDEXER_URL` absent ⇒ feature off: the facet is `undefined`, the
four methods return `unsupportedMethod`, no UI renders. Ground rule 3, enforced
by the absence of a config value rather than by a boolean someone can half-set.

---

## The gap scan

`core/bitcoin/addressScan.ts`, pure, no network:

```
for each branch in [receive, change]:
    window := hint[branch] + GAP_LIMIT
    loop:
        derive addresses [0, window)
        read stats for all of them (batched, injected reader)
        used := indices where chain_stats.tx_count + mempool_stats.tx_count > 0
        if any used index >= window - GAP_LIMIT:
            window += GAP_LIMIT ; continue
        highestUsed := max(used, or -1)
        stop
balance := sum over ALL scanned addresses of
             (chain_stats.funded - chain_stats.spent)
           + (mempool_stats.funded - mempool_stats.spent)
```

`GAP_LIMIT = 20` (BIP-44). Amounts are satoshis as `bigint` throughout — the
Esplora fields are JSON numbers and a balance above 2^53 satoshis is not
reachable in practice, but the rule in this codebase is that no `Number()`
touches an amount, and the *sum* is the value the user reads. Parse each field
through `BigInt()` at the boundary in `esploraAddressReader.ts`, and never let a
double into the accumulator. This is the same trap as
`alchemyTransferReader`'s `value` vs `rawContract.value`, in a different costume.

---

## Receive, and the copy that has to change

**This is the largest UI divergence in the phase, and it contradicts a comment
that is currently correct.**

`ReceiveScreen.tsx` is built on "THE ADDRESS IS THE RECORD; THE QR IS A
CONVENIENCE" — the full checksummed address is always rendered as selectable
text so a hand-rolled QR encoder is safe to ship. That reasoning survives.

What does not survive is the assumption underneath it: that an account has *an*
address. Bitcoin address reuse is a genuine privacy harm — reusing an address
publishes the link between every payment made to it — where Ethereum reuse is
the norm. So the Bitcoin receive screen shows the **next unused** receive
address, and the record changes each time.

Concretely:
- `wallet.getBitcoinReceiveAddress` returns `highestUsedReceiveIndex + 1`.
- The screen says, in words, that a new address appears each time and that older
  ones keep working. Without that sentence a user who screenshots an address and
  comes back to a different one will conclude the wallet is broken — or worse,
  that the first one was wrong.
- bech32 is case-insensitive and canonically lowercase, so there is no
  checksummed-vs-lowercase split to police the way `eth_accounts` needs. The
  bech32 checksum does the work EIP-55 does.
- **The network warning gets stronger, not weaker.** Sending BTC to a `tb1`
  signet address, or ETH to a `bc1` address, is unrecoverable. Signet says so in
  plain words, exactly as the EVM screen already does for testnets.

A separate `BitcoinReceiveScreen.tsx` rather than a widened `ReceiveScreen`: the
two screens now make different promises about what an address *is*, and one
component making both is how the wrong promise ends up on the wrong screen.

---

## Activity

Esplora gives `/address/<addr>/txs` — up to 50 per address, newest first. The
merge is genuinely more work than the EVM path's two calls:

1. Query only the **used** addresses from the scan (usually a handful).
2. Merge and deduplicate by txid — one transaction touching several of our
   addresses must be one row, not several. `mergeActivity` in
   `transactionHistory.ts` already deduplicates on a stable id; the id here is
   the txid, since a Bitcoin transaction is one movement of value from the
   owner's point of view.
3. Classify against our address set:
   - any of our addresses in the inputs ⇒ `sent`
   - only in the outputs ⇒ `received`
   - both, and the net is roughly the fee ⇒ `self`
4. Net amount = `sum(our outputs) − sum(our inputs)`. **Not the raw output
   value** — a 1 BTC input producing a 0.1 BTC payment and 0.9 BTC of change is
   a 0.1 BTC send, and showing 0.9 or 1.0 would be a wallet misreporting what
   the user spent.

This classification is pure and lives in `core/bitcoin/bitcoinActivity.ts`. It
is the part most likely to be subtly wrong, and it is entirely testable from
fixtures.

The existing `ActivityEntry` type is EVM-shaped (`blockNumber: bigint`,
`chainId: number`, `tokenAddress`). Phase 1 uses a sibling `BitcoinActivityEntry`
rather than widening it — the same reasoning as not widening `ChainSummary`.

---

## Pricing

One line: add `BTC: "bitcoin"` to `COIN_GECKO_IDS` in
`platform/price/coinGeckoPriceReader.ts`.

BTC is a built-in symbol, so the fixed-symbol-list privacy rule holds unchanged:
the outbound request looks identical whether or not the user holds any. The
hardcoded symbol→id table stays hardcoded, for the reason its header already
gives.

**BTC does not join the EVM hero total in phase 1.** `PortfolioResult` is
per-chain, per-address, and merging two networks' fiat into one hero figure
means deciding what the hero shows when one of the two is unpriced or
unreachable — a `PortfolioChange` problem, not a layout problem. Phase 1 gives
Bitcoin its own card with its own subtotal. Merging is a deliberate follow-up,
noted here so it reads as deferred rather than forgotten.

---

## Tests

Hermetic, no network, no `chrome.*` — the existing standard.

**Known-answer vectors.** BIP-84's published test vectors use the *same*
`abandon … about` phrase already in `routerHarness.ts` as `TEST_PHRASE`.
Transcribed from the BIP-84 "Test vectors" section
(`bitcoin/bips/bip-0084.mediawiki`) and checked against it, not from memory:

```
m/84'/0'/0'     xpub  zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs
m/84'/0'/0'/0/0 ->    bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
m/84'/0'/0'/0/1 ->    bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g
m/84'/0'/0'/1/0 ->    bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el
```

The test file must cite that document by name, the way the QR tests cite the
ISO/IEC 18004 tables — a vector with no stated source is a snapshot wearing a
vector's clothes, and it would pass against whatever our code happens to
produce. The first receive address is independently confirmable: it is a live,
heavily-used mainnet address (176 transactions at the time of writing), so a
block explorer is a second witness to at least that row.

Assert the account `xpub` too, not only the addresses. A wrong `coin_type` or a
wrong hardening depth can still produce well-formed addresses; it cannot produce
the right extended key.

That is the Bitcoin counterpart of the `0x9858EfFD…` cross-wallet vector, and it
carries the same weight: if it breaks, a phrase created here does not restore
elsewhere. Signet/testnet vectors under `m/84'/1'/0'/…` cover the coin_type
branch, which is the one a network-parameter bug hits first.

**The gap scan, from fixtures.** These are the cases that matter:
- a wallet with no history stops after `GAP_LIMIT` and reports zero
- a balance at index 19 behind 19 unused addresses is **found**
- a balance at index 21 behind 21 unused addresses is **not** found (that is the
  gap limit working, not a bug)
- a used *change* address beyond the highest used *receive* address is found —
  the branches are scanned independently
- a wiped hint produces a byte-identical result to a warm one
- one failed address query fails the whole scan; it never returns a partial sum
- balances sum as `bigint`, and a fixture above 2^53 satoshis proves no double
  crept into the accumulator

**Activity classification, from fixtures.** Send-with-change nets to the payment
amount, not the input or the change. Self-transfer nets to the fee. A
transaction touching three of our addresses is one row.

**Router-level.** Extend `routerHarness.ts` with a fake `AddressIndexReader`,
the way the fake `PublicClient` already backs the EVM path. Then assert the
things only the router can answer: a page sender gets `unsupportedMethod` for
all three methods; the methods require an unlocked wallet; with
`VITE_BITCOIN_INDEXER_URL` unset the facet is absent from `wallet.getStatus` and
the methods are unsupported.

**A note on the harness clock.** `bitcoinService`'s scan TTL takes `now` from
the harness, for the reason already in the trap table: a store left on
`Date.now` against the harness's fixed 2023 timestamp makes every cache entry
permanently fresh, and the tests pass by never exercising the code.

**Live check goes in `npm run smoke`,** never in `npm test`. One signet address
scan against the real Esplora, to catch the day the response shape changes.

---

## Build order

Each step lands green, and step 4 is a demoable milestone.

1. **`@scure/btc-signer@1.8.0`.** Confirm with `npm run build` that the popup
   chunk does not grow — `bitcoinService` lives in the worker, and the popup is
   a thin client. The `passwordPolicy.ts` split is the precedent for what to do
   if it does.
2. **`core/bitcoin/`: networks, derivation path, address derivation — plus
   `deriveBitcoinAccountPublicNode` in `keyring.ts`.** Nothing else. Land the
   BIP-84 known-answer vectors here; if these are wrong, everything after is
   wrong. The keyring call belongs in this step precisely because it is the one
   thing a later step would otherwise improvise.
3. **`addressScan.ts` + `AddressIndexReader` + the fixture suite.** Still no
   network, still no service. This is the hard part and it is fully testable
   before anything can call it.
4. **`esploraAddressReader.ts` + `bitcoinService.ts` + `getBitcoinPortfolio` +
   the `bitcoin` facet on `wallet.getStatus` + `BitcoinCard.tsx`.** First
   milestone: a real signet balance in the popup.
5. **`getBitcoinReceiveAddress` + `BitcoinReceiveScreen.tsx`,** including the
   rewritten address-rotation copy.
6. **`bitcoinActivity.ts` + `getBitcoinActivity` + the activity list.**
7. **`BTC: "bitcoin"`** in the CoinGecko table, and the fiat figure on the card.
8. **Docs.** A `docs/privacy-policy.md` paragraph naming the indexer as a third
   party that learns the user's addresses and IP — it is a new outbound
   recipient and the policy currently does not mention one. Plus the CLAUDE.md
   decisions above, in that file's idiom.

---

## Explicitly out of scope

- **Signing, PSBT, coin selection, fee estimation, broadcast.** Phase 2.
- **RBF / speed-up / cancel.** `stuckTransaction.ts` and `computeReplacementFees`
  are nonce-pinning by construction and do not port; Bitcoin bumps are BIP-125,
  and cancel-by-self-transfer does not exist. Phase 2, as a parallel
  implementation, with its own copy.
- **Taproot (BIP-86).** Deferred, and cheap to add later because the network and
  branch parameters are already threaded through.
- **Legacy P2PKH.** Rejected — see the decisions above.
- **Importing a watch-only xpub.** A different feature with a different threat
  model; this phase watches an account the wallet's own phrase derives.
- **Merging BTC into the EVM hero total.** Deferred, deliberately.
- **Any dApp-facing Bitcoin method.** Not deferred — rejected.

---

## Open question for the user

**Which Esplora host ships as the default?** `mempool.space` and
`blockstream.info` both answered identically and both send permissive CORS.
mempool.space publishes rate limits and sells keyed access; blockstream.info is
quieter about both. Whichever is chosen becomes a third party that learns the
user's addresses and IP on every popup open, so it belongs in
`docs/privacy-policy.md` by name — and it is the one choice in this plan I would
rather you make than assume.
