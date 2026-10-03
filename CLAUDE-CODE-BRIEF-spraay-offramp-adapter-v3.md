# CLAUDE-CODE-BRIEF — spraay-offramp-adapter v3

## Quick context for Claude Code

Plagtech ships open-source software. Plagtech is NOT a Paycrest sender — the operator
who runs this adapter uses THEIR OWN Paycrest sender key (they did their own KYB).
Plagtech never holds funds, never holds credentials, never needs AML/KYC policies for
this. Revenue: every batch routes through the Spraay gateway ($0.02 x402) and contract
(0.3%). That's it.

---

## Identity — use on every commit, never placeholders

- Git author: `plagtech <mngoswp@gmail.com>`
- No Claude co-author trailer (`includeCoAuthoredBy: false`)
- Repo: `plagtech/spraay-offramp-adapter`, MIT license
- NOT `"private": true` — this publishes to npm

## What this is

Paycrest's off-ramp returns one `providerAccount.receiveAddress` per order. To pay N
recipients today, a sender creates N orders and sends N separate on-chain transfers
(N txs, N gas fees). This adapter replaces the N transfers with ONE Spraay `sprayToken`
call: create N orders → collect N receive addresses + exact amounts → one batch tx
delivers every exact amount → Paycrest indexes each deposit → provision nodes pay out
KES/NGN/UGX/TZS → webhooks confirm.

Non-custodial end to end: USDC moves sender's wallet → Spraay contract → N Paycrest
receive addresses in one transaction. The adapter builds; the operator's key signs.

## MISSION-CRITICAL GUARD (check before every commit)

1. Does this include batch payments? → must be YES
2. Does it route through Spraay paid endpoints? → `/api/v1/batch/execute` ($0.02 x402) + 0.3% contract fee → must be YES

Either NO → stop, ask LP.

## Non-goals (v1)

- Off-ramp only (no on-ramp)
- Base + USDC only
- No Kotani code (only the `OfframpProvider` interface is shaped so Kotani fits later)
- No hosted service — each operator runs with their own Paycrest sender key
- No gateway changes (frozen nine untouched)
- No AML/KYC policy files in this repo — the operator carries those obligations

---

## VERIFIED FACTS — do not re-derive, do not guess

### Paycrest Sender API v2

Source: `https://docs.paycrest.io` (fetched Sep 29 2026)

- Base URL: `https://api.paycrest.io`
- Auth: `API-Key: <sender key>` header. API Secret for webhook HMAC only.
- Create order: `POST /v2/sender/orders`
- Off-ramp body: `amount` (string), optional `amountIn: "fiat"|"crypto"`, optional
  `rate`, optional `senderFee`/`senderFeePercent` + `senderFeeAddress`, `reference`,
  `source {type:"crypto", currency:"USDC", network:"base", refundAddress}`,
  `destination {type:"fiat", currency:"KES", recipient {institution, accountIdentifier, accountName, memo, metadata}}`
- Response: `id`, `status:"initiated"`, `providerAccount {network, receiveAddress, validUntil}`,
  fee fields. Send exactly `amount + senderFee + transactionFee` before `validUntil`.
- KES M-Pesa institution code: get from `GET /v2/institutions/KES` — NEVER guess
- Verify account: `POST /v2/verify-account`
- Public rate: `GET /v2/rates/base/USDC/{amount}/KES` — no key needed
- Webhook signature: `X-Paycrest-Signature` = HMAC-SHA256(API Secret, raw body) as
  lowercase hex; timing-safe compare on UTF-8 hex strings; trim + lowercase header.
  Events: `payment_order.{deposited,pending,validated,settling,settled,refunding,refunded,expired,compliance_hold}`
  Success = `validated` (fiat delivered).
- Poll: `GET /v2/sender/orders/:id`
- Testing: mainnet only, $0.50 minimum order
- Refund: `source.refundAddress`

### Spraay gateway

- `POST https://gateway.spraay.app/api/v1/batch/execute` — x402 $0.02, non-custodial,
  returns unsigned `{to, data, value, chainId, gasLimit(hex)}`
- Body: `{token (default USDC), recipients[] ≤200, amounts[] raw base-unit strings, sender}`
  Optional `chain` allowlist `base|peaq`, default `base`
- ERC-20 responses carry `approvalRequired {token, spender, amount(raw), amountFormatted}`
  — **use `amount` verbatim, never recompute**
- `POST /api/v1/batch/estimate` $0.001
- Base contract: `0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC`
  `sprayToken(address token, (address,uint256)[] recipients)`, fee = 30 bps on top,
  `MAX_RECIPIENTS 200`
- **NEVER use `0x62B59b327837661e84B4d8fDFDa5C1A7B39a8e67`** (fabricated)
- Proven x402 client: `@x402/fetch` + `@x402/evm` @2.25.0 with the ethers→viem signer
  adapter from `vmflow-spraay`. Copy that client, don't rewrite it.
  `x402-fetch@1.2.0` cannot speak v2/eip155:8453.
- x402 only; never MPP (`Authorization: Payment` is broken in prod)

### Paycrest GitHub (fetched Sep 29 2026)

- `paycrest/docs` — active, PRs merged Sep 2026, Mintlify MDX
- `paycrest/sender-mcp` — Go, v0.1.1 Jul 2026, 0 stars
- `paycrest/aggregator` — Go, AGPL-3.0, 14 contributors, read-only for Phase 0
- `paycrest/noblocks` — active, later target

---

## UNVERIFIED — Phase 0 must pin each from primary sources

### U-P1: Aggregator deposit indexing (CRITICAL)

Clone `paycrest/aggregator`. Answer:
(a) Is `receiveAddress` unique per order or reused?
(b) Does the indexer require `Transfer.from == sender/refundAddress`, or any sender?
(c) Does it handle N `Transfer` logs in ONE tx (keyed by `txHash+logIndex` or `txHash` alone)?
(d) Amount matching: exact or tolerance?

Also read the Sourcify-verified SprayContract on Base to see whether `sprayToken` does
`transferFrom(msg.sender, recipient, amt)` (Transfer.from = EOA) or pulls-then-transfers
(Transfer.from = contract).

If (c) keys on txHash only → orders 2..N silently dropped → real bug → write
`AGGREGATOR-FINDING.md`, LP decides if it becomes a PR.

### U-P2: `transactionFeePayer` setting

Read current OpenAPI or `https://docs.paycrest.io/openapi-v2.yaml`. Record every fee
field in create response and which are included in the amount to send.

### U-P3: `validUntil` window

Read `concepts/transaction-lifecycle.md`. Design so orders are created immediately
before batch broadcast; abort if any `validUntil < now + margin`.

### U-P4: USDC-on-Base token address

`GET /v2/tokens` + `resources/supported-stablecoins.md`. Confirm it matches the
gateway's USDC on Base.

### U-P5: Institution codes for KES

`GET /v2/institutions/KES` — need real key for this. Deferred to operator's first run.

### U-P6: sender-mcp internals

Clone `paycrest/sender-mcp`. Read tool definitions, Go version, CI, README,
CONTRIBUTING. Note maintainer(s).

### U-P7: x402 Go client existence

Check `github.com/coinbase/x402` or `x402-foundation` for a Go package.
Decides whether the sender-mcp PR goes gateway-routed or contract-direct.

### U-P8: paycrest/docs conventions

Clone. Read merged PRs #28, #32 as templates. MDX front-matter, nav file, PR style.

---

## Architecture

```
operator supplies: recipients[] ≤200 {phone, accountName, kes|usdc, memo}
      │
  [1] gate       embargo block (Cuba/Iran/NK/Russia/Crimea) + SDN hook (deny-list
                  file interface; pluggable) + phone→ISO
      │
  [2] verify     POST /v2/verify-account per recipient (optional, on by default)
      │
  [3] create     POST /v2/sender/orders per recipient (amountIn:"fiat" when KES;
                  reference=`${runId}-${i}`; refundAddress=operator wallet)
                  → {id, receiveAddress, validUntil, amount, senderFee, transactionFee}
      │
  [4] guard      all orders initiated; earliest validUntil > now + margin;
                  deliverable_i = amount+senderFee+transactionFee per U-P2;
                  BigInt(deliverable_i × 1e6); refuse >6 decimals
      │
  [5] build      POST gateway /api/v1/batch/execute (x402 $0.02)
                  recipients=receiveAddress[], amounts=raw[], sender
                  → unsigned tx + approvalRequired
      │
  [6] decode     ABI-decode calldata: selector==sprayToken, to==contract,
                  chainId 8453, decoded recipients/amounts == step-4 list
      │
  [7] sign+send  approve exactly approvalRequired.amount, batch nonce ≥ approval+1,
                  broadcast — ONE tx
      │
  [8] track      webhook receiver (HMAC verified) + poller fallback → SQLite ledger
                  success = payment_order.validated
      │
  [9] reconcile  on-chain Transfer(receiveAddress_i, deliverable_i) ∀i;
                  fee event = 30 bps; write proof table to README
```

### OfframpProvider interface

`src/providers/types.ts`: `quote()`, `verifyRecipient()`, `createOrder()`,
`getOrder()`, `parseWebhook()`. Paycrest implements it. Kotani fits later.

### Invariants (each a regression test)

- I1: Never broadcast unless every order is `initiated` and inside `validUntil`
- I2: Never recompute approval; use `approvalRequired.amount` verbatim
- I3: Units cross once via BigInt; refuse >6 decimals from Paycrest
- I4: Failed ≠ disproven; post-broadcast errors keep orders claimed; retry explicit
- I5: Per-order failure isolation
- I6: Non-custodial: signing key signs only approve + sprayToken
- I7: Decode-before-sign: ABI-decode unsigned tx, match to confirmed list before signing

---

## Phases

### Phase 0 — Recon (read-only, $0)

1. Clone `paycrest/aggregator`, `paycrest/sender-mcp`, `paycrest/docs` (read-only)
2. Pin U-P1 through U-P8 from code and docs (no key needed for any)
3. Read Sourcify-verified SprayContract source on Base for U-P1
4. Confirm vmflow-spraay's x402 client builds against live gateway (unfunded, $0)
5. Write `PHASE0-RECON.md` with each unknown → observation → evidence → decision
6. If U-P1(c) = txHash-keyed → write `AGGREGATOR-FINDING.md`
7. **HOLD for LP review**

vmflow-spraay location: check both `C:\Users\dell\Documents\` and `C:\Users\Hp\Documents\`
— copy the x402 client from wherever it lives.

### Phase 1 — Build (local, $0)

Stack: TypeScript, Node 20, ethers v6, @x402/fetch + @x402/evm 2.25.0 (copied client),
better-sqlite3, vitest. MIT.

```
spraay-offramp-adapter/
  src/
    providers/types.ts           OfframpProvider interface
    providers/paycrest.ts        v2 client
    providers/paycrest-webhook.ts HMAC verify + event→ledger
    spraay/gateway.ts            batch/execute via x402
    spraay/decode.ts             I7 decode+match
    spraay/sign.ts               exact approve, nonce, broadcast
    compliance/gate.ts           embargo block, SDN hook, phone→ISO
    units.ts                     BigInt human↔raw, 6-dp refusal
    run.ts                       orchestrates steps 1-9
    reconcile.ts                 on-chain + Paycrest cross-check
  cli.ts                         pay --file recipients.csv --dry-run | --execute
  test/                          I1-I7 + units + webhook fixtures + decode fixtures
  README.md
  .env.example                   PAYCREST_API_KEY, PAYCREST_API_SECRET,
                                 SPRAAY_WALLET_PRIVATE_KEY, BASE_RPC_URL,
                                 WEBHOOK_URL, WEBHOOK_PORT
```

Carry-overs from vmflow-spraay / rmf-spraay: BigInt money math, deterministic references,
pending-run idempotency, process.exit only after sockets close, strict parsers,
serial RPC reads with backoff.

**HOLD for LP review**

### Phase 2 — Mainnet proof (partner-run, ≤$5 on the partner's key)

Plagtech does NOT hold a Paycrest sender key. A partner operator (found via Paycrest
Telegram or an existing sender) runs the adapter with THEIR key and wallet:

- 3 orders of $0.50 USDC each to a real KES M-Pesa number
- One negative case: compliance-gate rejection before any order
- Record: Basescan hash, per-order ids, decoded amounts, fee event, webhook payloads,
  M-Pesa SMS evidence
- Partner gives permission to use the hashes in the README

**HOLD for LP review → secret scan → repo public → npm publish**

### Phase 3 — Distribution

1. `paycrest/docs` PR — implementation guide, LP hand-writes title/body
2. `paycrest/sender-mcp` PR + companion issue — batch-funding tool
3. npm publish (so `npx spraay-offramp-adapter pay --file …` works)
4. GHCR container image
5. GitHub repo topics: paycrest, m-pesa, mobile-money, offramp, x402, base, kenya, nigeria
6. MCP registries: official registry, Smithery, Glama, mcp.so (off-ramp tools added to Spraay MCP)
7. awesome-x402 update to merged #470 entry
8. ClawHub skill
9. docs.spraay.app card
10. Base ecosystem / Circle partner outreach (after proof)

---

## Revenue check

Every adapter run: $0.02 gateway + 0.3% contract. No free rails.
Operator may set `senderFeePercent` for their own margin — Plagtech's fee is separate.

## Stop-don't-adapt rule

Any fact marked UNVERIFIED that turns out different from this brief → stop, write it
in PHASE0-RECON.md, hold for LP.
