#!/usr/bin/env node
// CLI: spraay-offramp-adapter pay --file recipients.csv [--dry-run | --execute]
//
// Dry-run (default) runs compliance + token resolution and prints the plan; it
// creates no orders, signs nothing, needs no key. --execute creates Paycrest
// orders, builds one batch via the gateway, and signs + broadcasts with the
// operator key. We never call process.exit on the success path — the ledger and
// RPC provider are closed first so no socket is cut mid-flight.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, loadReadonlyConfig, MAX_USD_PER_GATEWAY_PAYMENT } from "./config.js";
import { ComplianceGate, NoopScreener } from "./compliance/gate.js";
import { Ledger } from "./ledger.js";
import { PaycrestProvider } from "./providers/paycrest.js";
import { executeRun, type BatchGateway, type ChainSigner, type RunResult } from "./run.js";
import { executeBatch, makePayingFetch, type BatchRequest } from "./spraay/gateway.js";
import {
  broadcastBatch,
  confirmBatch,
  ensureAllowance,
  makeSigner,
  usdcBalance,
} from "./spraay/sign.js";
import type { Recipient } from "./providers/types.js";

interface Args {
  file: string;
  mode: "dry-run" | "execute";
  marginMin: number | undefined;
  runId: string | undefined;
  ledgerPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  if (argv[0] !== "pay") {
    throw new Error("usage: spraay-offramp-adapter pay --file <recipients.csv> [--dry-run|--execute]");
  }
  let file: string | undefined;
  let mode: "dry-run" | "execute" = "dry-run";
  let marginMin: number | undefined;
  let runId: string | undefined;
  let ledgerPath = "data/ledger.sqlite";

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--file":
        file = argv[++i];
        break;
      case "--dry-run":
        mode = "dry-run";
        break;
      case "--execute":
        mode = "execute";
        break;
      case "--margin-min":
        marginMin = Number(argv[++i]);
        break;
      case "--run-id":
        runId = argv[++i];
        break;
      case "--ledger":
        ledgerPath = argv[++i] ?? ledgerPath;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!file) throw new Error("--file <recipients.csv> is required");
  if (marginMin !== undefined && (!Number.isFinite(marginMin) || marginMin < 0)) {
    throw new Error(`--margin-min must be a non-negative number`);
  }
  return { file, mode, marginMin, runId, ledgerPath };
}

/** Parse one CSV line with minimal double-quote support (for names with commas). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const REQUIRED_COLUMNS = [
  "country",
  "currency",
  "institution",
  "accountIdentifier",
  "accountName",
  "amountUsdc",
  "refundAddress",
] as const;

function readRecipientsCsv(path: string): Recipient[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error(`${path}: need a header row and at least one recipient`);

  const header = parseCsvLine(lines[0]!);
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) throw new Error(`${path}: missing required column "${col}"`);
  }
  const index = (col: string) => header.indexOf(col);

  const recipients: Recipient[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = parseCsvLine(lines[r]!);
    const get = (col: string) => cells[index(col)] ?? "";
    recipients.push({
      country: get("country"),
      currency: get("currency"),
      institution: get("institution"),
      accountIdentifier: get("accountIdentifier"),
      accountName: get("accountName"),
      amountUsdc: get("amountUsdc"),
      refundAddress: get("refundAddress"),
    });
  }
  return recipients;
}

function printResult(result: RunResult): void {
  console.log(`\nRun ${result.runId} (${result.mode})`);
  console.log(`  recipients: ${result.legs.length}, allowed: ${result.allowedCount}`);
  for (const leg of result.legs) {
    const tag = leg.allowed ? "ALLOW" : "DENY ";
    console.log(`  [${tag}] #${leg.idx} ${leg.recipient.accountName} ${leg.recipient.amountUsdc} USDC`);
    if (!leg.allowed) console.log(`         ${leg.reasons.join("; ")}`);
  }
  if (result.aborted) console.log(`  ABORTED: ${result.aborted}`);
  if (result.approveTxHash) console.log(`  approve tx: ${result.approveTxHash}`);
  if (result.sprayTxHash) console.log(`  spray tx:   ${result.sprayTxHash}`);
  if (result.confirmation) {
    const c = result.confirmation;
    console.log(`  confirmed:  mined=${c.mined} success=${c.success ?? "pending"}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const recipients = readRecipientsCsv(args.file);

  mkdirSync(dirname(args.ledgerPath), { recursive: true });
  const ledger = new Ledger(args.ledgerPath);
  const runId = args.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const gate = new ComplianceGate(new NoopScreener());
  console.warn(
    "WARNING: using NoopScreener — no sanctions screening is performed. " +
      "Supply a real SanctionsScreener before production use.",
  );

  const runOpts = {
    runId,
    mode: args.mode,
    recipients,
    ...(args.marginMin !== undefined ? { validityMarginMs: args.marginMin * 60 * 1000 } : {}),
  };

  if (args.mode === "dry-run") {
    const cfg = loadReadonlyConfig();
    const provider = new PaycrestProvider({ apiUrl: cfg.paycrestApiUrl, apiKey: cfg.paycrestApiKey });
    const unavailable = "dependency not available in dry-run";
    const gateway: BatchGateway = {
      execute() {
        throw new Error(unavailable);
      },
    };
    const signer: ChainSigner = {
      address: "0x0000000000000000000000000000000000000000",
      usdcBalance() {
        throw new Error(unavailable);
      },
      ensureAllowance() {
        throw new Error(unavailable);
      },
      broadcast() {
        throw new Error(unavailable);
      },
      confirm() {
        throw new Error(unavailable);
      },
    };
    try {
      const result = await executeRun(runOpts, { provider, gate, ledger, gateway, signer });
      printResult(result);
    } finally {
      ledger.close();
    }
    return;
  }

  // execute mode
  const cfg = loadConfig();
  const provider = new PaycrestProvider({ apiUrl: cfg.paycrestApiUrl, apiKey: cfg.paycrestApiKey });
  const signerCtx = await makeSigner(cfg.walletPrivateKey, cfg.rpcUrl);
  const payingFetch = await makePayingFetch(signerCtx.wallet, MAX_USD_PER_GATEWAY_PAYMENT);

  const gateway: BatchGateway = {
    execute: (request: BatchRequest) => executeBatch(payingFetch, cfg.gatewayUrl, request),
  };
  const signer: ChainSigner = {
    address: signerCtx.address,
    usdcBalance: (token) => usdcBalance(signerCtx, token),
    ensureAllowance: (token, spender, requiredRaw) =>
      ensureAllowance(signerCtx, token, spender, requiredRaw),
    broadcast: (tx) => broadcastBatch(signerCtx, tx),
    confirm: (txHash) => confirmBatch(signerCtx, txHash),
  };

  try {
    const result = await executeRun(runOpts, { provider, gate, ledger, gateway, signer });
    printResult(result);
  } finally {
    ledger.close();
    signerCtx.provider.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
