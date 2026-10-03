// Compliance gate: embargo, phone/ISO consistency, fail-closed screening.
import { describe, expect, it } from "vitest";
import {
  ComplianceGate,
  NoopScreener,
  phoneToIso,
  type SanctionsScreener,
} from "../src/compliance/gate.js";
import type { Recipient } from "../src/providers/types.js";

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

describe("phoneToIso", () => {
  it("maps dialing codes, longest-match first", () => {
    expect(phoneToIso("+254712345678")).toBe("KE");
    expect(phoneToIso("2348012345678")).toBe("NG");
    expect(phoneToIso("00963111111")).toBe("SY");
  });
  it("returns undefined for local format or unknown codes", () => {
    expect(phoneToIso("0712345678")).toBeUndefined();
    expect(phoneToIso("+9991234")).toBeUndefined();
  });
});

describe("ComplianceGate", () => {
  const gate = new ComplianceGate(new NoopScreener());

  it("allows a consistent, non-embargoed recipient", async () => {
    const d = await gate.check(recipient());
    expect(d.allowed).toBe(true);
    expect(d.phoneCountry).toBe("KE");
  });

  it("denies an embargoed stated country", async () => {
    const d = await gate.check(recipient({ country: "IR", accountIdentifier: "0712345678" }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/embargoed/);
  });

  it("denies when the phone resolves to an embargoed country", async () => {
    const d = await gate.check(recipient({ accountIdentifier: "+9811234567" }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/IR/);
  });

  it("denies a phone/country mismatch", async () => {
    const d = await gate.check(recipient({ country: "KE", accountIdentifier: "+2348012345678" }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/mismatch/);
  });

  it("fails closed when the screener throws", async () => {
    const boom: SanctionsScreener = {
      name: "boom",
      async screenParty() {
        throw new Error("list unavailable");
      },
    };
    const d = await new ComplianceGate(boom).check(recipient());
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/failing closed/);
  });

  it("denies a screener hit", async () => {
    const hit: SanctionsScreener = {
      name: "hit",
      async screenParty() {
        return { listed: true, detail: "OFAC SDN match" };
      },
    };
    const d = await new ComplianceGate(hit).check(recipient());
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/screening hit/);
  });
});
