// Webhook HMAC verification and event classification.
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  isDelivered,
  isRefundedOrExpired,
  isSettled,
  parseWebhookEvent,
  verifyWebhookSignature,
} from "../src/providers/paycrest-webhook.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "payment_order.validated", data: { id: "ord_1", status: "validated" } });

  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("trims and lowercases the header", () => {
    expect(verifyWebhookSignature(body, `  ${sign(body).toUpperCase()}  `, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(body);
    const tampered = body.replace("ord_1", "ord_2");
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a wrong secret, missing header, and non-hex", () => {
    expect(verifyWebhookSignature(body, sign(body), "other")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "nothex!!", SECRET)).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("extracts event, kind, orderId, status", () => {
    const e = parseWebhookEvent(
      JSON.stringify({ event: "payment_order.settled", data: { id: "ord_9", status: "settled" } }),
    );
    expect(e.event).toBe("payment_order.settled");
    expect(e.kind).toBe("settled");
    expect(e.orderId).toBe("ord_9");
    expect(e.status).toBe("settled");
  });

  it("marks unknown event kinds as undefined", () => {
    const e = parseWebhookEvent(JSON.stringify({ event: "payment_order.teleported", data: {} }));
    expect(e.kind).toBeUndefined();
  });

  it("throws on non-JSON and non-object bodies", () => {
    expect(() => parseWebhookEvent("not json")).toThrow();
    expect(() => parseWebhookEvent("[1,2,3]")).toThrow();
  });
});

describe("classification", () => {
  const ev = (kind: string) => parseWebhookEvent(JSON.stringify({ event: `payment_order.${kind}`, data: {} }));
  it("validated = delivered, settled = settled, expired/refunded = ended", () => {
    expect(isDelivered(ev("validated"))).toBe(true);
    expect(isSettled(ev("settled"))).toBe(true);
    expect(isRefundedOrExpired(ev("expired"))).toBe(true);
    expect(isRefundedOrExpired(ev("refunded"))).toBe(true);
    expect(isDelivered(ev("pending"))).toBe(false);
  });
});
