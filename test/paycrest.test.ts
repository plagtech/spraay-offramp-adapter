// Paycrest provider: envelope parsing, I2/I3 cross-checks on create-order.
import { describe, expect, it } from "vitest";
import { PaycrestProvider, PaycrestContractError } from "../src/providers/paycrest.js";
import type { Recipient } from "../src/providers/types.js";

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", message: "ok", data }), { status: 200 });
}

function provider(routes: Record<string, unknown>): PaycrestProvider {
  return new PaycrestProvider({
    apiUrl: "https://api.test",
    apiKey: "k",
    fetchImpl: async (input: string) => {
      for (const [frag, data] of Object.entries(routes)) {
        if (input.includes(frag)) return ok(data);
      }
      return new Response(JSON.stringify({ status: "error", message: `no route for ${input}` }), { status: 404 });
    },
  });
}

const recipient: Recipient = {
  country: "KE",
  currency: "KES",
  institution: "SAFAKEPC",
  accountIdentifier: "+254712345678",
  accountName: "Jane Doe",
  amountUsdc: "0.5",
  refundAddress: "0x1111111111111111111111111111111111111111",
};

const validUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();

describe("read endpoints", () => {
  it("resolveToken returns the USDC address and decimals", async () => {
    const p = provider({
      "/v2/tokens": [{ symbol: "USDC", network: "base", contractAddress: "0x8335", decimals: 6 }],
    });
    expect(await p.resolveToken("USDC", "base")).toEqual({ address: "0x8335", decimals: 6 });
  });

  it("getSellRate reads data.sell.rate (D7 shape)", async () => {
    const p = provider({
      "/v2/rates/": {
        buy: { rate: "130.57", providerIds: ["x"] },
        sell: { rate: "128.57", providerIds: ["kUMyxKfB"] },
      },
    });
    const r = await p.getSellRate("USDC", "KES", "base", "0.5");
    expect(r.rate).toBe("128.57");
    expect(r.providerIds).toEqual(["kUMyxKfB"]);
  });

  it("listInstitutions parses code/name", async () => {
    const p = provider({
      "/v2/institutions/KES": [{ code: "SAFAKEPC", name: "M-Pesa", type: "mobile_money" }],
    });
    const list = await p.listInstitutions("KES");
    expect(list[0]!.code).toBe("SAFAKEPC");
  });
});

describe("createOrder cross-checks", () => {
  it("accepts an order whose amountToTransfer equals amount+fees", async () => {
    const p = provider({
      "/v2/sender/orders": {
        id: "ord_1",
        status: "initiated",
        amount: "0.5",
        senderFee: "0.01",
        transactionFee: "0.02",
        providerAccount: { receiveAddress: "0xabc", amountToTransfer: "0.53", validUntil },
      },
    });
    const order = await p.createOrder(recipient, "USDC", "base");
    expect(order.id).toBe("ord_1");
    expect(order.amountToTransfer).toBe("0.53");
    expect(order.receiveAddress).toBe("0xabc");
  });

  it("refuses an order whose amountToTransfer disagrees with the breakdown (I2)", async () => {
    const p = provider({
      "/v2/sender/orders": {
        id: "ord_2",
        status: "initiated",
        amount: "0.5",
        senderFee: "0.01",
        transactionFee: "0.02",
        providerAccount: { receiveAddress: "0xabc", amountToTransfer: "0.99", validUntil },
      },
    });
    await expect(p.createOrder(recipient, "USDC", "base")).rejects.toThrow(/disagree|!=/);
  });

  it("refuses sub-6dp precision from Paycrest (I3)", async () => {
    const p = provider({
      "/v2/sender/orders": {
        id: "ord_3",
        status: "initiated",
        amount: "0.5",
        senderFee: "0",
        transactionFee: "0.0000001",
        providerAccount: { receiveAddress: "0xabc", amountToTransfer: "0.5000001", validUntil },
      },
    });
    await expect(p.createOrder(recipient, "USDC", "base")).rejects.toThrow(PaycrestContractError);
  });

  it("refuses a missing providerAccount", async () => {
    const p = provider({
      "/v2/sender/orders": { id: "ord_4", status: "initiated", amount: "0.5" },
    });
    await expect(p.createOrder(recipient, "USDC", "base")).rejects.toThrow(/providerAccount/);
  });
});
