// Compliance gate. Runs BEFORE any order is created or any USDC moves, so a
// rejected recipient costs nothing. Three checks, all fail-closed:
//
//   1. Embargo: the recipient's country, or the country implied by their phone
//      number, is comprehensively sanctioned.
//   2. Phone/ISO consistency: a mobile-money account whose dialing code maps to
//      a different (or embargoed) country than stated is refused rather than
//      guessed at.
//   3. Sanctions screening: a pluggable SDN screener. This adapter ships no list;
//      the operator supplies a screener. The "no screening" choice must be made
//      explicitly via NoopScreener, never by omission.
//
// This is operational risk tooling, not legal advice. The embargo list below is
// the set of OFAC-comprehensively-embargoed jurisdictions as ISO 3166-1 alpha-2;
// operators remain responsible for keeping screening current.

import type { Recipient } from "../providers/types.js";

/** OFAC comprehensively embargoed jurisdictions (ISO 3166-1 alpha-2). */
export const EMBARGOED_COUNTRIES: ReadonlySet<string> = new Set(["CU", "IR", "KP", "SY"]);

/**
 * Dialing code -> ISO country, for the markets this adapter serves plus the
 * embargoed jurisdictions it must be able to catch from a phone number. NOT
 * exhaustive and deliberately so: an unknown code yields `undefined`, which the
 * gate treats as "cannot confirm", not "allowed".
 */
const DIALING_CODE_TO_ISO: ReadonlyArray<readonly [string, string]> = [
  ["254", "KE"], // Kenya
  ["234", "NG"], // Nigeria
  ["255", "TZ"], // Tanzania
  ["256", "UG"], // Uganda
  ["53", "CU"], // Cuba
  ["98", "IR"], // Iran
  ["850", "KP"], // North Korea
  ["963", "SY"], // Syria
];

export interface SanctionsParty {
  readonly name: string;
  readonly accountIdentifier: string;
  readonly country: string;
}

export interface ScreenResult {
  readonly listed: boolean;
  readonly detail?: string;
}

/** Pluggable SDN/sanctions screener. */
export interface SanctionsScreener {
  readonly name: string;
  screenParty(party: SanctionsParty): Promise<ScreenResult>;
}

/**
 * An explicit "no screening" screener. Passing this is a deliberate operator
 * choice recorded in the decision reasons — it never means a party was cleared.
 */
export class NoopScreener implements SanctionsScreener {
  readonly name = "noop";
  async screenParty(): Promise<ScreenResult> {
    return { listed: false, detail: "no sanctions screening performed (NoopScreener)" };
  }
}

export interface ComplianceDecision {
  readonly allowed: boolean;
  /** Human-readable reasons; on denial, why. On allow, what was checked. */
  readonly reasons: readonly string[];
  /** The ISO country the gate derived from the phone, if any. */
  readonly phoneCountry: string | undefined;
}

/**
 * Map a phone number to an ISO country via its international dialing code.
 * Accepts "+2547...", "2547...", or "007..."; returns undefined for a local
 * format (no country code) or an unrecognised code. Longest code wins, so "254"
 * is matched before "25".
 */
export function phoneToIso(phone: string): string | undefined {
  const digits = phone.replace(/[^\d]/g, "").replace(/^00/, "");
  if (digits === "") return undefined;
  const sorted = [...DIALING_CODE_TO_ISO].sort((a, b) => b[0].length - a[0].length);
  for (const [code, iso] of sorted) {
    if (digits.startsWith(code)) return iso;
  }
  return undefined;
}

/** Does this account identifier look like an international phone number? */
function looksInternational(accountIdentifier: string): boolean {
  const trimmed = accountIdentifier.trim();
  return trimmed.startsWith("+") || trimmed.startsWith("00");
}

export class ComplianceGate {
  constructor(private readonly screener: SanctionsScreener) {}

  /**
   * Decide whether a recipient may be paid. Returns a decision; never throws on
   * a disallowed recipient — the caller records the decision and skips the leg.
   */
  async check(recipient: Recipient): Promise<ComplianceDecision> {
    const reasons: string[] = [];
    const country = recipient.country.trim().toUpperCase();

    if (country.length !== 2) {
      return {
        allowed: false,
        reasons: [`recipient.country is not an ISO alpha-2 code: ${JSON.stringify(recipient.country)}`],
        phoneCountry: undefined,
      };
    }

    // 1. Embargoed stated country.
    if (EMBARGOED_COUNTRIES.has(country)) {
      reasons.push(`country ${country} is embargoed`);
    }

    // 2. Phone/ISO consistency.
    const phoneCountry = phoneToIso(recipient.accountIdentifier);
    if (phoneCountry && EMBARGOED_COUNTRIES.has(phoneCountry)) {
      reasons.push(`phone number resolves to embargoed country ${phoneCountry}`);
    }
    if (phoneCountry && phoneCountry !== country) {
      reasons.push(
        `phone number resolves to ${phoneCountry} but recipient.country is ${country}; ` +
          `refusing on country mismatch`,
      );
    }
    if (!phoneCountry && looksInternational(recipient.accountIdentifier)) {
      reasons.push(
        `account identifier looks international but its dialing code is unrecognised; ` +
          `cannot confirm destination country`,
      );
    }

    // 3. Sanctions screening (fail-closed: a screener error denies).
    let screen: ScreenResult;
    try {
      screen = await this.screener.screenParty({
        name: recipient.accountName,
        accountIdentifier: recipient.accountIdentifier,
        country,
      });
    } catch (error) {
      return {
        allowed: false,
        reasons: [`sanctions screening failed (${(error as Error).message}); failing closed`],
        phoneCountry,
      };
    }
    if (screen.listed) {
      reasons.push(`sanctions screening hit${screen.detail ? `: ${screen.detail}` : ""}`);
    }

    if (reasons.length > 0) {
      return { allowed: false, reasons, phoneCountry };
    }

    const cleared = [
      `country ${country} not embargoed`,
      phoneCountry ? `phone country ${phoneCountry} consistent` : "no phone country derived",
      `screener=${this.screener.name}${screen.detail ? ` (${screen.detail})` : ""}`,
    ];
    return { allowed: true, reasons: cleared, phoneCountry };
  }
}
