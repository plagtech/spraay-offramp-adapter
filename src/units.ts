// Money handling. Every value on the payment path is an integer; floats never
// touch money. Carried over from vmflow-spraay/src/money.ts, trimmed to what the
// off-ramp adapter needs.
//
// USDC on Base has 6 decimals. Paycrest reports all amounts as decimal strings
// ("1.99", "0.5"); the Spraay gateway reports `approvalRequired.amount` in raw
// base units and its batch summary in human decimals. We parse the TEXT
// digit-wise and never multiply a float.

export const USDC_DECIMALS = 6;

/**
 * Parse a USDC decimal string into raw base units, exactly, with no float math.
 *
 * Accepts "1", "1.5", "0.5", "0.000001". Rejects negatives, blanks, and
 * anything with more than 6 decimal places rather than silently rounding money.
 * This is the single chokepoint for turning a human amount into chain units.
 */
export function usdcToRaw(value: string | number): bigint {
  const text = typeof value === "number" ? decimalTextFromNumber(value) : String(value).trim();

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`not a non-negative USDC decimal amount: ${JSON.stringify(value)}`);
  }

  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(
      `${JSON.stringify(value)} has more precision than USDC's ${USDC_DECIMALS} decimals; refusing to round money`,
    );
  }
  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, "0"));
}

/**
 * Raw USDC base units -> display string, for logs, the ledger, and the README.
 * Never feed this back into math; it is for humans.
 */
export function rawToUsdc(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * A JS number reaches us only if a caller passed one by mistake (JSON numbers,
 * a hand-typed amount). Recover its shortest exact decimal form and parse that
 * as text; never multiply the float. Exponential forms are surfaced, not guessed.
 */
function decimalTextFromNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite amount: ${n}`);
  const text = String(n);
  if (text.includes("e") || text.includes("E")) {
    throw new Error(`amount in exponential form, cannot parse exactly: ${text}`);
  }
  return text;
}
