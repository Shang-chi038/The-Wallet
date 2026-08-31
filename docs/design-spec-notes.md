# Design spec — notes

**Source of truth is `screens_6.html` in the repo root.** It was briefly lost and
has been recovered intact (769 lines, 59,117 bytes). Open it in a browser; it has
a light/dark toggle and renders all 21 screens.

This file holds only the analysis that is *not* in that document.

## Scope mismatch, and what it means for us

The spec targets a **Flutter mobile portfolio tracker** — watch-only,
multi-wallet, multi-chain (Tron/BSC/Polygon), Lottie onboarding, `ThemeData`
tokens, `FittedBox`/`auto_size_text`. This project is a Chromium MV3 **signing
extension**.

The design language ports cleanly and has been adopted wholesale (tokens, type,
asset palette, and the rules listed in the README).

**The screen set does not cover:** send, receive, transaction approval, dApp
connection request, or seed-backup verification. All five are mandatory for a
signing wallet, and none exist in the 21 screens. Those need designing before
phase 5/6 can finish.

## Where our popup currently diverges from screen 05

Our `PortfolioScreen` was built while `screens_6.html` was unavailable, using
only the tokens and implementation notes. Now that the markup is readable, these
are the differences — some deliberate, some accidental.

### Corrected (markup was the authority)

| | Spec | Was |
|---|---|---|
| Asset avatars | Currency glyphs ₿ ₮ $ Ξ, per-glyph font sizes | Curated letters B/T/C/E |
| Hero cents | `$285,934` ink + `.18` faint | Whole figure one colour |

The glyph approach is better than the lettermark workaround: it solves the
USDC/USDT "both start with U" collision natively, and carries more information.
Tokens without a currency glyph (TRX, DAI) fall back to a letter, which the spec
also does.

### Deliberate divergence — layout ordering

You asked for Rainbow's layout, so the header is an account pill + network pill +
settings icon, with Send/Receive/Buy actions directly under the balance. The spec
instead has a `WalletNest` brand + help icon, a "Total value" label, and a
currency selector, with no action row (it is watch-only, so it has nothing to
act with).

### Not yet built, present in screen 05

- `Total value` label and currency-selector pill above the hero
- Freshness indicator (`just now`) beside the 24h delta
- ~~`Other · TRX · DAI` collapsed row with a dashed `+2` chip — the sub-1%
  bucket.~~ BUILT. `selectOtherBucket` holds the rules and `OtherHoldingsRow`
  renders it, with one change from the spec: ours EXPANDS. The spec's row is
  final, and a wallet that permanently hides a holding because it is small has
  decided for the user what their money is worth looking at.
- `4 wallets · View ›` footer row (maps to our accounts list)

## Asset colours, with glyphs

```
₿  #F7931A  Bitcoin
₮  #26A17B  Tether       (12px)
$  #2775CA  USD Coin     (11px)
Ξ  #454A75  Ether        (12px)
T  #EB0029  Tron         (11px, letter fallback)
D  #F5AC37  DAI          (11px, letter fallback)
+n  dashed border, no fill, --g2 on --g3  — overflow chip
```

Per-glyph sizing is not incidental: ₿ ₮ Ξ $ have very different optical weights
at the same point size.
