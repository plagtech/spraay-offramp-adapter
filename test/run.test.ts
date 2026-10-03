// Orchestrator invariants: I1 (timing/status), I2 (approval verbatim),
// I4 (double-spend guard), I5 (per-order isolation), I7 (decode mismatch aborts).
import { describe, expect, it, beforeEach } from "vitest";
import { Interface, getAddress } from "ethers";
import { BASE_CHAIN_ID, BASE_USDC, SPRAY_CONTRACT } from "../src/config.js";
import { ComplianceGate, NoopScreener } from "../src/compliance/gate.js";
import { Ledger } from "../src/ledger.js";
import { executeRun, RunAbort, type BatchGateway, type ChainSigner, type RunDeps } from "../src/run.js";
import type { ExecuteResponse, UnsignedBatchTx } from "../src/spraay/gateway.js";
import type { OfframpOrder, OfframpProvider, Recipient } from "../src/providers/types.js";
import { usdcToRaw } from "../src/units.js";

const iface = new Interface([
  "function sprayToken(address token, (address recipient, uint256 amount)[] recipients)",
]);

const RECEIVE = [
  getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
];

function recipient(over: Partial<Recipient> = {}): Recipient {
  return {
    country: "KE",
    currency: "KES",
    institution: "SAFAKEPC",
    accountIdentifier: "+254712345678",
    accountName: "Jane Doe",
    amountUsdc: "0.5",
    refundAddress: "0x1111111111111111111111111111111111111111",
    ...over,
  };
}

/** Fake provider: mints a deterministic receive address per order, no fees. */
function fakeProvider(opts: { status?: string; validMinutes?: number } = {}): OfframpProvider {
  let n = 0;
  return {
    name: "fake",
    async resolveToken() {
      return { address: BASE_USDC, decimals: 6 };
    },
    async listInstitutions() {
      return [{ code: "SAFAKEPC", name: "M-Pesa", type: "mobile_money" }];
    },
    async getSellRate() {
      return { rate: "128.57", token: "USDC", currency: "KES", providerIds: ["p"] };
    },
    async createOrder(r: Recipient): Promise<OfframpOrder> {
      const idx = n++;
      const validUntil = new Date(Date.now() + (opts.validMinutes ?? 30) * 60 * 1000);
      return {
        id: `ord_${idx}`,
        receiveAddress: RECEIVE[idx]!,
        amountToTransfer: r.amountUsdc,
        amount: r.amountUsdc,
        senderFee: "0",
        transactionFee: "0",
        validUntil,
        status: opts.status ?? "initiated",
        recipient: r,
        raw: {},
      };
    },
    async getOrder(id: string) {
      return { id, status: "validated", raw: {} };
    },
  };
}

/** Fake gateway: echoes the request into a well-formed, matching execute response. */
function fakeGateway(tamperAmount = false): BatchGateway {
  return {
    async execute(request): Promise<ExecuteResponse> {
      let total = 0n;
      for (const a of request.amounts) total += BigInt(a);
      const recipients = request.recipients.map((r, i) => ({
        recipient: getAddress(r),
        amount: tamperAmount && i === 0 ? BigInt(request.amounts[i]!) + 1n : BigInt(request.amounts[i]!),
      }));
      const data = iface.encodeFunctionData("sprayToken", [BASE_USDC, recipients]);
      const transaction: UnsignedBatchTx = {
        to: SPRAY_CONTRACT,
        data,
        value: "0x0",
        chainId: Number(BASE_CHAIN_ID),
        gasLimit: "0x5208",
      };
      // totalAmount in human decimals; approvalRequired.amount in raw.
      const totalDecimal = (Number(total) / 1e6).toFixed(6);
      return {
        transaction,
        batch: { totalAmount: totalDecimal, fee: "0", feePercent: "0.3", totalWithFee: totalDecimal },
        approvalRequired: { token: BASE_USDC, spender: SPRAY_CONTRACT, amount: total.toString() },
        raw: {},
      };
    },
  };
}

interface Spy {
  approveArgs: Array<{ spender: string; required: bigint }>;
  broadcasts: number;
}

function fakeSigner(spy: Spy, confirm: { mined: boolean; success: boolean } = { mined: true, success: true }): ChainSigner {
  return {
    address: "0x9999999999999999999999999999999999999999",
    async usdcBalance() {
      return 10n ** 18n; // plenty
    },
    async ensureAllowance(_token, spender, requiredRaw) {
      spy.approveArgs.push({ spender, required: requiredRaw });
      return { approved: true, txHash: "0xapprove", allowanceBefore: 0n };
    },
    async broadcast() {
      spy.broadcasts++;
      return { txHash: "0xspray", status: "unconfirmed" };
    },
    async confirm() {
      return { txHash: "0xspray", mined: confirm.mined, success: confirm.success, receipt: null };
    },
  };
}

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(":memory:");
});

function deps(over: Partial<RunDeps>): RunDeps {
  return {
    provider: fakeProvider(),
    gate: new ComplianceGate(new NoopScreener()),
    ledger,
    gateway: fakeGateway(),
    signer: fakeSigner({ approveArgs: [], broadcasts: 0 }),
    ...over,
  };
}

describe("executeRun", () => {
  it("I5: a denied leg is isolated and does not block allowed legs", async () => {
    const spy: Spy = { approveArgs: [], broadcasts: 0 };
    const recipients = [
      recipient({ accountName: "Allowed One" }),
      recipient({ country: "IR", accountIdentifier: "0712345678", accountName: "Embargoed" }),
      recipient({ accountName: "Allowed Two", accountIdentifier: "+254722000000" }),
    ];
    const result = await executeRun(
      { runId: "r1", mode: "execute", recipients },
      deps({ signer: fakeSigner(spy) }),
    );
    expect(result.allowedCount).toBe(2);
    expect(result.legs.find((l) => !l.allowed)?.recipient.accountName).toBe("Embargoed");
    expect(result.sprayTxHash).toBe("0xspray");
    expect(spy.broadcasts).toBe(1);
  });

  it("I2: approves exactly approvalRequired.amount, never recomputed", async () => {
    const spy: Spy = { approveArgs: [], broadcasts: 0 };
    await executeRun(
      { runId: "r2", mode: "execute", recipients: [recipient()] },
      deps({ signer: fakeSigner(spy) }),
    );
    expect(spy.approveArgs).toHaveLength(1);
    expect(spy.approveArgs[0]!.required).toBe(usdcToRaw("0.5"));
    expect(spy.approveArgs[0]!.spender).toBe(SPRAY_CONTRACT);
  });

  it("I1: aborts without broadcasting when an order is too close to expiry", async () => {
    const spy: Spy = { approveArgs: [], broadcasts: 0 };
    const result = await executeRun(
      { runId: "r3", mode: "execute", recipients: [recipient()], validityMarginMs: 60 * 60 * 1000 },
      deps({ provider: fakeProvider({ validMinutes: 5 }), signer: fakeSigner(spy) }),
    );
    expect(result.aborted).toMatch(/expires|margin/);
    expect(spy.broadcasts).toBe(0);
  });

  it("I1: aborts when an order is not in `initiated` status", async () => {
    const spy: Spy = { approveArgs: [], broadcasts: 0 };
    const result = await executeRun(
      { runId: "r4", mode: "execute", recipients: [recipient()] },
      deps({ provider: fakeProvider({ status: "pending" }), signer: fakeSigner(spy) }),
    );
    expect(result.aborted).toMatch(/initiated/);
    expect(spy.broadcasts).toBe(0);
  });

  it("I7: aborts when the gateway tx does not match the confirmed legs", async () => {
    await expect(
      executeRun({ runId: "r5", mode: "execute", recipients: [recipient()] }, deps({ gateway: fakeGateway(true) })),
    ).rejects.toThrow(/refusing to sign|amount/);
  });

  it("I4: refuses to re-broadcast a run that already broadcast a spray tx", async () => {
    const d = deps({});
    await executeRun({ runId: "r6", mode: "execute", recipients: [recipient()] }, d);
    // Second invocation with the same runId + ledger must hit the double-spend guard.
    await expect(
      executeRun({ runId: "r6", mode: "execute", recipients: [recipient()] }, d),
    ).rejects.toBeInstanceOf(RunAbort);
  });

  it("dry-run creates no orders and never broadcasts", async () => {
    const spy: Spy = { approveArgs: [], broadcasts: 0 };
    const result = await executeRun(
      { runId: "r7", mode: "dry-run", recipients: [recipient()] },
      deps({ signer: fakeSigner(spy) }),
    );
    expect(result.mode).toBe("dry-run");
    expect(result.allowedCount).toBe(1);
    expect(result.sprayTxHash).toBeUndefined();
    expect(spy.broadcasts).toBe(0);
  });
});
