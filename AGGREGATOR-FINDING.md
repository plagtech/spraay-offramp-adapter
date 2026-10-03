# AGGREGATOR-FINDING — one tx funding N orders: orders 2..N are skipped

> **CORRECTION 2026-10-03 — DO NOT SEND UPSTREAM AS WRITTEN.** This finding is based solely on the
> `Blaqueyard/aggregator` fork (Feb 2026). On 2026-10-03 the official module path
> `github.com/paycrest/aggregator` was read from pkg.go.dev (versions `v0.1.2`, `v0.2.0`, pulled via
> the Go module proxy). Those authoritative releases scope the deposit dedup by the receive
> address's own `Status != Unused` plus the order's own `TxHash` — **not** by
> `paymentorder.TxHashEQ(txHash).Count()>0` across all orders — so they do **not** exhibit the
> orders-2..N skip described below. The defect as written appears specific to the fork snapshot.
> Before any report or PR, re-derive against the version actually running in production (see
> PHASE0-RECON.md, revised U-P1(c) and D2). The analysis below is retained for the record only.

Status: **superseded by the authoritative source; see the correction banner above.** Originally
recorded 2026-09-30, Phase 0 recon. Read-only; nothing was sent to Paycrest.

## Source caveat (read first)

`github.com/paycrest/aggregator` returns **HTTP 404**. It is not in the `paycrest` org repo
listing, and the GitHub fork network has been re-rooted to `awsvigilante/protocol`, a third-party
fork last pushed 2025-01-21. The code below comes from the most recent public fork:

- `github.com/Blaqueyard/aggregator` @ `eabcb7625b8e81b99ff492e2fe4f8a828a927093` (2026-02-24)
- `go.mod` module `github.com/paycrest/aggregator`
- The tip commit is "Merge branch 'stable'" by Chibuotu Amadi (Paycrest core)

Production may have changed since February 2026. This is evidence of the bug, not proof it is
still live.

## The defect

`services/common/indexer.go:231-244`, `UpdateReceiveAddressStatus`:

```go
if event.To == paymentOrder.ReceiveAddress {
    // Check for existing payment order with txHash
    count, err := db.Client.PaymentOrder.
        Query().
        Where(paymentorder.TxHashEQ(event.TxHash)).
        Count(ctx)
    ...
    if count > 0 {
        // This transfer has already been indexed
        return false, nil
    }
```

- The dedup is keyed on **txHash alone**, across all orders. It is not scoped to the order, the
  receive address, or the log index.
- `types.TokenTransferEvent` (`types/types.go:73-79`) has no log index at all. It only carries
  `{BlockNumber, TxHash, From, To, Value}`.
- When the first order matches, the indexer writes `SetTxHash(event.TxHash)`
  (`indexer.go:297` / `:306`) and commits (`:317`).
- Every later Transfer log in the same tx then finds `count > 0` and returns `false, nil`. Nothing
  is logged and no error is raised.

### Paths that hit it

- **Polling and receipt path:** `services/indexer/evm.go:194-204` calls `ProcessTransfers` once
  per Transfer log, one after another. The first order commits, then orders 2..N are always
  skipped.
- **Webhook path:** there is one Thirdweb Insight webhook per receive address, so N webhooks arrive
  almost at once. Some may race past the check (non-deterministic); most will be skipped.
- **Admin reindex:** it goes through the same function, so reindexing does not recover the
  skipped orders.
- **Side effect:** `services/common/order.go:848-854` (`deleteTransferWebhook`) does
  `TxHashEQ(txHash).Only()`. That errors (not singular) if two orders ever share a hash.

### What happens to a skipped order

1. The order stays `initiated` until `receive_address_expiry`. The default is 1800 s
   (`config/order.go:37`).
2. It then becomes `expired`, and a `payment_order.expired` webhook is sent.
3. `tasks/refunds.go` sweeps the receive-address balance to `ReturnAddress`, which is the order's
   `refundAddress`.
4. The documented refund is `amount + senderFee`. The `transactionFee` is kept
   (`concepts/transaction-lifecycle.mdx:321`, docs repo).

So funds are not lost, but the off-ramp for orders 2..N never happens, and each one loses its
transaction fee.

## What is *not* a problem

- **Transfers made inside a contract call are seen.** Insight webhooks filter on the token's
  `Transfer` event with `to = receiveAddress` (`services/engine.go:287-301`). The Etherscan
  `tokentx` fallback is also log-based.
- **`Transfer.from` is not checked.** Any sender is accepted (`indexer.go`). The only `from` that
  is skipped is the Paycrest Gateway contract itself.
- **Receive addresses are unique.** Each order gets a fresh Thirdweb ERC-4337 smart account
  (`controllers/sender/sender.go:1061-1062`), and `receive_address` is `Unique()`
  (`ent/schema/paymentorder.go:76-79`).

## Minimal fix (for a PR or report, if LP chooses)

1. Add `LogIndex` to `TokenTransferEvent` and fill it from the Insight payload or the receipt logs.
2. Scope the "already indexed" check to the order, e.g.
   `Where(paymentorder.TxHashEQ(event.TxHash), paymentorder.ReceiveAddressEQ(event.To))`.
   Alternatively, persist `(tx_hash, log_index)` with a unique index.
3. Change `deleteTransferWebhook` from `.Only()` to the order ID, or to `(txHash, receiveAddress)`.

## Constraint on a PR

The upstream repo is not public right now, so a GitHub PR is not possible. The channels are the
Paycrest Telegram, the security e-mail listed in `sender-mcp/.github/ISSUE_TEMPLATE/config.yml`, or
a Jira ticket (internal). LP to decide.

## Cheapest way to confirm against production

Run the Phase 2 proof with **2 orders × $0.50** in one `sprayToken` tx, and record each order's
status.

- **If order 2 reaches `validated`:** production has fixed the bug, or the webhook race happened
  to win. Repeat to tell which.
- **If order 2 reaches `expired` and then `refunded`:** the bug is confirmed in production.
- **Worst-case cost:** one `transactionFee` plus gas. Order 2's `amount + senderFee` comes back to
  `refundAddress`.
