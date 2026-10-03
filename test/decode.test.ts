// I7 — decode-before-sign: ABI-decode the unsigned tx and match the confirmed legs.
import { describe, expect, it } from "vitest";
import { Interface, getAddress } from "ethers";
import { BASE_CHAIN_ID, BASE_USDC, SPRAY_CONTRACT } from "../src/config.js";
import { assertTxMatchesLegs, decodeSprayToken, DecodeMismatchError } from "../src/spraay/decode.js";
import type { UnsignedBatchTx } from "../src/spraay/gateway.js";

const iface = new Interface([
  "function sprayToken(address token, (address recipient, uint256 amount)[] recipients)",
]);

const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const C = getAddress("0x3333333333333333333333333333333333333333");

function tx(token: string, recipients: Array<[string, bigint]>, to = SPRAY_CONTRACT): UnsignedBatchTx {
  const data = iface.encodeFunctionData("sprayToken", [
    token,
    recipients.map(([r, a]) => ({ recipient: r, amount: a })),
  ]);
  return { to, data, value: "0x0", chainId: Number(BASE_CHAIN_ID), gasLimit: "0x5208" };
}

describe("decodeSprayToken", () => {
  it("decodes token and recipient tuples", () => {
    const decoded = decodeSprayToken(tx(BASE_USDC, [[A, 500_000n]]).data);
    expect(decoded.token).toBe(BASE_USDC);
    expect(decoded.recipients).toEqual([{ recipient: A, amount: 500_000n }]);
  });

  it("rejects calldata that is not sprayToken", () => {
    expect(() => decodeSprayToken("0xdeadbeef")).toThrow(DecodeMismatchError);
  });
});

describe("assertTxMatchesLegs", () => {
  const legs = [
    { receiveAddress: A, amountRaw: 500_000n },
    { receiveAddress: B, amountRaw: 1_990_000n },
  ];

  it("passes on an exact match regardless of order", () => {
    const t = tx(BASE_USDC, [
      [B, 1_990_000n],
      [A, 500_000n],
    ]);
    expect(() => assertTxMatchesLegs(t, legs)).not.toThrow();
  });

  it("rejects a wrong target contract", () => {
    // The fabricated address from the brief (lowercased so ethers re-checksums it).
    const t = tx(BASE_USDC, [[A, 500_000n]], getAddress("0x62b59b327837661e84b4d8fdfda5c1a7b39a8e67"));
    expect(() => assertTxMatchesLegs(t, [{ receiveAddress: A, amountRaw: 500_000n }])).toThrow(/Spray contract/);
  });

  it("rejects a wrong token", () => {
    const t = tx(getAddress("0x000000000000000000000000000000000000dead"), [[A, 500_000n]]);
    expect(() => assertTxMatchesLegs(t, [{ receiveAddress: A, amountRaw: 500_000n }])).toThrow(/token/);
  });

  it("rejects a wrong amount", () => {
    const t = tx(BASE_USDC, [
      [A, 500_000n],
      [B, 1_990_001n],
    ]);
    expect(() => assertTxMatchesLegs(t, legs)).toThrow(/amount/);
  });

  it("rejects an extra recipient", () => {
    const t = tx(BASE_USDC, [
      [A, 500_000n],
      [B, 1_990_000n],
      [C, 10n],
    ]);
    expect(() => assertTxMatchesLegs(t, legs)).toThrow(/recipients|not among/);
  });

  it("rejects a missing recipient", () => {
    const t = tx(BASE_USDC, [[A, 500_000n]]);
    expect(() => assertTxMatchesLegs(t, legs)).toThrow(/recipients|not present/);
  });
});
