import type { ApprovalPresentation } from "@/core/approval/approvalRequest";
import type { WalletAccountSummary } from "@/core/messaging/walletApi";
import type { TransactionWarning } from "@/core/transaction/calldataDecoder";
import type { TypedDataWarning } from "@/core/signing/typedDataSigning";
import { AddressChip, Callout } from "../components/forms";
import { SectionLabel } from "../components";

/**
 * The body of an approval prompt, per request kind.
 *
 * Every branch answers the same question in the user's terms: WHAT AM I
 * AUTHORISING, AND WHAT IS THE WORST IT CAN DO? A screen that shows a hex blob
 * and an Approve button has not obtained consent -- the user is authorising
 * something neither they nor the wallet can describe, and that screen is where
 * most drainer losses actually happen.
 *
 * So anything the wallet could not decode is labelled as such, loudly, and
 * never dressed up as an ordinary transfer.
 */

export interface ApprovalBodyProps {
  presentation: ApprovalPresentation;
  accounts: readonly WalletAccountSummary[];
  selected: readonly string[];
  onToggleAccount: (address: string) => void;
}

export function ApprovalBody({
  presentation,
  accounts,
  selected,
  onToggleAccount,
}: ApprovalBodyProps) {
  switch (presentation.kind) {
    case "connect":
      return (
        <ConnectBody accounts={accounts} selected={selected} onToggleAccount={onToggleAccount} />
      );

    case "personalSign":
      return (
        <Section title="Sign this message">
          <SignerRow address={presentation.address} />
          {presentation.isBinary ? (
            <Callout tone="danger" title="Unreadable message">
              This is not readable text. The wallet cannot tell you what it says, and signing it
              could authorise something you have not seen. Only continue if you know exactly what
              this site does.
            </Callout>
          ) : null}
          <pre className="max-h-56 overflow-auto rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-(--color-ink)">
            {presentation.displayText}
          </pre>
          <Detail label="Size" value={`${presentation.byteLength} bytes`} />
        </Section>
      );

    case "typedData":
      return (
        <Section title={`Sign ${presentation.primaryType}`}>
          <SignerRow address={presentation.address} />
          {/* BEFORE the field list, not after it. The rows below are true and
              unhelpful on their own -- a 78-digit `value` is not a thing a
              person can weigh -- so what the signature DOES has to come first,
              in the position the eye reaches before the detail. */}
          {presentation.warnings.map((warning) => (
            <TypedDataWarningCallout key={warning} warning={warning} />
          ))}
          {presentation.domainName ? (
            <Detail label="Domain" value={presentation.domainName} />
          ) : null}
          {presentation.verifyingContract ? (
            <Detail label="Contract" value={presentation.verifyingContract} mono />
          ) : null}
          <div className="rounded-(--radius-card) border border-(--color-line) bg-(--color-card)">
            {/* Every leaf is listed individually. The whole point of EIP-712 is
                human-readable signing, and that is defeated by rendering the
                JSON blob it was designed to replace. */}
            {presentation.fields.map((field) => (
              <div
                key={field.path}
                className="flex items-start justify-between gap-3 border-b border-(--color-line) px-3 py-2 last:border-b-0"
              >
                <span className="font-mono text-[11px] text-(--color-slate)">{field.path}</span>
                <span className="font-mono text-[11px] break-all text-right text-(--color-ink)">
                  {field.value}
                </span>
              </div>
            ))}
          </div>
        </Section>
      );

    case "transaction":
      return (
        <Section title={presentation.headline}>
          <SignerRow address={presentation.address} />
          {presentation.warnings.map((warning) => (
            <WarningCallout key={warning} warning={warning} />
          ))}

          {presentation.recipient ? (
            <Detail label="To" value={presentation.recipient} mono />
          ) : null}
          <Detail label="Amount" value={presentation.valueLabel} />

          {/* BOTH fee figures, always. Showing only the maximum makes the wallet
              look expensive and pushes users to set fees that get stuck;
              showing only the expected cost hides the real worst case. Naming
              both is the only honest presentation. */}
          <Detail label="Estimated fee" value={presentation.expectedFeeLabel} />
          <Detail label="Maximum fee" value={presentation.maximumFeeLabel} />
          {!presentation.isFeeEstimated ? (
            <Callout tone="warning" title="Fee is approximate">
              This account cannot be simulated -- usually because it has no ETH yet -- so the fee
              above is a typical figure rather than a measurement of this transaction.
            </Callout>
          ) : null}

          <Detail label="Nonce" value={String(presentation.nonce)} />
          {presentation.dataHex ? (
            <details className="rounded-(--radius-card) border border-(--color-line) bg-(--color-card) p-3">
              <summary className="cursor-pointer text-xs text-(--color-slate)">
                Transaction data
              </summary>
              <p className="mt-2 font-mono text-[10px] break-all text-(--color-slate)">
                {presentation.dataHex}
              </p>
            </details>
          ) : null}
        </Section>
      );

    case "switchChain":
      return (
        <Section title={`Switch to ${presentation.targetChain.name}`}>
          <p className="text-xs leading-relaxed text-(--color-slate)">
            This site wants the wallet to change networks. Everything you sign afterwards will be on{" "}
            {presentation.targetChain.name} until you switch back.
          </p>
          <Detail label="Network" value={presentation.targetChain.name} />
          <Detail label="Chain ID" value={String(presentation.targetChain.chainId)} />
          <Detail label="Currency" value={presentation.targetChain.nativeCurrencySymbol} />
        </Section>
      );

    case "addChain":
      return (
        <Section title={`Add ${presentation.targetChain.name}`}>
          {/* The single most important sentence on this screen. A custom RPC is
              the wallet's entire view of the chain: it reports balances, prices
              gas, and receives broadcasts. */}
          <Callout tone="warning" title="This site is choosing your connection">
            The wallet will ask this endpoint for balances and fees, and send signed transactions to
            it. Only add a network from a source you trust.
          </Callout>
          <Detail label="Network" value={presentation.targetChain.name} />
          <Detail label="Chain ID" value={String(presentation.targetChain.chainId)} />
          <Detail label="RPC endpoint" value={presentation.rpcUrl} mono />
          <Detail label="Currency" value={presentation.targetChain.nativeCurrencySymbol} />
          {presentation.isRpcVerified ? (
            <p className="text-[11px] text-(--color-slate)">
              The wallet checked this endpoint and it reports chain{" "}
              {presentation.targetChain.chainId}, matching what the site claimed.
            </p>
          ) : null}
        </Section>
      );

    case "watchAsset":
      return (
        <Section title={`Add ${presentation.token.symbol} to your wallet`}>
          {/* The sentence that makes this screen worth showing. A site can
              deploy a contract calling itself anything, so the name above is
              the CONTRACT's claim about itself and the address is the only
              part that identifies it. */}
          <Callout tone="warning" title="Anyone can name a token">
            This name and symbol come from the contract itself, not from a registry. A token
            calling itself USDC is not necessarily USDC -- check the address against a source you
            trust before you treat it as money.
          </Callout>
          <Detail label="Name" value={presentation.token.name} />
          <Detail label="Symbol" value={presentation.token.symbol} />
          <Detail label="Contract" value={presentation.token.address} mono />
          <Detail label="Decimals" value={String(presentation.token.decimals)} />
          <Detail label="Network" value={presentation.token.networkLabel} />
          {presentation.balanceLabel === undefined ? null : (
            <Detail
              label="You hold"
              value={`${presentation.balanceLabel} ${presentation.token.symbol}`}
            />
          )}
          <p className="text-[11px] leading-relaxed text-(--color-slate)">
            Adding it only makes the balance visible. The wallet will not show a dollar value for
            it, because a price looked up by name would be the wrong price.
          </p>
        </Section>
      );
  }
}

function ConnectBody({
  accounts,
  selected,
  onToggleAccount,
}: {
  accounts: readonly WalletAccountSummary[];
  selected: readonly string[];
  onToggleAccount: (address: string) => void;
}) {
  return (
    <Section title="Connect to this site">
      <p className="text-xs leading-relaxed text-(--color-slate)">
        The site will see the addresses you tick and their balances, and can ask you to sign with
        them. It cannot move anything without a separate approval each time.
      </p>

      <SectionLabel>Accounts to share</SectionLabel>
      <div className="rounded-(--radius-card) border border-(--color-line) bg-(--color-card)">
        {accounts.length === 0 ? (
          <p className="px-3 py-4 text-xs text-(--color-slate)">No accounts available.</p>
        ) : (
          accounts.map((account) => {
            const isSelected = selected.some(
              (address) => address.toLowerCase() === account.address.toLowerCase(),
            );
            return (
              <label
                key={account.address}
                className="flex cursor-pointer items-center gap-3 border-b border-(--color-line) px-3 py-2.5 last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleAccount(account.address)}
                  className="h-4 w-4 accent-(--color-btn-bg)"
                />
                <span className="flex flex-col">
                  <span className="text-sm text-(--color-ink)">{account.label}</span>
                  <AddressChip address={account.address} />
                </span>
              </label>
            );
          })
        )}
      </div>
      {/* Accounts are a subset, not a flag. Saying so is what makes the tick
          boxes read as a choice rather than a formality. */}
      <p className="text-[11px] text-(--color-slate)">
        Accounts you leave unticked stay invisible to this site.
      </p>
    </Section>
  );
}

const WARNING_COPY: Record<TransactionWarning, { title: string; body: string }> = {
  unlimited_approval: {
    title: "Unlimited spending approval",
    body: "This lets the site move this token from your account, in any amount, forever, without asking again. This is the mechanism behind most wallet drains. Approve only an amount you are willing to lose.",
  },
  imported_token: {
    title: "You added this token yourself",
    body: "Its name, symbol and decimal places come from the token's own contract, not from a list this wallet checked. Anyone can deploy a contract using a familiar name, so confirm the contract address is the one you meant.",
  },
  approval_to_unverified_contract: {
    title: "Approval to an unverified contract",
    body: "The contract receiving this approval has no published source, so nobody can check what it does with the access you are granting.",
  },
  blind_signing: {
    title: "The wallet cannot read this",
    body: "This transaction's data could not be decoded, so no one can tell you what it will actually do. Continue only if you trust this site completely.",
  },
  contract_deployment: {
    title: "Deploying a contract",
    body: "This publishes new code to the chain. No preview can summarise what that code will do once it is live.",
  },
  transfer_to_token_contract: {
    title: "Sending to a token contract",
    body: "The recipient is a token contract, not a wallet. Tokens sent this way are almost always unrecoverable.",
  },
};

/**
 * Copy for the typed-data warnings.
 *
 * Kept beside the transaction copy, and worded for the thing that makes a
 * signed permit different from an on-chain approval: it costs nothing, it
 * produces no transaction, and it will not appear in Activity. Users who know
 * to check their transaction history for something unexpected will find
 * nothing there, which is exactly why the screen has to say it up front.
 */
const TYPED_DATA_WARNING_COPY: Record<TypedDataWarning, { title: string; body: string }> = {
  spending_permission: {
    title: "This is permission to move your tokens",
    body: "You are not sending anything. You are signing a permission slip that lets the named spender take this token out of your account later, in their own transaction. It costs no gas, and it will not appear in your Activity.",
  },
  unlimited_permission: {
    title: "The amount is unlimited",
    body: "This permission is not capped at the amount you are trading. It covers your entire balance of this token, including anything you receive in future. This is the mechanism behind most wallet drains.",
  },
  long_lived_permission: {
    title: "It does not expire soon",
    body: "This permission stays valid for a long time, or carries no expiry at all. Whoever holds this signature can use it long after you have forgotten the site that asked for it.",
  },
  blind_signing: {
    title: "The wallet cannot read this",
    body: "This wallet does not recognise the structure being signed, so no one can tell you what it will actually authorise. The rows below are the raw contents, not an explanation. Continue only if you trust this site completely.",
  },
};

function TypedDataWarningCallout({ warning }: { warning: TypedDataWarning }) {
  const copy = TYPED_DATA_WARNING_COPY[warning];
  // Danger for the two that describe an unbounded loss; warning for the rest.
  const tone =
    warning === "unlimited_permission" || warning === "spending_permission"
      ? "danger"
      : "warning";
  return (
    <Callout tone={tone} title={copy.title}>
      {copy.body}
    </Callout>
  );
}

function WarningCallout({ warning }: { warning: TransactionWarning }) {
  const copy = WARNING_COPY[warning];
  const tone =
    warning === "unlimited_approval" || warning === "transfer_to_token_contract"
      ? "danger"
      : "warning";
  return (
    <Callout tone={tone} title={copy.title}>
      {copy.body}
    </Callout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 pt-4">
      <h1 className="font-serif text-lg leading-snug break-words text-(--color-ink)">{title}</h1>
      {children}
    </div>
  );
}

function SignerRow({ address }: { address: string }) {
  return (
    <div className="flex items-center justify-between rounded-(--radius-card) bg-(--color-muted) px-3 py-2">
      <span className="text-[11px] uppercase tracking-[0.12em] text-(--color-slate)">Signing as</span>
      <AddressChip address={address} />
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-(--color-line) pb-2">
      <span className="text-xs text-(--color-slate)">{label}</span>
      <span
        className={`text-right text-xs break-all text-(--color-ink) ${mono ? "font-mono" : "numeric"}`}
      >
        {value}
      </span>
    </div>
  );
}
