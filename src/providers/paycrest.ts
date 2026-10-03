// Paycrest sender API v2 client — the first OfframpProvider.
//
// Endpoints (base https://api.paycrest.io), pinned in PHASE0-RECON.md:
//   GET  /v2/tokens                         token addresses (U-P4, public)
//   GET  /v2/institutions/:currency         payable institutions (U-P5, public)
//   GET  /v2/rates/:network/:token/:amt/:cur  sell rate (D7, public)
//   POST /v2/verify-account                 name-match a destination account
//   POST /v2/sender/orders                  create an off-ramp order (needs key)
//   GET  /v2/sender/orders/:id              poll order status (needs key)
//
// Auth is the `API-Key` header. The API Secret is NOT used here — it is only for
// webhook HMAC (providers/paycrest-webhook.ts).
//
// Like the gateway client, this parser is strict: it refuses a response whose
// shape it does not recognise rather than guessing, because the fields it reads
// decide how much USDC gets sent on-chain.

import { usdcToRaw } from "../units.js";
import type {
  Institution,
  OfframpOrder,
  OfframpProvider,
  OfframpRate,
  OrderStatus,
  Recipient,
} from "./types.js";

/** Thrown when the Paycrest API answers with something we do not recognise. */
export class PaycrestContractError extends Error {
  readonly body: unknown;
  constructor(message: string, body: unknown) {
    super(
      message +
        "\n\nThe Paycrest response did not match the expected v2 contract. The adapter is " +
        "stopping rather than adapting.\nResponse:\n" +
        JSON.stringify(body, null, 2),
    );
    this.name = "PaycrestContractError";
    this.body = body;
  }
}

export interface PaycrestOptions {
  readonly apiUrl: string;
  /** Required for sender endpoints (create/poll); optional for public reads. */
  readonly apiKey?: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Assert a decimal string has no more than USDC's 6 dp (reuses the money parser). */
function assertUsdcPrecision(label: string, value: string, body: unknown): void {
  try {
    usdcToRaw(value);
  } catch (error) {
    throw new PaycrestContractError(`${label} is not a clean USDC amount: ${(error as Error).message}`, body);
  }
}

export class PaycrestProvider implements OfframpProvider {
  readonly name = "paycrest";
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(opts: PaycrestOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new Error("PAYCREST_API_KEY is required for this operation (sender endpoint)");
    }
    return this.apiKey;
  }

  /** Issue a request and unwrap the {status, message, data} envelope. */
  private async call(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; needsKey?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.needsKey) headers["API-Key"] = this.requireKey();
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    const response = await this.fetchImpl(this.apiUrl + path, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PaycrestContractError(`${method} ${path} returned non-JSON (HTTP ${response.status})`, text);
    }
    if (!response.ok) {
      throw new PaycrestContractError(`${method} ${path} returned HTTP ${response.status}`, parsed);
    }
    if (!isRecord(parsed)) {
      throw new PaycrestContractError(`${method} ${path} response is not an object`, parsed);
    }
    if (parsed["status"] !== "success") {
      throw new PaycrestContractError(
        `${method} ${path} status was ${JSON.stringify(parsed["status"])}: ${String(parsed["message"])}`,
        parsed,
      );
    }
    return parsed["data"];
  }

  async resolveToken(symbol: string, network: string): Promise<{ address: string; decimals: number }> {
    const data = await this.call("GET", "/v2/tokens");
    if (!Array.isArray(data)) throw new PaycrestContractError("/v2/tokens data is not an array", data);
    const match = data.find(
      (t): t is Json =>
        isRecord(t) &&
        str(t["symbol"])?.toUpperCase() === symbol.toUpperCase() &&
        str(t["network"])?.toLowerCase() === network.toLowerCase(),
    );
    if (!match) {
      throw new PaycrestContractError(`token ${symbol} on ${network} not found in /v2/tokens`, data);
    }
    const address = str(match["contractAddress"]) ?? str(match["address"]);
    const decimals = match["decimals"];
    if (!address || typeof decimals !== "number") {
      throw new PaycrestContractError(`token ${symbol}/${network} missing contractAddress/decimals`, match);
    }
    return { address, decimals };
  }

  async listInstitutions(currency: string): Promise<readonly Institution[]> {
    const data = await this.call("GET", `/v2/institutions/${encodeURIComponent(currency)}`);
    if (!Array.isArray(data)) {
      throw new PaycrestContractError(`/v2/institutions/${currency} data is not an array`, data);
    }
    return data.map((i): Institution => {
      if (!isRecord(i)) throw new PaycrestContractError("institution entry is not an object", i);
      const code = str(i["code"]);
      const name = str(i["name"]);
      if (!code || !name) throw new PaycrestContractError("institution missing code/name", i);
      return { code, name, type: str(i["type"]) ?? "unknown" };
    });
  }

  async getSellRate(
    token: string,
    currency: string,
    network: string,
    amountUsdc: string,
  ): Promise<OfframpRate> {
    assertUsdcPrecision("rate amount", amountUsdc, amountUsdc);
    const path =
      `/v2/rates/${encodeURIComponent(network)}/${encodeURIComponent(token)}` +
      `/${encodeURIComponent(amountUsdc)}/${encodeURIComponent(currency)}`;
    const data = await this.call("GET", path);
    if (!isRecord(data)) throw new PaycrestContractError(`${path} data is not an object`, data);
    const sell = data["sell"];
    if (!isRecord(sell)) throw new PaycrestContractError(`${path} data.sell is missing`, data);
    const rate = str(sell["rate"]);
    if (!rate) throw new PaycrestContractError(`${path} data.sell.rate is missing`, data);
    const providerIds = Array.isArray(sell["providerIds"])
      ? sell["providerIds"].filter((x): x is string => typeof x === "string")
      : [];
    return { rate, token, currency, providerIds };
  }

  /** Name-match a destination account before creating an order. */
  async verifyAccount(
    institution: string,
    accountIdentifier: string,
  ): Promise<{ accountName: string; raw: unknown }> {
    const data = await this.call("POST", "/v2/verify-account", {
      body: { institution, accountIdentifier },
    });
    const accountName = typeof data === "string" ? data : isRecord(data) ? str(data["accountName"]) : undefined;
    if (!accountName) throw new PaycrestContractError("/v2/verify-account returned no account name", data);
    return { accountName, raw: data };
  }

  async createOrder(recipient: Recipient, token: string, network: string): Promise<OfframpOrder> {
    assertUsdcPrecision("recipient.amountUsdc", recipient.amountUsdc, recipient);

    const body: Json = {
      amount: recipient.amountUsdc,
      amountIn: "crypto",
      reference: `offramp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      source: {
        type: "crypto",
        currency: token,
        network,
        refundAddress: recipient.refundAddress,
      },
      destination: {
        type: "fiat",
        currency: recipient.currency,
        recipient: {
          institution: recipient.institution,
          accountIdentifier: recipient.accountIdentifier,
          accountName: recipient.accountName,
          ...(recipient.metadata ? { metadata: recipient.metadata } : {}),
        },
      },
    };

    const data = await this.call("POST", "/v2/sender/orders", { body, needsKey: true });
    return this.parseOrder(data, recipient);
  }

  async getOrder(id: string): Promise<OrderStatus> {
    const data = await this.call("GET", `/v2/sender/orders/${encodeURIComponent(id)}`, { needsKey: true });
    if (!isRecord(data)) throw new PaycrestContractError("order status data is not an object", data);
    const status = str(data["status"]);
    if (!status) throw new PaycrestContractError("order status missing status field", data);
    const result: OrderStatus = { id, status, raw: data };
    const txHash = str(data["txHash"]);
    return txHash ? { ...result, txHash } : result;
  }

  /**
   * Parse a create-order response. The authoritative transfer amount is
   * `providerAccount.amountToTransfer` (U-P2) — but we also assert it equals
   * amount + senderFee + transactionFee and carries no sub-6dp precision, and
   * refuse the order otherwise rather than send a wrong amount on-chain.
   */
  private parseOrder(data: unknown, recipient: Recipient): OfframpOrder {
    if (!isRecord(data)) throw new PaycrestContractError("create-order data is not an object", data);

    const id = str(data["id"]);
    const status = str(data["status"]);
    if (!id) throw new PaycrestContractError("create-order response missing id", data);
    if (!status) throw new PaycrestContractError("create-order response missing status", data);

    const pa = data["providerAccount"];
    if (!isRecord(pa)) throw new PaycrestContractError("create-order response missing providerAccount", data);
    const receiveAddress = str(pa["receiveAddress"]);
    const amountToTransfer = str(pa["amountToTransfer"]);
    const validUntilText = str(pa["validUntil"]) ?? str(data["validUntil"]);
    if (!receiveAddress) throw new PaycrestContractError("providerAccount.receiveAddress is missing", data);
    if (!amountToTransfer) throw new PaycrestContractError("providerAccount.amountToTransfer is missing", data);
    if (!validUntilText) throw new PaycrestContractError("validUntil is missing", data);

    const validUntil = new Date(validUntilText);
    if (Number.isNaN(validUntil.getTime())) {
      throw new PaycrestContractError(`validUntil is not a date: ${validUntilText}`, data);
    }

    const amount = str(data["amount"]) ?? recipient.amountUsdc;
    const senderFee = str(data["senderFee"]) ?? "0";
    const transactionFee = str(data["transactionFee"]) ?? "0";

    for (const [label, value] of [
      ["amountToTransfer", amountToTransfer],
      ["amount", amount],
      ["senderFee", senderFee],
      ["transactionFee", transactionFee],
    ] as const) {
      assertUsdcPrecision(label, value, data);
    }

    // Cross-check the authoritative field against the breakdown (I7 precursor).
    const expected = usdcToRaw(amount) + usdcToRaw(senderFee) + usdcToRaw(transactionFee);
    if (usdcToRaw(amountToTransfer) !== expected) {
      throw new PaycrestContractError(
        `providerAccount.amountToTransfer (${amountToTransfer}) != amount+senderFee+transactionFee ` +
          `(${amount}+${senderFee}+${transactionFee}); refusing to fund an order whose fields disagree`,
        data,
      );
    }

    return {
      id,
      receiveAddress,
      amountToTransfer,
      amount,
      senderFee,
      transactionFee,
      validUntil,
      status,
      recipient,
      raw: data,
    };
  }
}
