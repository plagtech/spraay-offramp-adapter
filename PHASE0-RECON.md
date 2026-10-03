# PHASE0-RECON — spraay-offramp-adapter

- Date: 2026-09-30.
- Read-only. $0 spent. No adapter code written. No Paycrest key used. No POSTs to Paycrest.
- Clones are in the session scratchpad, outside the repo:

| Repo | Commit / Version | Date |
|---|---|---|
| `paycrest/docs` | `a29d38a5` | 2026-09-29 |
| `paycrest/sender-mcp` | `6860bfe2` | 2026-08-15 |
| `Blaqueyard/aggregator` | `eabcb762` | 2026-02-24 |
| `github.com/paycrest/aggregator` (pkg.go.dev, via Go module proxy) | `v0.2.0`, `v0.1.2` | 2025-09-26 / 2025-11-10 |

The GitHub aggregator repo is 404 (D1). The `Blaqueyard` fork was the Phase-0 stand-in. On
2026-10-03 the **official module path** was found cached on pkg.go.dev; its source zips (v0.2.0,
v0.1.2) were pulled read-only from `proxy.golang.org` and are the authoritative public source. See
the revised D2 and U-P1(c).

> **UPDATE 2026-10-03 — D2 does not reproduce in the authoritative source.** The official
> module-path releases (`v0.1.2`, `v0.2.0`) scope deposit dedup by the receive address's own status,
> not by txHash-across-all-orders. They do **not** exhibit the orders-2..N skip. The D2 bug is
> specific to the `Blaqueyard` fork snapshot. The core premise of the adapter (one tx funding N
> orders) is **not** blocked by the public source. Production status is still unconfirmed (all pkg
> versions are 2025; the fork is Feb 2026 — i.e. *newer*). `AGGREGATOR-FINDING.md` now carries a
> correction banner and must not be sent upstream as written. The remaining HOLD items are D3 and D8.

---

## Deviations from the brief (stop-don't-adapt)

| # | Brief said | Observed | Impact |
|---|---|---|---|
| **D1** | `paycrest/aggregator` is public, AGPL, 14 contributors | **HTTP 404.** It is not in the org repo list (17 repos). The fork network has been re-rooted to `awsvigilante/protocol` (stale, Jan 2025). I used the freshest fork `Blaqueyard/aggregator` @ `eabcb762` (Feb 2026, module `github.com/paycrest/aggregator`). | All U-P1 answers come from a 7-month-old snapshot. An upstream PR is not possible while the repo is private. |
| **D2** | U-P1(c) unknown | **Fork-only bug.** The `Blaqueyard` fork (Feb 2026) keys dedup on `paymentorder.TxHashEQ(txHash).Count()>0` across all orders, which skips orders 2..N. **The official module-path releases (`v0.1.2`, `v0.2.0`) do not** — they gate on `receiveAddress.Status != Unused` + the order's own `TxHash` (see U-P1(c)). | **No longer blocks the architecture** on the authoritative source. Open question is only whether production matches v0.1.2/v0.2.0 or the fork. See revised U-P1(c) and the correction banner in `AGGREGATOR-FINDING.md`. |
| **D3** | Phase 3 #2: sender-mcp PR | sender-mcp has **no LICENSE**, one maintainer, issues routed to an internal Jira (KAN), and PR titles must reference `KAN-###`. | A cold external PR is unlikely to land. Clear it on Telegram first. |
| D4 | "Success = `validated`" | Docs say `validated` is fine for off-ramp UX (sender guide :580). **`settled` is the terminal state** (:573). | Ledger should record both. Treat `validated` as "delivered" and `settled` as "final". |
| D5 | "Refund: `source.refundAddress`" | Correct, but the refund is **`amount + senderFee`**. The `transactionFee` is kept (lifecycle :321). | Document this for operators. It matters for D2's failure cost. |
| D6 | U-P5 needs a real key | `GET /v2/institutions/KES` is **public** (HTTP 200, no key). M-Pesa = **`SAFAKEPC`**, Airtel = `AIRTKEPC`. | U-P5 is resolved now. Still fetch at runtime and never hardcode. |
| D7 | Rate endpoint returns a single rate | Live v2 shape is `data.{buy,sell}.{rate, providerIds, orderType, refundTimeoutMinutes}`. | Off-ramp must use **`data.sell.rate`**. |
| D8 | Step 4: confirm vmflow x402 client against the live gateway | **Not done.** This machine's resolver (10.223.131.183) returns NXDOMAIN for `spraay.app` and `gateway.spraay.app`, while public DoH resolves them (gateway → `40c6gesl.up.railway.app` → 69.46.46.53). The sandbox blocked an attempt to pin the IP, so I did not bypass it. | LP: run the probe from an unrestricted shell, or allow the domain. vmflow-spraay **typechecks clean** and pins `@x402/fetch` / `@x402/evm` 2.25.0, ethers 6.17.0. |
| D9 | vmflow-spraay on this machine or the HP | Found at **`C:\Users\dell\Documents\vmflow-work\vmflow-spraay`**. There is no `C:\Users\Hp` on this machine; the HP is a separate box I can't reach. | Copy the client from the path above in Phase 1. |

---

## U-P1 — Aggregator deposit indexing (CRITICAL)

All references are to `Blaqueyard/aggregator@eabcb762`. Caveat D1 applies.

**(a) Receive address is unique per order.**
- Evidence:
  - v2 creates a fresh Thirdweb ERC-4337 smart account per order: `CreateSmartAddress(ctx, "payment_order_<nanos>_<uuid8>")` (`controllers/sender/sender.go:1061-1062`; `services/engine.go:40-60`).
  - The `receive_address` column is `Unique()` (`ent/schema/paymentorder.go:76-79`).
  - Expiry is `now + RECEIVE_ADDRESS_VALIDITY`, default **1800 s** (`config/order.go:37`). `.env.example` wrongly says "minutes".
- Decision: one receive address per recipient leg. This is safe.

**(b) No `from` restriction.**
- Evidence: any sender is accepted. The only `from` that gets skipped is Paycrest's own Gateway contract (`services/indexer/evm.go:157`, `controllers/index.go:2021`). If `ReturnAddress` is empty it is set to `event.From`, but v2 always sets it from `refundAddress` (`sender.go:740-743`).
- Decision: Transfer.from = SprayContract is accepted.

**(c) N Transfer logs in one tx: NOT a bug in the authoritative source.** (Revised 2026-10-03.)
- Evidence — official module path `github.com/paycrest/aggregator@v0.2.0` and `@v0.1.2`
  (`services/common/indexer.go`, `UpdateReceiveAddressStatus` at line 447, identical in both):
  ```go
  count, _ := db.Client.ReceiveAddress.Query().
      Where(receiveaddress.TxHashEQ(event.TxHash)).Count(ctx)
  if count > 0 && receiveAddress.Status != receiveaddress.StatusUnused {
      return false, nil   // skip
  }
  if paymentOrder.TxHash == event.TxHash {
      return false, nil   // skip
  }
  ```
  - Dedup is scoped to **this receive address's own status**. For order N in a batch tx, its
    receive address is still `StatusUnused` when its first transfer arrives, so `count>0 &&
    Status!=Unused` is false → it is **not** skipped. Its own `TxHash` is empty → not skipped.
    Each order proceeds. Receive addresses are unique per order (U-P1a), so there is no
    cross-order collision.
  - The `count>0` branch only suppresses a *second* transfer to an address that has already been
    used — the intended idempotency, not a cross-order skip.
  - Fetching is fine either way (Insight webhooks + Etherscan `tokentx` are log-based and see
    transfers inside a contract call).
  - `types.TokenTransferEvent` still has **no log index** (`types/types.go:61-66`: `{BlockNumber,
    TxHash, From, To, Value}`), same as the fork — but the dedup no longer depends on one.
  - The `Blaqueyard` fork's `paymentorder.TxHashEQ(...).Count()>0` form does not appear in either
    official version (grep: none).
- Caveat: v0.2.0/v0.1.2 are Sept–Nov 2025; the buggy fork is Feb 2026 (newer). The authoritative
  public source is clean, but this does not *prove* production is. The D2 decision (confirm against
  production, or report) still stands, downgraded from "blocker" to "verify".
- Decision: architecture is **unblocked** by the public source. One receive address per recipient
  leg; a batch tx funding N orders is supported by v0.1.2/v0.2.0's indexer.

**(d) Amount matching is exact, with silent re-pricing.** (Confirmed against official v0.2.0.)
- Evidence (`v0.2.0 services/common/indexer.go`):
  - `event.Value.Equal(amount.Add(networkFee+senderFee).Round(decimals))` (`:478-480`).
  - If the transfer doesn't match, the order **amount is reset to `value − fees` and it proceeds**
    (`SetAmount(value.Sub(fees))`, `:503-536`); `transferMatchesOrderAmount` is then forced `true`.
    It is not refunded.
  - **New wrinkle (not in the fork notes):** for P2P orders (recipient memo prefixed `P#P`) with a
    provider assigned and `CreatedAt` older than 30 min, the rate is also re-fetched via
    `getProviderRate` and `SetRate` (`:507-535`). Our off-ramp legs are not `P#P`, so this path
    should not fire, but assert the memo we send to be safe.
  - No `≤ 0.1` dust threshold exists in this function in v0.2.0/v0.1.2 (the fork's `:247` dust
    check is not present on the official path). Do not rely on dust being ignored.
  - Only orders that are `initiated` with `receive_address_expiry > now` are matched
    (`ProcessReceiveAddresses`, `:44-47`).
- Decision: send `providerAccount.amountToTransfer` exactly. Because an over- or under-send is accepted and re-priced rather than refunded, I7 (decode-before-sign) is the only guard against a wrong amount.

**Contract side (Sourcify `exact_match`, solc 0.8.20, `contracts/SprayContract.sol`).**
- Evidence:
  - `sprayToken` **pulls first, then transfers**: `safeTransferFrom(msg.sender, address(this), total+fee)` at :145, then `safeTransfer(recipient_i, amount_i)` at :149, then `safeTransfer(feeRecipient, fee)` at :154.
  - So **Transfer.from = the contract `0x1646…5eEC`** for every recipient leg. One tx emits N+2 Transfer logs.
  - Live on Base (`eth_call`):
    - `feeBps` = 30.
    - `paused` = false.
    - `owner` = `feeRecipient` = `0x033d3cE3bFd69B1d180869308822075219e771B5`.
  - Note that `feeBps` is **owner-mutable up to 500 (5%)** (:221-226), and `MAX_RECIPIENTS = 200`.
- Decision:
  - Reconcile (step 9) must read `feeBps` on-chain rather than assume 30.
  - The decode step (I7) should check that `approvalRequired.amount == Σamounts + Σamounts·feeBps/10000` as a cross-check, but still use the gateway's value verbatim (I2).

## U-P2 — Fees / `transactionFeePayer`

- Evidence:
  - Request fee fields are `senderFee` | `senderFeePercent` (mutually exclusive), `senderFeeAddress`, and `transactionFeePayer: sender|customer` (`openapi-v2.yaml:745-792`). The last one is set per token in Dashboard › Settings › Trading, default `sender`, and can be overridden per order.
  - Response fields are `senderFee` (what you earn), `senderFeePercent`, `transactionFee` (all network costs), and **`providerAccount.amountToTransfer`** (`yaml:1000-1060`).
  - The v2 response has **no `networkFee`**. The aggregator's internal `NetworkFee` is what v2 returns as `transactionFee`.
  - The guide (`sender-api-integration.mdx:911`) states `amountToTransfer = amount + senderFee + transactionFee` in both payer modes, and says to send exactly that (:515).
  - All numerics are decimal strings. Base USDC has 6 dp.
- Decision:
  - deliverable_i = **`providerAccount.amountToTransfer`**, converted once to BigInt raw (I3).
  - Assert that it equals `amount + senderFee + transactionFee`. Refuse the order if it doesn't, or if it has more than 6 dp.
  - This supersedes the brief's step-4 formula, which is equivalent but not the authoritative field.

## U-P3 — `validUntil`

- Evidence:
  - No duration is documented in prose. PR #28 removed the old "5 minutes" text; `concepts/architecture.mdx:167` still says 5 min (stale).
  - The OpenAPI examples show 30 min, and the code default is 1800 s.
  - The live rate endpoint reports `refundTimeoutMinutes: 2`. That is a different timer (provider refund), but note it.
- Decision:
  - Use `validUntil` from each response as the only authority.
  - Create orders immediately before the build step, and abort if `min(validUntil) < now + margin`. Margin is TBD; suggested 10 min, which covers x402, decode, approve, and confirmation.

## U-P4 — USDC on Base

- Evidence:
  - Live `GET /v2/tokens` returns `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `decimals: 6`, network `base`.
  - Docs say the same (`resources/supported-stablecoins.mdx:52`).
  - vmflow-spraay's `BASE_USDC` (`src/config.ts:15`) is the same address.
- Other live data:
  - `/v2/currencies` shows KES (2 dp), NGN, TZS, UGX.
  - `/v2/markets?side=sell&fiat=KES&token=USDC&network=base` shows `min:"0.5"`.
- Decision: **match.** Still assert the token address at runtime.
  - Note: `troubleshooting.mdx:40` mentions "minimum of 1 for this network". Validate the minimum against the API and don't hardcode $0.50.

## U-P5 — KES institution codes

- Evidence:
  - The endpoint is public (see D6). **`SAFAKEPC`** = M-Pesa, `AIRTKEPC` = Airtel.
  - Till and Paybill go in `recipient.metadata.{channel, businessNumber}` (guide :440-482).
- Decision: resolved. Fetch at runtime, since the brief's rule is never to guess.

## U-P6 — sender-mcp internals

- Evidence:
  - Go 1.25.0 (toolchain 1.25.10). Module path **`github.com/paycrest/paycrest/sender-mcp`**, which does not match the repo URL. MCP via `modelcontextprotocol/go-sdk v1.6.0`, stdio.
  - **9 tools**, all v2, all in `mcpserver/tools.go`: get_currencies / institutions / tokens / pubkey / rates, list / get / watch_sender_order, and create_order (raw JSON passthrough).
  - Auth is `PAYCREST_API_KEY` sent as `API-Key`.
  - **It never signs or sends.** There is no chain library; the create response tells the user to send the funds themselves.
  - CI: only `release.yml`, on `v*` tags. No PR CI.
  - Releases: v0.1.0 and v0.1.1 (2026-07-15).
  - Sole contributor: `sundayonah` (Onah Sunday).
  - **No LICENSE, CONTRIBUTING, or CODEOWNERS.** Blank issues are disabled; issues go to Jira KAN. The PR template needs `KAN-###` plus a "Money-safety Yes/No" field.
- Decision: see D3. If pursued, the PR should be a new tool in `mcpserver/tools.go` plus a new package beside `paycrest/`.

## U-P7 — Go x402 client

- Evidence:
  - It exists and is official. **`github.com/x402-foundation/x402/go/v2`**, tag `go/v2.28.0`, last release commit 2026-09-29.
  - `coinbase/x402/go` was last touched 2026-04-21 and now points at the foundation repo.
  - Payer-side: `http.WrapHTTPClientWithPayment` and `PaymentRoundTripper` (`go/v2/http/client.go:148,173`).
  - EVM exact scheme supports CAIP-2: `Register("eip155:8453", evm.NewExactEvmScheme(signer, nil))`.
  - The default spend cap is $1, so the $0.02 fee fits.
  - Cost: it brings in go-ethereum, solana-go, and gin.
- Decision:
  - **Gateway-routed is technically feasible in Go.**
  - The mission guard requires routing through `/api/v1/batch/execute`, so contract-direct is **not an option** for any Plagtech-authored code path.
  - Note for LP: a keyless "return unsigned calldata" design would fit sender-mcp's existing pattern, but it would bypass the $0.02 gateway fee.

## U-P8 — paycrest/docs conventions

- Evidence:
  - License AGPL-3.0. Mintlify; front matter is only `title` and `description`.
  - Nav: `docs.json` → `navigation.versions[v2].tabs["Guides"].groups["Implementation Guides"].pages` (`docs.json:48-54`).
  - **Every recent PR adds a `resources/changelog.mdx` entry.**
  - PRs #28, #32, and #33 were all authored and merged by `chibie`.
    - Titles are conventional commits, e.g. `docs(sender): document the transaction fee payer`.
    - The body has `### Description` (linking the related aggregator or dashboard PR), then per-file bullets, then `### Testing` listing `python3 -c "import yaml; yaml.safe_load(...)"`, `mint openapi-check openapi-v2.yaml`, and `mint broken-links`.
  - No CLA, DCO, or CONTRIBUTING.
  - #28's new guide page was **later removed and redirected** (`docs.json:188-196`). Precedent: new standalone guides have been pruned.
  - The docs say **nothing** about multi-order single-tx funding, sender restrictions, or "one deposit per order".
- Decision: the template is clear. Whether a batch-funding guide is accurate depends on D2.

---

## Decisions needed from LP

1. **D2 (downgraded 2026-10-03: verify, not blocker).** The authoritative public source
   (v0.1.2/v0.2.0) does not have the orders-2..N skip; only the Feb-2026 `Blaqueyard` fork does.
   Remaining question is whether production matches the official releases or the fork. Choose:
   - **(a)** Run a 2-order × $0.50 single-tx test to see what production actually does. Worst-case
     cost is one `transactionFee` plus gas (and only if production is the fork).
   - **(b)** No upstream bug report as written — `AGGREGATOR-FINDING.md` is contradicted by the
     authoritative source. If (a) shows the fork behaviour in production, re-derive the finding
     against the live version before reporting.

   Phase 1 code is fine whatever production does.
2. **D8.** Run the vmflow x402 probe from an unrestricted shell, or allowlist `spraay.app` / `gateway.spraay.app` for this machine.
3. **D3.** Whether to pursue sender-mcp at all, given no license and Jira-only intake.
4. **U-P3.** Confirm the `validUntil` safety margin (suggested 10 min).
