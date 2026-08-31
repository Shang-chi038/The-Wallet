# Wallet — non-custodial Ethereum wallet, with watch-only Bitcoin (Chromium MV3)

EOA-only, non-custodial. Private keys and seed material never leave the device
and are never transmitted anywhere. There is no account to sign up for, no
server to trust, and nothing to recover if you lose your recovery phrase — the
wallet is yours in the sense that nobody else has a copy.

Bitcoin is **watch-only**. Addresses come from the same recovery phrase (BIP-84,
Native SegWit) and balances and history are read from an Esplora indexer, but
this wallet cannot spend BTC — the Bitcoin account node is reconstructed from
its public extended key, so the path is structurally unable to sign.

Privacy policy: `docs/privacy-policy.md` — what leaves the device, to whom, and
what is written to disk.

## How to set up for Chromium browsers

Chrome, Brave, Edge and Arc. There is no store listing yet, so the extension is
installed unpacked from a build you produce yourself — which also means you can
read every line of what you are about to give an unlocked wallet to.

### Before you start

- **Node.js 20 or newer** (`node --version`). The build will refuse older.
- A Chromium browser. Firefox is not supported.

### 1. Build the extension

```
git clone https://github.com/Shang-chi038/Wallet
cd Wallet
npm install
cp .env.example .env.local   # then open it and fill in the keys
npm run build
```

`.env.local` holds **build-time public config, not secrets.** There is no
backend, so every value in it is compiled into the bundle and is extractable by
anyone who unzips the extension. The API keys there are rate-limit identifiers,
not credentials — restrict them by origin in each provider's dashboard. The file
documents every variable and what a wrong value does. Never put a password, a
recovery phrase or a private key in it.

The build writes `dist/`, and finishes by verifying the manifest it just
produced, so a broken artifact fails the build rather than reaching your
browser.

### 2. Open the extensions page

Open a new tab and go to `chrome://extensions` — `brave://extensions` on Brave,
`edge://extensions` on Edge.

![A new browser tab, ready for the extensions URL](<tutorial/new_tab.png>)

You can also get there without typing: the puzzle-piece icon in the toolbar
opens the extensions menu, and **Manage extensions** at the bottom of it lands
on the same page.

![The extensions puzzle-piece icon in the browser toolbar](<tutorial/extensions_icon.png>)

### 3. Turn on Developer mode

The toggle is in the top-right corner of the extensions page. Unpacked
extensions cannot be loaded without it.

![The Developer mode toggle, switched on](<tutorial/developer_mode.png>)

### 4. Load unpacked

Developer mode reveals a row of buttons at the top-left. Click **Load
unpacked** and select the `dist/` folder inside the project — the folder
itself, not a file inside it.

![The Load unpacked, Pack extension and Update buttons](<tutorial/unpacking_extension.png>)

The wallet appears in the list and opens its onboarding tab. Pin it from the
puzzle-piece menu so it sits in the toolbar where you can reach it.

![The installed Wallet extension card, with its version, ID and service worker](<tutorial/wallet_extension.png>)

That card is worth knowing. The **reload** icon on it is how you pick up a
rebuild; **Inspect views: service worker** opens devtools on the wallet's
engine, which is where its logs go; and the toggle beside them disables the
extension without uninstalling it, leaving your vault where it is.

### 5. Create or restore

Onboarding runs in a full tab rather than the popup, because a popup closes if
you click away and losing a recovery phrase halfway through while writing it down is
not a recoverable mistake.

- **Create** generates a 12- or 24-word BIP-39 phrase, shows it once, and then
  asks you to put a few words back in order before it will continue.
- **Restore** takes a phrase you already have, with an optional BIP-39
  passphrase.

Your password encrypts the vault on this device. It is not a login, nothing
transmits it, and nobody can reset it — if you forget it, the recovery phrase is
the only way back in.

### Rebuilding later

Run `npm run build` again and press the reload icon on the wallet's card in
`chrome://extensions`. Your vault, accounts and settings survive a reload; they
live in browser storage, not in `dist/`.

## Features

**Accounts from one phrase.** A 12- or 24-word BIP-39 recovery phrase, with an
optional passphrase, deriving as many Ethereum accounts as you want. A private
key you already hold can be imported alongside them, and is labelled clearly as
not recoverable from the phrase, because the two kinds of account fail
differently and the moment to learn that is not after a reinstall.

**A portfolio that admits what it does not know.** Native and ERC-20 balances,
fiat values where a price exists, and a 24-hour change that is value-weighted
rather than an average of percentages. A price feed that times out produces no
number rather than `$0.00` — a wallet that renders zero because an API failed
has told you your money is gone. Holdings under 1% collapse into an expandable
**Other** row so the list stays readable without hiding anything permanently.

**Send, to an address or an ENS name.** Fee levels with the expected and maximum
cost shown separately, send-max that accounts for the fee, and an affordability
check before you ever reach a confirmation screen. Names are resolved through
ENSIP-15 normalisation, and a reverse-resolved name is verified forward before
it is shown.

**Receive.** A QR code and the checksummed address, with a separate screen for
Bitcoin that names which account the address belongs to.

**Activity.** Ethereum history merged from an indexer with transactions this
wallet has broadcast, pending ones first, deduplicated. An empty list always
says why it is empty — "nothing yet" and "the request failed" are different
facts and the screen never conflates them.

**Speed up or cancel a stuck transaction.** After ninety seconds, an unconfirmed
transaction offers both. A replacement reuses the original's nonce and outbids
two floors — the node's relative threshold and the current market — because
clearing only one produces a button that appears to do nothing. The copy is
honest that a cancel is a self-transfer at the same nonce, that the fee is
payable either way, and that the original can still win.

**dApp connections that you can see and revoke.** EIP-1193 and EIP-6963, so
sites discover the wallet properly. Grants are per-origin and hold a subset of
your accounts, not all of them, and Settings lists every connected site with a
revoke button.

**Approvals that explain themselves.** Calldata is decoded into an intent where
it can be, and where it cannot the screen says *blind signing* rather than
guessing — rendering an unknown call as an ordinary transfer is how people
approve drainers. Unlimited token approvals are flagged, including in typed-data
signatures, where an EIP-2612 permit would otherwise be five true, unannotated
rows that hand a stranger your balance with no transaction and nothing in
Activity.

**A warning when a site looks like another one.** Three signals under the origin
on every approval: an encoded (`xn--`) hostname, a near-copy of a domain you
have already connected, and a bundled phishing list. It warns and never blocks,
because a false positive that blocks lands on someone moving their own money.

**Token import.** Paste a contract address and the wallet reads the symbol, name
and decimals from the chain, shows you what the contract claims, and re-reads
before saving. Imported tokens are never assigned a fiat price — anyone can
deploy a contract calling itself USDC, and pricing it would render a worthless
balance as a large number in the largest type on the screen.

**Networks.** Ethereum and Sepolia today. Bitcoin runs alongside, watch-only,
across mainnet, signet and testnet4, with its own picker whose choice is
remembered.

**Settings.** Reveal your recovery phrase behind a freshly typed password,
change that password, review and revoke connected sites, import an account, add
or remove tokens, choose an auto-lock interval, and reset the wallet behind a
typed confirmation.

**Locked by default, and locked often.** The wallet locks on an idle timer you
choose, and again whenever the browser shuts the extension's worker down —
which it does aggressively. That teardown is treated as a feature rather than
worked around: it is the only way to actually erase a key from memory, since
JavaScript cannot erase a string from the heap.

## Architecture

```
src/
├── core/                  Pure, platform-agnostic. No chrome.* APIs anywhere.
│   │                      This is the entire security-critical surface and it
│   │                      is 100% unit-testable in plain Node.
│   ├── crypto/
│   │   ├── randomSource.ts        Single CSPRNG entry point (audit one site)
│   │   ├── secretBytes.ts         Zeroization + scoped-secret helper
│   │   ├── keyDerivation.ts       scrypt / Argon2id, params versioned per vault
│   │   ├── authenticatedCipher.ts AES-256-GCM via WebCrypto
│   │   └── encoding.ts            base64url / hex / constant-time compare
│   ├── mnemonic/
│   │   ├── mnemonicPhrase.ts      BIP-39 (@scure), 12/24 words, passphrase
│   │   └── backupVerification.ts  Word-order challenge, unbiased sampling
│   ├── account/
│   │   ├── derivationPath.ts      BIP-44 m/44'/60'/0'/0/i
│   │   ├── ethereumAddress.ts     EIP-55 checksum, key validation
│   │   └── hierarchicalDeterministicKey.ts  BIP-32 (@scure)
│   ├── vault/
│   │   ├── vaultRecord.ts         On-disk format + AAD serialization
│   │   ├── vaultCipher.ts         seal / open / unseal / changePassword
│   │   ├── vaultStorage.ts        Persistence contract (impl lives in platform)
│   │   └── vaultErrors.ts         Typed error taxonomy with stable codes
│   ├── keyring/keyring.ts         Unlocked in-memory state; scoped key lending
│   ├── wallet/
│   │   ├── walletService.ts       The engine: create/unlock/lock/add/reveal
│   │   └── passwordPolicy.ts      No imports, so the popup can state the rule
│   ├── network/
│   │   ├── chain.ts               Chain registry + impersonation guards
│   │   └── rpcAvailability.ts     "The endpoint did not answer", told apart
│   ├── token/
│   │   ├── tokenAmount.ts         bigint fixed-point; no float, ever
│   │   ├── tokenRegistry.ts       USDC/USDT by address, USDT quirks
│   │   ├── customToken.ts         Imported ERC-20s: every field is a CLAIM
│   │   ├── tokenMetadataReader.ts Read-once metadata contract, not a balance
│   │   └── fiatDisplay.ts         Hero abbreviation, non-colour signals
│   ├── balance/balanceReader.ts   Balance contract + portfolio ordering
│   ├── portfolio/heroPresentation.ts  Zero, unpriced and unreachable are three
│   ├── signing/
│   │   ├── signature.ts           ECDSA: low-s + RFC-6979 invariants
│   │   ├── messageSigning.ts      EIP-191 personal_sign
│   │   ├── typedDataSigning.ts    EIP-712 + cross-chain replay guard
│   │   ├── transactionSigning.ts  EIP-1559 + EIP-155 replay guard
│   │   └── signingService.ts      The ONLY signing entry point
│   ├── transaction/
│   │   ├── calldataDecoder.ts     Clear signing: intent + warnings
│   │   ├── feeEstimate.ts         EIP-1559 levels, ceiling, gas fallbacks
│   │   ├── nonceAllocator.ts      Collision + gap prevention; replacement bump
│   │   ├── stuckTransaction.ts    When to offer a replacement, and what it is
│   │   └── transactionBuilder.ts  Assembly, affordability, send-max
│   ├── bitcoin/                   Watch-only. Nothing here can sign.
│   │   ├── derivationPath.ts      BIP-84 m/84'/coin'/account'/branch/i
│   │   ├── bitcoinNetwork.ts      mainnet / signet / testnet4; HRP + coin type
│   │   ├── bitcoinAccount.ts      P2WPKH addresses from a NEUTERED node
│   │   ├── bitcoinAmount.ts       bigint satoshis; no Number(), same as ETH
│   │   ├── addressIndexReader.ts  Indexer contract, kept out of the logic
│   │   ├── addressScan.ts         BIP-44 gap scan, limit 20, all-or-nothing
│   │   └── bitcoinActivity.ts     Dedupe by txid; sent / received / self
│   ├── messaging/
│   │   ├── protocol.ts            Privileged vs page allowlists — the choke point
│   │   ├── senderTrust.ts         Classify a chrome sender; opaque-origin traps
│   │   ├── originPermissions.ts   Per-origin grants holding an account SUBSET
│   │   ├── requestParams.ts       Total parsers for hostile dApp params
│   │   └── walletApi.ts           Wire contract; amounts cross as exact strings
│   ├── approval/approvalRequest.ts  Presentation vs payload split; typed-data warnings
│   ├── security/
│   │   ├── originRisk.ts          Lookalike / encoded / listed. Warns, never blocks
│   │   ├── originRiskDescription.ts  The sentence only — split by AUDIENCE
│   │   └── phishingHosts.ts       Bundled list, never fetched at runtime
│   ├── price/priceReader.ts       Fiat is decoration; "no price" is not zero
│   ├── activity/
│   │   ├── transactionHistory.ts  Merge, dedupe, classify; pending first
│   │   └── activityPresentation.ts  An empty list is ambiguous; never shown bare
│   ├── ens/{ensName,ensResolver}.ts    ENSIP-15 refusal; forward-verified reverse
│   └── qr/{galoisField,qrCode}.ts      Self-contained QR: byte mode, level M
├── platform/              chrome.* and network adapters behind interfaces
│   ├── storage/chromeStorage.ts
│   ├── price/coinGeckoPriceReader.ts
│   ├── indexer/
│   │   ├── alchemyTransferReader.ts   alchemy_getAssetTransfers (EVM history)
│   │   ├── esploraAddressReader.ts    Bitcoin: deadlines, bounded retry
│   │   └── indexerOverrides.ts        One Esplora host per network; refuses three
│   ├── ens/viemEnsResolver.ts     Universal resolver, address from OUR registry
│   └── rpc/{rpcClient,viemBalanceReader,viemNetworkReader,viemTokenMetadataReader}.ts
├── background/            Service worker: the wallet engine
│   ├── serviceWorker.ts         Wiring only. Owns the keyring; nothing else may.
│   ├── lockPolicy.ts            chrome.alarms auto-lock, SW-lifecycle policy
│   ├── messageRouter.ts         ONE entry point, ONE authorisation decision
│   ├── walletMethods.ts         Privileged handlers (popup / onboarding / approval)
│   ├── providerMethods.ts       EIP-1193 handlers: parse, authorise, resolve, approve
│   ├── routerContext.ts         Injected singletons + the auth helpers
│   ├── approvalService.ts       The queue. Every request settles, always.
│   ├── approvalWindow.ts        chrome.windows adapter for the prompt
│   ├── providerEvents.ts        Per-origin accountsChanged / chainChanged
│   ├── networkService.ts        Active chain, custom chains, client + ENS cache
│   ├── portfolioService.ts      Balances + prices, degrading independently
│   ├── tokenService.ts          Built-in plus imported tokens
│   ├── tokenMethods.ts          lookup / import / list / remove; the re-read
│   ├── transactionPreparation.ts  THE ONE assembly path, shared by both callers
│   ├── sendMethods.ts           prepare / submit / cancel, recipient resolution
│   ├── activityMethods.ts       History merge; an empty list carries its reason
│   ├── preparedTransactionStore.ts  Reviewed-but-unconfirmed; releases nonces
│   ├── pendingTransactionLog.ts     Broadcast but not yet indexed (memory)
│   ├── outstandingTransactionStore.ts  Broadcast, unconfirmed, PERSISTED
│   ├── replacementMethods.ts    Speed up / cancel; pins the nonce
│   ├── bitcoinService.ts        Scan, price, classify; 60s result TTL
│   ├── bitcoinMethods.ts        The four wallet.*Bitcoin* handlers
│   ├── bitcoinNetworkStore.ts   The picked network, PERSISTED (a field reverts)
│   ├── bitcoinIndexHintStore.ts Highest used index, so a rescan starts warm
│   ├── lockSettingsStore.ts     Auto-lock interval; re-arms the alarm on write
│   ├── originPermissionStore.ts Persisted grants
│   ├── selectedAccountStore.ts  Which account the UI shows
│   └── chromeMessageBridge.ts   onMessage wiring; `return true` is load-bearing
├── content/contentScript.ts   ISOLATED world bridge. Holds no secrets.
├── inpage/provider.ts         MAIN world EIP-1193 + EIP-6963. Transport only.
└── ui/                    Thin clients — all traffic goes through shared/walletClient
    ├── onboarding/        Full tab: create / restore / backup / verify
    ├── popup/             Unlock, portfolio, send, receive, activity, settings,
    │                      switchers, stuck-transaction notice, Bitcoin card
    ├── approval/          The window a dApp request opens
    └── components/        Display + form primitives, tokens only
```

**Message flow.** A dApp calls `window.ethereum.request` in the MAIN world. The
provider posts to the page, the ISOLATED-world content script validates the
shape and stamps the true origin, and the service worker classifies the sender
from Chrome's own fields before `isMethodAllowedForSender` decides anything.
Requests that need consent are queued in `approvalService`, shown in a
`chrome.windows` popup, and resolved back through the same path.

**One transaction builder.** `transactionPreparation.ts` assembles every
transaction this wallet signs, whether a website asked for it or the user filled
in the send form. Fee, gas, nonce and affordability are resolved before any
consent surface appears, and the object the user sees is the object that gets
signed — retrieved by id, never rebuilt. Two builders for one transaction is how
a preview and a payload drift apart.

**No request may hang.** The queue settles every request — approved, declined,
window closed, timed out, wallet locked. The one case it cannot cover is Chrome
terminating the worker mid-request, because the queue dies with it; that case is
caught at the content script, which treats a closed message port as a rejection.
The guarantee is enforced at both ends because only one of them survives worker
teardown.

**Trust model.** The service worker is the only component that ever holds
secrets. The popup, content script and injected provider are untrusted clients
that request operations over a message port and receive results — never key
material. Page-originated messages are never treated as authenticated; the
content script stamps the true origin, which is what every approval prompt is
anchored to.

## Design system

Adopted from the `screens_6.html` spec: Playfair Display for figures and
headings, Inter for everything else, full light/dark token sets, and the asset
identity palette (used only for avatars, the proportion bar and chart lines —
never for buttons, labels or body text).

Rules carried over and enforced in code:

- **Colour is never the only signal.** Direction is carried by an arrow and an
  explicit sign as well as by colour. Asset lettermarks are curated rather than
  derived from the first character, because USDC and USDT both start with "U"
  and a naive `charAt(0)` would leave colour as the sole differentiator.
- **The hero value abbreviates rather than shrinks.** ₦438,909,466 becomes
  ₦438.9M. Shrinking type to fit makes the one number the user opened the wallet
  for unreadable.
- **Network label:** name the chain when an asset sits on exactly one, show a
  count otherwise. Suppressed entirely when it merely repeats the asset name.
- **Sub-1% holdings collapse into Other**, assets sorted by value — but only
  when every non-imported holding is priced, never for imported tokens (unpriced
  by design, so a fiat comparison reads them as worthless), and never for a
  single asset. The row expands: a wallet that permanently hides a holding has
  decided for the user what their money is worth looking at.
- **Fonts are self-hosted**, never fetched from Google Fonts — a remote font
  request would tell a third party every time the user opens their wallet. The
  default `@fontsource` entrypoints ship 7 subsets (50 files, 848K); `latin-*`
  cuts it to 8 files, 220K.

Layout ordering follows Rainbow: identity and network at top, then the balance,
then the actions that operate on it, then holdings. Nav is Portfolio · Add ·
Activity with Settings as a header icon, per the spec.
