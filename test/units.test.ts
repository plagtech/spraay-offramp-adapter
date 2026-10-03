// I3 — units cross once via BigInt; refuse >6 decimals.
import { describe, expect, it } from "vitest";
import { USDC_DECIMALS, rawToUsdc, usdcToRaw } from "../src/units.js";

describe("usdcToRaw", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(usdcToRaw("1")).toBe(1_000_000n);
    expect(usdcToRaw("0.5")).toBe(500_000n);
    expect(usdcToRaw("0.000001")).toBe(1n);
    expect(usdcToRaw("1.99")).toBe(1_990_000n);
    expect(usdcToRaw("1234.567891")).toBe(1_234_567_891n);
  });

  it("refuses more than 6 decimal places (I3) rather than rounding", () => {
    expect(() => usdcToRaw("0.0000001")).toThrow(/precision/i);
    expect(() => usdcToRaw("1.1234567")).toThrow(/precision/i);
  });

  it("refuses negatives, blanks, and non-numeric text", () => {
    expect(() => usdcToRaw("-1")).toThrow();
    expect(() => usdcToRaw("")).toThrow();
    expect(() => usdcToRaw("abc")).toThrow();
    expect(() => usdcToRaw(".")).toThrow();
  });

  it("refuses exponential-form numbers instead of guessing", () => {
    expect(() => usdcToRaw(1e-7)).toThrow(/exponential|precision/i);
  });

  it("round-trips through rawToUsdc (always 6dp form)", () => {
    expect(rawToUsdc(500_000n)).toBe("0.500000");
    expect(rawToUsdc(1n)).toBe("0.000001");
    expect(rawToUsdc(1_234_567_891n)).toBe("1234.567891");
    // A 6dp-normalised string survives a full round-trip.
    for (const v of ["0.000000", "0.500000", "1.990000", "1234.567891"]) {
      expect(rawToUsdc(usdcToRaw(v))).toBe(v);
    }
    expect(USDC_DECIMALS).toBe(6);
  });
});
