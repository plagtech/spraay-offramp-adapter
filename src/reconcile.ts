// Reconciliation. After a run has broadcast, cross-check two independent views
// of the world against the ledger:
//
//   - On-chain: did the spray tx mine and succeed?
//   - Paycrest: did each order progress to delivered (`validated`) / final
//     (`settled`), or did it end as `expired`/`refunded`?
//
// This is the check that catches the D2 failure mode in production: if the batch
// tx succeeded on-chain but an order sits unprogressed and then expires, that is
// the orders-2..N skip, and reconcile surfaces it per leg rather than hiding it.

import { Ledger } from "./ledger.js";
import type { ConfirmResult } from "./spraay/sign.js";
import type { OfframpProvider } from "./providers/types.js";

export interface ReconcileDeps {
  readonly provider: OfframpProvider;
  readonly ledger: Ledger;
  /** Re-reads an on-chain tx; typically bound to sign.ts confirmBatch. */
  readonly confirm: (txHash: string) => Promise<ConfirmResult>;
}

export interface LegReconciliation {
  readonly idx: number;
  readonly orderId: string | undefined;
  readonly receiveAddress: string | undefined;
  readonly amountToTransfer: string | undefined;
  /** Provider-reported status at reconcile time. */
  readonly orderStatus: string | undefined;
  readonly delivered: boolean;
  readonly endedWithoutDelivery: boolean;
}

export interface ReconcileReport {
  readonly runId: string;
  readonly sprayTxHash: string | undefined;
  readonly sprayMined: boolean;
  readonly spraySuccess: boolean | undefined;
  readonly legs: readonly LegReconciliation[];
  /** True when the batch landed on-chain but at least one order never delivered. */
  readonly possibleSkip: boolean;
}

const DELIVERED = new Set(["validated", "settled"]);
const ENDED_WITHOUT_DELIVERY = new Set(["expired", "refunded", "refunding"]);

export async function reconcileRun(runId: string, deps: ReconcileDeps): Promise<ReconcileReport> {
  const { provider, ledger, confirm } = deps;

  const sprayTx = ledger.getTxs(runId).find((t) => t.kind === "spray");
  let sprayMined = false;
  let spraySuccess: boolean | undefined;
  if (sprayTx) {
    const result = await confirm(sprayTx.txHash);
    sprayMined = result.mined;
    spraySuccess = result.success;
  }

  const legRows = ledger.legs(runId).filter((l) => l.orderId);
  const legs: LegReconciliation[] = [];
  for (const l of legRows) {
    const status = await provider.getOrder(l.orderId!);
    const s = status.status.toLowerCase();
    legs.push({
      idx: l.idx,
      orderId: l.orderId,
      receiveAddress: l.receiveAddress,
      amountToTransfer: l.amountToTransfer,
      orderStatus: status.status,
      delivered: DELIVERED.has(s),
      endedWithoutDelivery: ENDED_WITHOUT_DELIVERY.has(s),
    });
  }

  const possibleSkip =
    sprayMined && spraySuccess === true && legs.some((l) => l.endedWithoutDelivery);

  return {
    runId,
    ...(sprayTx ? { sprayTxHash: sprayTx.txHash } : { sprayTxHash: undefined }),
    sprayMined,
    spraySuccess,
    legs,
    possibleSkip,
  };
}
