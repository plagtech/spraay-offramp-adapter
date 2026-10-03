// Orchestrator. Turns a list of recipients into (at most) one on-chain batch
// that funds one Paycrest off-ramp order per recipient.
//
// Steps:
//   1. Compliance-gate every recipient; denied legs are recorded and skipped.
//   2. Resolve + assert the token is USDC on Base.
//   3. (dry-run stops here) Create one Paycrest order per allowed leg.
//   4. Abort if any order's validUntil is too close (U-P3 margin).
//   5. Ask the gateway to build one unsigned sprayToken tx for all legs.
//   6. Assert the gateway priced exactly our total (gateway contract check).
//   7. Decode the unsigned tx and prove it matches the confirmed legs (I7).
//   8. Check balance, approve the exact fee-inclusive amount.
//   9. Broadcast, record the hash BEFORE confirming, then confirm (I4).
//
// Gateway and signer are injected interfaces so the whole flow is testable
// without a live chain or a funded key.

import { BASE_USDC, SPRAY_CONTRACT } from "./config.js";
import { ComplianceGate } from "./compliance/gate.js";
import { Ledger } from "./ledger.js";
import { assertTxMatchesLegs, type ConfirmedLeg } from "./spraay/decode.js";
import type {
  ApprovalRequired,
  BatchRequest,
  ExecuteResponse,
  UnsignedBatchTx,
} from "./spraay/gateway.js";
import { assertBatchMatches, totalWithFeeRaw } from "./spraay/gateway.js";
import type { ApproveResult, BroadcastResult, ConfirmResult } from "./spraay/sign.js";
import type { OfframpOrder, OfframpProvider, Recipient } from "./providers/types.js";
import { usdcToRaw } from "./units.js";

/** Minimum head-room on every order's validUntil before we broadcast (U-P3). */
export const DEFAULT_VALIDITY_MARGIN_MS = 10 * 60 * 1000;

export interface BatchGateway {
  execute(request: BatchRequest): Promise<ExecuteResponse>;
}

export interface ChainSigner {
  readonly address: string;
  usdcBalance(token: string): Promise<bigint>;
  ensureAllowance(token: string, spender: string, requiredRaw: bigint): Promise<ApproveResult>;
  broadcast(tx: UnsignedBatchTx): Promise<BroadcastResult>;
  confirm(txHash: string): Promise<ConfirmResult>;
}

export interface RunOptions {
  readonly runId: string;
  readonly mode: "dry-run" | "execute";
  readonly recipients: readonly Recipient[];
  readonly token?: string;
  readonly network?: string;
  readonly validityMarginMs?: number;
  readonly now?: () => Date;
}

export interface RunDeps {
  readonly provider: OfframpProvider;
  readonly gate: ComplianceGate;
  readonly ledger: Ledger;
  readonly gateway: BatchGateway;
  readonly signer: ChainSigner;
}

export interface LegOutcome {
  readonly idx: number;
  readonly recipient: Recipient;
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  readonly order?: OfframpOrder;
}

export interface RunResult {
  readonly runId: string;
  readonly mode: "dry-run" | "execute";
  readonly legs: readonly LegOutcome[];
  readonly allowedCount: number;
  readonly approveTxHash?: string;
  readonly sprayTxHash?: string;
  readonly confirmation?: ConfirmResult;
  readonly aborted?: string;
}

/** Thrown for a hard stop that is not a per-leg skip (double spend, timing, mismatch). */
export class RunAbort extends Error {}

export async function executeRun(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const token = opts.token ?? "USDC";
  const network = opts.network ?? "base";
  const marginMs = opts.validityMarginMs ?? DEFAULT_VALIDITY_MARGIN_MS;
  const now = opts.now ?? (() => new Date());
  const { provider, gate, ledger, gateway, signer } = deps;

  ledger.createRun(opts.runId, opts.mode);

  // Step 1 — compliance gate.
  const outcomes: LegOutcome[] = [];
  for (let idx = 0; idx < opts.recipients.length; idx++) {
    const recipient = opts.recipients[idx]!;
    const decision = await gate.check(recipient);
    ledger.recordLeg({
      runId: opts.runId,
      idx,
      country: recipient.country,
      currency: recipient.currency,
      institution: recipient.institution,
      accountIdentifier: recipient.accountIdentifier,
      accountName: recipient.accountName,
      amountUsdc: recipient.amountUsdc,
      refundAddress: recipient.refundAddress,
      complianceAllowed: decision.allowed,
      complianceReasons: decision.reasons.join("; "),
      status: decision.allowed ? "allowed" : "denied",
    });
    outcomes.push({ idx, recipient, allowed: decision.allowed, reasons: decision.reasons });
  }

  const allowed = outcomes.filter((o) => o.allowed);
  if (allowed.length === 0) {
    ledger.setRunStatus(opts.runId, "confirmed");
    return { runId: opts.runId, mode: opts.mode, legs: outcomes, allowedCount: 0 };
  }

  // Step 2 — resolve + assert token.
  const resolved = await provider.resolveToken(token, network);
  if (resolved.address.toLowerCase() !== BASE_USDC.toLowerCase()) {
    throw new RunAbort(
      `provider token ${resolved.address} != expected USDC on Base ${BASE_USDC}`,
    );
  }

  // Step 3 — dry-run stops before any external write.
  if (opts.mode === "dry-run") {
    return { runId: opts.runId, mode: opts.mode, legs: outcomes, allowedCount: allowed.length };
  }

  // Step 3 (execute) — create one order per allowed leg, idempotently.
  const existing = new Map(ledger.legsWithOrders(opts.runId).map((l) => [l.idx, l]));
  for (const o of allowed) {
    if (existing.has(o.idx)) continue; // resume: order already created
    const order = await provider.createOrder(o.recipient, token, network);
    ledger.recordLeg({
      runId: opts.runId,
      idx: o.idx,
      country: o.recipient.country,
      currency: o.recipient.currency,
      institution: o.recipient.institution,
      accountIdentifier: o.recipient.accountIdentifier,
      accountName: o.recipient.accountName,
      amountUsdc: o.recipient.amountUsdc,
      refundAddress: o.recipient.refundAddress,
      complianceAllowed: true,
      complianceReasons: o.reasons.join("; "),
      orderId: order.id,
      receiveAddress: order.receiveAddress,
      amountToTransfer: order.amountToTransfer,
      validUntil: order.validUntil.toISOString(),
      status: order.status,
    });
    (o as { order?: OfframpOrder }).order = order;
  }
  // Re-read orders (covers both freshly created and resumed).
  const orders = new Map<
    number,
    { receiveAddress: string; amountToTransfer: string; validUntil: Date; status: string }
  >();
  for (const o of allowed) {
    if (o.order) {
      orders.set(o.idx, {
        receiveAddress: o.order.receiveAddress,
        amountToTransfer: o.order.amountToTransfer,
        validUntil: o.order.validUntil,
        status: o.order.status,
      });
    } else {
      const l = existing.get(o.idx)!;
      orders.set(o.idx, {
        receiveAddress: l.receiveAddress!,
        amountToTransfer: l.amountToTransfer!,
        validUntil: new Date(l.validUntil!),
        status: l.status ?? "unknown",
      });
    }
  }
  ledger.setRunStatus(opts.runId, "orders-created");

  // Step 4 — I1: never broadcast unless every order is `initiated` and inside
  // its validUntil, with enough head-room to build + confirm.
  const deadline = now().getTime() + marginMs;
  for (const [idx, ord] of orders) {
    if (ord.status !== "initiated") {
      const msg = `order for leg ${idx} has status "${ord.status}", not "initiated"; refusing to broadcast (I1). Reconcile this run instead.`;
      ledger.setRunStatus(opts.runId, "failed");
      return { runId: opts.runId, mode: opts.mode, legs: outcomes, allowedCount: allowed.length, aborted: msg };
    }
    if (ord.validUntil.getTime() < deadline) {
      const msg = `order for leg ${idx} expires at ${ord.validUntil.toISOString()}, within the ${marginMs}ms margin; aborting before any funds move`;
      ledger.setRunStatus(opts.runId, "failed");
      return { runId: opts.runId, mode: opts.mode, legs: outcomes, allowedCount: allowed.length, aborted: msg };
    }
  }

  // Double-spend guard (I4): never build a second batch for a run that already broadcast.
  if (ledger.hasBroadcastSpray(opts.runId)) {
    throw new RunAbort(
      `run ${opts.runId} already has a broadcast spray tx; refusing to re-broadcast. Reconcile instead.`,
    );
  }

  // Step 5 — build the batch and ask the gateway for one unsigned tx.
  const confirmedLegs: ConfirmedLeg[] = [];
  const recipientsAddrs: string[] = [];
  const amountsRaw: string[] = [];
  let expectedTotalRaw = 0n;
  for (const o of allowed) {
    const ord = orders.get(o.idx)!;
    const raw = usdcToRaw(ord.amountToTransfer);
    confirmedLegs.push({ receiveAddress: ord.receiveAddress, amountRaw: raw });
    recipientsAddrs.push(ord.receiveAddress);
    amountsRaw.push(raw.toString());
    expectedTotalRaw += raw;
  }

  const request: BatchRequest = {
    token: "USDC",
    recipients: recipientsAddrs,
    amounts: amountsRaw,
    sender: signer.address,
  };
  const response = await gateway.execute(request);

  // Step 6 — the gateway must have priced exactly our total.
  assertBatchMatches(response, expectedTotalRaw);

  // Step 7 — decode the unsigned tx and prove it matches the confirmed legs (I7).
  assertTxMatchesLegs(response.transaction, confirmedLegs);

  // Step 8 — balance + exact approve.
  const required = totalWithFeeRaw(response);
  const balance = await signer.usdcBalance(BASE_USDC);
  if (balance < required) {
    throw new RunAbort(`insufficient USDC: have ${balance} raw, need ${required} raw`);
  }
  const spender = approvalSpender(response.approvalRequired);
  const approve = await signer.ensureAllowance(BASE_USDC, spender, required);
  if (approve.approved && approve.txHash) {
    ledger.recordTx(opts.runId, "approve", approve.txHash, "confirmed");
  }

  // Step 9 — broadcast, record BEFORE confirming, then confirm (I4).
  const broadcast = await signer.broadcast(response.transaction);
  ledger.recordTx(opts.runId, "spray", broadcast.txHash, broadcast.status);
  ledger.setRunStatus(opts.runId, "broadcast");

  const confirmation = await signer.confirm(broadcast.txHash);
  if (confirmation.mined && confirmation.success) {
    ledger.recordTx(opts.runId, "spray", broadcast.txHash, "confirmed");
    ledger.setRunStatus(opts.runId, "confirmed");
  } else if (!confirmation.mined) {
    ledger.recordTx(opts.runId, "spray", broadcast.txHash, "unconfirmed");
    // Not failed — recheck later via reconcile.
  } else {
    ledger.recordTx(opts.runId, "spray", broadcast.txHash, "reverted");
    ledger.setRunStatus(opts.runId, "failed");
  }

  return {
    runId: opts.runId,
    mode: opts.mode,
    legs: outcomes,
    allowedCount: allowed.length,
    ...(approve.txHash ? { approveTxHash: approve.txHash } : {}),
    sprayTxHash: broadcast.txHash,
    confirmation,
  };
}

/** The address allowed to pull USDC: the gateway's spender, asserted to be the Spray contract. */
function approvalSpender(approval: ApprovalRequired | undefined): string {
  if (!approval) return SPRAY_CONTRACT;
  if (approval.spender.toLowerCase() !== SPRAY_CONTRACT.toLowerCase()) {
    throw new RunAbort(
      `approvalRequired.spender ${approval.spender} is not the Spray contract ${SPRAY_CONTRACT}`,
    );
  }
  return approval.spender;
}
