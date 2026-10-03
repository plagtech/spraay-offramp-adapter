# spraay-offramp-adapter

> ## 🧪 Beta — seeking testers
>
> The adapter is **built and locally tested** (full test suite green, dry-run
> verified against the live gateway). What's left is the first **mainnet batch**.
>
> **We're looking for Paycrest senders** to run that first real off-ramp with
> their own key and wallet — a few recipients at ~$0.50 each is enough to prove
> the end-to-end flow. If that's you, **[open an issue](https://github.com/plagtech/spraay-offramp-adapter/issues)**
> or **DM [@plagtech](https://x.com/plagtech) on X**.

Non-custodial adapter that off-ramps **USDC on Base** to **mobile money** (M-Pesa
and others) by funding one [Paycrest](https://paycrest.io) sender order per
recipient with a single batched on-chain transaction routed through the
[Spraay](https://spraay.app) gateway.

One `spraay pay` turns a list of recipients into **at most one** `sprayToken`
transaction that funds N Paycrest off-ramp orders at once — while the signing key
never leaves your machine and never signs anything but an ERC-20 `approve` and
the batch itself.

> Status: **Phase 1 (local build) complete.** Mainnet proof (Phase 2) is run by a
> partner holding a Paycrest sender key; this repo does not ship or require one.

## How it works

```
recipients.csv
   │
   ▼
[1] compliance gate     embargo + phone/ISO + sanctions screening (fail-closed)
[2] resolve token       assert Paycrest USDC == USDC on Base
[3] create orders       one Paycrest order per allowed recipient (unique receive address)
[4] timing + status     every order `initiated` and inside validUntil + margin, else abort
[5] gateway execute     POST /api/v1/batch/execute (x402-paid) → ONE unsigned sprayToken tx
[6] price check         gateway total must equal the sum of amountToTransfer
[7] decode before sign  ABI-decode the tx; prove it matches the confirmed legs exactly
[8] balance + approve   approve EXACTLY the fee-inclusive amount (never recomputed)
[9] broadcast + confirm record the hash before confirming; a timeout is "recheck", not "failed"
```

Tracking and recovery run off a durable SQLite ledger; a Paycrest webhook
(HMAC-verified) and a status poller record each order's lifecycle, and
`reconcile` cross-checks the on-chain batch against each order's Paycrest status.

## Install

```sh
npm install
npm run build
```

Requires **Node ≥ 22.5** (for the built-in `node:sqlite` — see
[Stack notes](#stack-notes)).

## Configure

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored and secrets
are read only from the environment — never logged, never persisted.

| Variable | Needed for | Purpose |
|---|---|---|
| `PAYCREST_API_KEY` | execute | Your own Paycrest sender key (`API-Key` header) |
| `PAYCREST_API_SECRET` | webhook | HMAC secret to verify Paycrest webhooks |
| `SPRAAY_WALLET_PRIVATE_KEY` | execute | Operator key; signs only `approve` + `sprayToken` |
| `BASE_RPC_URL` | execute | Base mainnet RPC |
| `WEBHOOK_URL`, `WEBHOOK_PORT` | tracking | Where Paycrest posts order events |

A **dry-run needs no secrets** — it only reads public endpoints.

## Usage

```sh
# Plan only: compliance + token resolution, no orders, no signing, no key.
node dist/cli.js pay --file examples/recipients.csv --dry-run

# Execute: create orders, build one batch, approve, sign, broadcast.
node dist/cli.js pay --file examples/recipients.csv --execute
```

Flags: `--margin-min <n>` (validUntil head-room, default 10), `--run-id <id>`
(resume an interrupted run idempotently), `--ledger <path>` (default
`data/ledger.sqlite`).

CSV columns: `country, currency, institution, accountIdentifier, accountName,
amountUsdc, refundAddress`. Institution codes come from
`GET /v2/institutions/<currency>` — never guessed (KES M-Pesa is `SAFAKEPC`).

## Safety invariants

Each is covered by a regression test in `test/`:

- **I1** — never broadcast unless every order is `initiated` and inside `validUntil`.
- **I2** — never recompute the approval; use `approvalRequired.amount` verbatim.
- **I3** — money crosses to raw units once, via BigInt; refuse > 6 decimals from Paycrest.
- **I4** — a broadcast that errors is not a disproven batch; the hash is recorded
  first and a second broadcast for the same run is refused (no double spend).
- **I5** — per-recipient failure isolation; a denied leg never blocks the others.
- **I6** — non-custodial: the key signs only `approve` and `sprayToken`.
- **I7** — decode before sign: the unsigned tx is ABI-decoded and matched to the
  confirmed legs (contract, token, exact per-address amounts) before signing.

## Testing

```sh
npm test          # vitest, 43 tests
npm run typecheck  # tsc --noEmit
```

## Stack notes

- **Chain / x402.** ethers v6 plus the scoped `@x402/fetch` + `@x402/evm` v2
  client (CAIP-2 `eip155:8453`), carried over from the proven `vmflow-spraay`
  worker. The unscoped `x402-fetch` cannot speak protocol v2 and is not used.
- **Ledger.** The ledger uses Node's built-in `node:sqlite` rather than the
  native `better-sqlite3`: this build environment (Node 24, no C++ toolchain)
  cannot compile native modules, and `node:sqlite` needs none while giving the
  same synchronous API.

## License

MIT.
