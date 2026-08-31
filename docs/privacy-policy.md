# Privacy policy

**Last updated: 24 August 2026**

This extension is a non-custodial Ethereum wallet. It runs entirely in your
browser. There is no account, no sign-up, and no server belonging to this
project — which means there is nowhere for us to collect anything, and nothing
for us to hand over.

This document says exactly what stays on your machine, what leaves it, and who
sees it. It is written to be checked against the source rather than taken on
trust; file names are given so you can go and look.

---

## What never leaves your device

**Your recovery phrase and your private keys.** They are generated on your
machine, encrypted with a key derived from your password, and stored in your
browser's extension storage. They are never transmitted anywhere, by any code
path, under any circumstance. There is no "backup to cloud" feature and no
recovery service, and that is not an oversight: it is what non-custodial means.

**Your password.** It is never stored — not encrypted, not hashed, not in
memory between sessions. It is used to derive an encryption key and then
discarded. Nobody, including us, can unlock your wallet or recover it for you.

## What we collect

Nothing. There is no analytics, no telemetry, no crash reporting, no
advertising identifier, and no unique install id. The extension makes no
requests to any server operated by this project, because no such server exists.

---

## What leaves your device, and to whom

A wallet cannot show you your balance without asking a blockchain node, and it
cannot broadcast a transaction without sending it somewhere. Those requests go
to third parties, and this is what each one sees.

### Blockchain RPC — Alchemy

**What is sent:** your account addresses (when reading balances), and the
signed transaction (when you send one).
**What they can infer:** that a given IP address holds a given set of Ethereum
addresses, and when it is active.
**Their policy:** <https://www.alchemy.com/policies/privacy-policy>

This is unavoidable for any wallet that shows live balances, and it is true of
every mainstream wallet. We are not claiming otherwise.

### Transaction history — Alchemy

**What is sent:** one account address at a time, to list transfers to and from
it.
**What they can infer:** your entire transaction history for that address.

There is no blockchain method for "what has this address done", so history
requires an indexer. If you would rather not have one, the Activity tab is the
only feature you lose.

### Prices — CoinGecko

**What is sent:** a fixed list of asset symbols, the same list on every
request, plus your IP address.
**What is deliberately NOT sent:** which of those assets you actually hold. The
list is fixed precisely so that the request does not describe your portfolio.
**Their policy:** <https://www.coingecko.com/en/privacy>

Tokens you add yourself are never sent to the price feed and are never priced —
partly for this reason, and partly because a price looked up by symbol is how a
wallet ends up valuing a scam token as if it were the real one.

### Block explorers

Only when you click a link. That opens etherscan.io (or the explorer for the
network you are on) in a normal browser tab, and from that point it is an
ordinary web page visit.

### Fonts and other assets

None. Every font is bundled in the extension rather than fetched from Google
Fonts, so opening your wallet does not tell a third party that you opened your
wallet.

---

## What is stored on your device

All of it in your browser's extension storage, readable by anyone who can read
your browser profile.

| Stored | Contains |
|---|---|
| `wallet.vault.v1` | Your **encrypted** recovery phrase and keys. Useless without your password. |
| `wallet.originPermissions.v1` | Which websites you have connected, and to which accounts. |
| `wallet.selectedAccount.v1` | Which of your accounts is currently selected. |
| `wallet.customTokens.v1` | Tokens you added, by contract address. |
| `wallet.activeChain.v1`, `wallet.customChains.v1` | The network you are on, and any added by a site you approved. |
| `wallet.lockSettings.v1` | Your auto-lock interval. |
| `wallet.outstandingTransactions.v1` | Transactions you have sent that have not yet confirmed — including recipient and amount. |

That last one is the only place this wallet writes transaction details to disk,
and it is worth being specific about. It exists so that a transaction stuck for
hours can still be sped up or cancelled after the browser has shut the
extension down — which needs the original fees, and no blockchain node will give
them back. Each record is deleted as soon as the network moves past it, and
anything left over expires within a day.

Your transaction history is **not** stored. It is fetched when you open the
Activity tab and kept only in memory.

---

## Permissions this extension requests

- **Access to all websites.** A wallet has to be available on any site that
  asks for one, so a small script is injected everywhere to answer that
  question. It reads nothing from the page and sends nothing anywhere; it
  exists so a site can ask to connect, and so the site's address can be shown
  to you in the approval prompt. Until you approve a connection, a site cannot
  learn your address or that you have a wallet at all.
- **Storage.** For the table above.
- **Alarms.** For auto-lock, which must survive the browser shutting the
  extension down.

---

## Children

This extension is not directed at children and does not knowingly collect
information from anyone, of any age.

## Changes

Any change to this document ships as part of an extension update and is
recorded in the project's version history.

## Contact

This is an open-source project. Questions and issues belong in the project
repository.
