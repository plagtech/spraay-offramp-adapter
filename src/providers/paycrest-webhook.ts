// Paycrest webhook verification and event classification.
//
// Paycrest signs each callback with the API SECRET (not the API key):
//   X-Paycrest-Signature = HMAC-SHA256(secret, RAW request body) as lowercase hex.
// The signature must be checked against the exact bytes received, before the
// body is parsed — re-serialising the JSON would change the bytes and break the
// HMAC. Comparison is timing-safe.
//
// Event lifecycle (PHASE0-RECON.md D4): `validated` = fiat delivered (success
// for off-ramp UX), `settled` = terminal/final. The ledger records both.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-paycrest-signature";

/** The documented payment_order.* event suffixes. */
export const PAYCREST_EVENTS = [
  "deposited",
  "pending",
  "validated",
  "settling",
  "settled",
  "refunding",
  "refunded",
  "expired",
  "compliance_hold",
] as const;

export type PaycrestEventKind = (typeof PAYCREST_EVENTS)[number];

export interface WebhookEvent {
  /** Full event name, e.g. "payment_order.validated". */
  readonly event: string;
  /** The suffix, if recognised; undefined for an unknown event. */
  readonly kind: PaycrestEventKind | undefined;
  /** Order id carried in the payload, if present. */
  readonly orderId: string | undefined;
  /** Order status in the payload, if present. */
  readonly status: string | undefined;
  readonly raw: unknown;
}

/**
 * Verify the signature over the RAW body bytes. Returns false on any mismatch,
 * malformed hex, or length difference — never throws on bad input, so a forged
 * request is a clean rejection rather than a crash.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;

  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(bodyBuf).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a webhook body into a typed event. Strict: the body must be a JSON object. */
export function parseWebhookEvent(rawBody: string): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("webhook body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("webhook body is not a JSON object");
  }
  const root = parsed as Record<string, unknown>;

  const event = typeof root["event"] === "string" ? root["event"] : "";
  const suffix = event.includes(".") ? event.slice(event.lastIndexOf(".") + 1) : event;
  const kind = (PAYCREST_EVENTS as readonly string[]).includes(suffix)
    ? (suffix as PaycrestEventKind)
    : undefined;

  const data = typeof root["data"] === "object" && root["data"] !== null
    ? (root["data"] as Record<string, unknown>)
    : root;
  const orderId =
    typeof data["id"] === "string"
      ? data["id"]
      : typeof data["orderId"] === "string"
        ? data["orderId"]
        : undefined;
  const status = typeof data["status"] === "string" ? data["status"] : undefined;

  return { event, kind, orderId, status, raw: parsed };
}

/** `validated` — fiat delivered. The success signal for off-ramp UX. */
export function isDelivered(e: WebhookEvent): boolean {
  return e.kind === "validated";
}

/** `settled` — terminal/final state. */
export function isSettled(e: WebhookEvent): boolean {
  return e.kind === "settled";
}

/** Order ended without delivery: refunded or expired. */
export function isRefundedOrExpired(e: WebhookEvent): boolean {
  return e.kind === "refunded" || e.kind === "expired";
}

/**
 * The ledger sink a receiver writes webhook events into. Kept as an interface so
 * this module does not depend on the storage backend (run.ts wires the ledger).
 */
export interface WebhookLedger {
  recordWebhookEvent(event: WebhookEvent): void;
}

/**
 * Verify, parse, and hand a webhook off to the ledger in one call. Returns the
 * parsed event on success; throws on a bad signature so the HTTP layer can
 * answer 401 without recording anything.
 */
export function receiveWebhook(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string,
  ledger: WebhookLedger,
): WebhookEvent {
  if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
    throw new Error("webhook signature verification failed");
  }
  const event = parseWebhookEvent(rawBody);
  ledger.recordWebhookEvent(event);
  return event;
}
