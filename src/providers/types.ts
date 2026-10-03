// The off-ramp provider abstraction.
//
// One off-ramp leg = one fiat payout to one recipient, funded by one on-chain
// USDC transfer to a provider-supplied receive address. The adapter batches N
// such legs into a single Spraay `sprayToken` transaction (see spraay/gateway.ts),
// so the provider must mint one unique receive address per leg — confirmed for
// Paycrest v2 in PHASE0-RECON.md U-P1(a).
//
// All monetary fields are decimal strings (never floats); convert once with
// units.ts at the chain boundary.

/** A fiat destination for one payout, e.g. an M-Pesa number in Kenya. */
export interface Recipient {
  /** ISO 3166-1 alpha-2 country, e.g. "KE". Used by the compliance gate. */
  readonly country: string;
  /** ISO 4217 fiat currency, e.g. "KES". */
  readonly currency: string;
  /** Provider institution code, e.g. "SAFAKEPC" (M-Pesa KE). See listInstitutions. */
  readonly institution: string;
  /** Account identifier at the institution (phone number, account no.). */
  readonly accountIdentifier: string;
  /** Account holder name, as required by the provider for name-match. */
  readonly accountName: string;
  /** USDC amount to off-ramp for this leg, decimal string ("0.5"). */
  readonly amountUsdc: string;
  /** Optional channel metadata (till/paybill), passed through to the provider. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Address funds are refunded to if this leg's order expires or fails. */
  readonly refundAddress: string;
}

/** A fiat institution a provider can pay into, from listInstitutions. */
export interface Institution {
  readonly code: string;
  readonly name: string;
  readonly type: string;
}

/** The sell-side (off-ramp) rate for a token/fiat pair. */
export interface OfframpRate {
  /** Fiat units per 1 token, decimal string. For off-ramp use the sell rate. */
  readonly rate: string;
  readonly token: string;
  readonly currency: string;
  readonly providerIds: readonly string[];
}

/** A created off-ramp order, before any on-chain funding. */
export interface OfframpOrder {
  /** Provider order id. */
  readonly id: string;
  /** Unique on-chain address this leg's USDC must be sent to. */
  readonly receiveAddress: string;
  /**
   * EXACT raw-token amount to transfer to receiveAddress, as the provider's
   * authoritative field (Paycrest: `providerAccount.amountToTransfer`). This is
   * amount + senderFee + transactionFee. Send verbatim — an over/under-send is
   * silently re-priced, not refunded (PHASE0-RECON.md U-P1(d)).
   */
  readonly amountToTransfer: string;
  /** Provider-reported breakdown, for the ledger and the decode cross-check. */
  readonly amount: string;
  readonly senderFee: string;
  readonly transactionFee: string;
  /** Hard deadline after which the order expires. The only authority on timing. */
  readonly validUntil: Date;
  /** Current order status, provider-native string. */
  readonly status: string;
  /** The recipient this order was created for, echoed back. */
  readonly recipient: Recipient;
  /** Raw provider payload, retained for the ledger and debugging. */
  readonly raw: unknown;
}

/** A point-in-time status read for a created order. */
export interface OrderStatus {
  readonly id: string;
  readonly status: string;
  readonly txHash?: string;
  readonly raw: unknown;
}

/**
 * The capabilities the adapter needs from any off-ramp provider. Paycrest is the
 * first implementation (providers/paycrest.ts); the interface is intentionally
 * narrow so a second provider could be dropped in.
 */
export interface OfframpProvider {
  readonly name: string;

  /** Supported token address for the given network, asserted at runtime (U-P4). */
  resolveToken(symbol: string, network: string): Promise<{ address: string; decimals: number }>;

  /** Institutions payable in a currency, e.g. KES -> [M-Pesa, Airtel] (U-P5). */
  listInstitutions(currency: string): Promise<readonly Institution[]>;

  /**
   * Current sell rate for token->currency at a given amount. Off-ramp uses the
   * sell side (D7); the rate endpoint is amount-scoped, so pass the leg amount.
   */
  getSellRate(
    token: string,
    currency: string,
    network: string,
    amountUsdc: string,
  ): Promise<OfframpRate>;

  /** Create one off-ramp order for one recipient. Mints a unique receive address. */
  createOrder(recipient: Recipient, token: string, network: string): Promise<OfframpOrder>;

  /** Read an order's current status. */
  getOrder(id: string): Promise<OrderStatus>;
}
