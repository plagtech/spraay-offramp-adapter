// Durable ledger, backed by Node's built-in SQLite (node:sqlite).
//
// Stack note: the brief named better-sqlite3, but this environment (Node 24, no
// C++ build chain) cannot compile native modules. node:sqlite is built in, needs
// no toolchain, and gives the same synchronous API. See PHASE0-RECON deviation.
//
// The ledger is the source of truth for idempotency. A run and its legs and
// created orders are written BEFORE any broadcast, so an interrupted run can be
// resumed without re-creating orders or paying twice (I4).

import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type { WebhookEvent, WebhookLedger } from "./providers/paycrest-webhook.js";

// Load the built-in via createRequire rather than a static `import`. The runtime
// behaviour is identical, but it keeps bundlers/test transformers (vite) from
// trying to resolve "node:sqlite" as a package and failing.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

export type RunMode = "dry-run" | "execute";
export type RunStatus = "planning" | "orders-created" | "broadcast" | "confirmed" | "failed";

export interface LegRecord {
  readonly runId: string;
  readonly idx: number;
  readonly country: string;
  readonly currency: string;
  readonly institution: string;
  readonly accountIdentifier: string;
  readonly accountName: string;
  readonly amountUsdc: string;
  readonly refundAddress: string;
  readonly complianceAllowed: boolean;
  readonly complianceReasons: string;
  orderId?: string;
  receiveAddress?: string;
  amountToTransfer?: string;
  validUntil?: string;
  status?: string;
}

export class Ledger implements WebhookLedger {
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legs (
        run_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        country TEXT NOT NULL,
        currency TEXT NOT NULL,
        institution TEXT NOT NULL,
        account_identifier TEXT NOT NULL,
        account_name TEXT NOT NULL,
        amount_usdc TEXT NOT NULL,
        refund_address TEXT NOT NULL,
        compliance_allowed INTEGER NOT NULL,
        compliance_reasons TEXT NOT NULL,
        order_id TEXT,
        receive_address TEXT,
        amount_to_transfer TEXT,
        valid_until TEXT,
        status TEXT,
        PRIMARY KEY (run_id, idx)
      );
      CREATE TABLE IF NOT EXISTS txs (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, kind, tx_hash)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        order_id TEXT,
        event TEXT NOT NULL,
        kind TEXT,
        status TEXT,
        raw TEXT NOT NULL
      );
    `);
  }

  /** Idempotent: a resumed run reuses its existing row rather than erroring. */
  createRun(id: string, mode: RunMode): void {
    this.db
      .prepare("INSERT OR IGNORE INTO runs (id, created_at, mode, status) VALUES (?, ?, ?, 'planning')")
      .run(id, new Date().toISOString(), mode);
  }

  setRunStatus(id: string, status: RunStatus): void {
    this.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
  }

  getRunStatus(id: string): RunStatus | undefined {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as
      | { status: RunStatus }
      | undefined;
    return row?.status;
  }

  recordLeg(leg: LegRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO legs
         (run_id, idx, country, currency, institution, account_identifier, account_name,
          amount_usdc, refund_address, compliance_allowed, compliance_reasons,
          order_id, receive_address, amount_to_transfer, valid_until, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        leg.runId,
        leg.idx,
        leg.country,
        leg.currency,
        leg.institution,
        leg.accountIdentifier,
        leg.accountName,
        leg.amountUsdc,
        leg.refundAddress,
        leg.complianceAllowed ? 1 : 0,
        leg.complianceReasons,
        leg.orderId ?? null,
        leg.receiveAddress ?? null,
        leg.amountToTransfer ?? null,
        leg.validUntil ?? null,
        leg.status ?? null,
      );
  }

  /** Legs already assigned an order id for this run — used to resume idempotently. */
  legsWithOrders(runId: string): LegRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM legs WHERE run_id = ? AND order_id IS NOT NULL ORDER BY idx")
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToLeg);
  }

  recordTx(runId: string, kind: "approve" | "spray", txHash: string, status: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO txs (run_id, kind, tx_hash, status, created_at) VALUES (?,?,?,?,?)",
      )
      .run(runId, kind, txHash, status, new Date().toISOString());
  }

  /** Has a spray tx already been broadcast for this run? Guards against double spend. */
  hasBroadcastSpray(runId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM txs WHERE run_id = ? AND kind = 'spray'")
      .get(runId) as { n: number };
    return row.n > 0;
  }

  /** All txs recorded for a run, newest first per (kind, hash). */
  getTxs(runId: string): Array<{ kind: string; txHash: string; status: string }> {
    const rows = this.db
      .prepare("SELECT kind, tx_hash, status FROM txs WHERE run_id = ? ORDER BY created_at")
      .all(runId) as Array<{ kind: string; tx_hash: string; status: string }>;
    return rows.map((r) => ({ kind: r.kind, txHash: r.tx_hash, status: r.status }));
  }

  /** All legs for a run, in order. */
  legs(runId: string): LegRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM legs WHERE run_id = ? ORDER BY idx")
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToLeg);
  }

  recordWebhookEvent(event: WebhookEvent): void {
    this.db
      .prepare("INSERT INTO events (received_at, order_id, event, kind, status, raw) VALUES (?,?,?,?,?,?)")
      .run(
        new Date().toISOString(),
        event.orderId ?? null,
        event.event,
        event.kind ?? null,
        event.status ?? null,
        JSON.stringify(event.raw),
      );
  }

  close(): void {
    this.db.close();
  }
}

function rowToLeg(row: Record<string, unknown>): LegRecord {
  return {
    runId: String(row["run_id"]),
    idx: Number(row["idx"]),
    country: String(row["country"]),
    currency: String(row["currency"]),
    institution: String(row["institution"]),
    accountIdentifier: String(row["account_identifier"]),
    accountName: String(row["account_name"]),
    amountUsdc: String(row["amount_usdc"]),
    refundAddress: String(row["refund_address"]),
    complianceAllowed: Number(row["compliance_allowed"]) === 1,
    complianceReasons: String(row["compliance_reasons"]),
    ...(row["order_id"] != null ? { orderId: String(row["order_id"]) } : {}),
    ...(row["receive_address"] != null ? { receiveAddress: String(row["receive_address"]) } : {}),
    ...(row["amount_to_transfer"] != null ? { amountToTransfer: String(row["amount_to_transfer"]) } : {}),
    ...(row["valid_until"] != null ? { validUntil: String(row["valid_until"]) } : {}),
    ...(row["status"] != null ? { status: String(row["status"]) } : {}),
  };
}
