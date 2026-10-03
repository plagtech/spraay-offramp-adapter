// I7 — decode before sign.
//
// The gateway returns an UNSIGNED sprayToken transaction. Before the operator
// key signs it, we ABI-decode the calldata and prove it does exactly what we
// asked: the right contract, the right token, and the exact set of
// (receiveAddress, amountToTransfer) legs the provider confirmed. Anything that
// does not match is a hard stop — we never sign calldata we cannot account for.
//
// Verified contract (Base): sprayToken(address token, (address,uint256)[] recipients).
// It pulls total+fee from msg.sender, so one call emits N recipient Transfer
// logs with from = the contract (PHASE0-RECON.md U-P1 contract side).

import { Interface, getAddress } from "ethers";
import { BASE_USDC, SPRAY_CONTRACT } from "../config.js";
import type { UnsignedBatchTx } from "./gateway.js";

const SPRAY_ABI = [
  "function sprayToken(address token, (address recipient, uint256 amount)[] recipients)",
] as const;

const sprayInterface = new Interface(SPRAY_ABI);

/** One confirmed off-ramp leg: fund this receive address with this exact raw amount. */
export interface ConfirmedLeg {
  readonly receiveAddress: string;
  readonly amountRaw: bigint;
}

export interface DecodedBatch {
  readonly token: string;
  readonly recipients: ReadonlyArray<{ readonly recipient: string; readonly amount: bigint }>;
}

/** Thrown when a decoded transaction does not match what we confirmed. Stop, don't sign. */
export class DecodeMismatchError extends Error {
  constructor(message: string) {
    super(
      message +
        "\n\nThe gateway's unsigned transaction does not match the confirmed off-ramp legs. " +
        "The adapter is refusing to sign it.",
    );
    this.name = "DecodeMismatchError";
  }
}

/** ABI-decode a sprayToken calldata blob into token + recipient tuples. */
export function decodeSprayToken(data: string): DecodedBatch {
  let parsed;
  try {
    parsed = sprayInterface.parseTransaction({ data });
  } catch (error) {
    throw new DecodeMismatchError(`calldata is not a decodable sprayToken call: ${(error as Error).message}`);
  }
  if (!parsed || parsed.name !== "sprayToken") {
    throw new DecodeMismatchError(`calldata is not sprayToken (got ${parsed?.name ?? "null"})`);
  }

  const token = getAddress(parsed.args[0] as string);
  const rawRecipients = parsed.args[1] as ReadonlyArray<{ recipient: string; amount: bigint }>;
  const recipients = rawRecipients.map((r) => ({
    recipient: getAddress(r.recipient),
    amount: BigInt(r.amount),
  }));
  return { token, recipients };
}

/**
 * Prove an unsigned tx matches the confirmed legs, or throw. Checks, in order:
 *   - target is exactly the verified Spray contract;
 *   - decoded token is exactly USDC on Base;
 *   - the decoded recipients are a permutation-insensitive EXACT match of the
 *     confirmed legs: same addresses, same raw amounts, no extras, no omissions,
 *     no duplicates.
 * Amounts are compared exactly as BigInt — no tolerance.
 */
export function assertTxMatchesLegs(tx: UnsignedBatchTx, legs: readonly ConfirmedLeg[]): DecodedBatch {
  const target = getAddress(tx.to);
  if (target !== SPRAY_CONTRACT) {
    throw new DecodeMismatchError(`transaction.to is ${target}, expected Spray contract ${SPRAY_CONTRACT}`);
  }

  const decoded = decodeSprayToken(tx.data);

  if (decoded.token !== BASE_USDC) {
    throw new DecodeMismatchError(`decoded token is ${decoded.token}, expected USDC on Base ${BASE_USDC}`);
  }

  if (decoded.recipients.length !== legs.length) {
    throw new DecodeMismatchError(
      `decoded ${decoded.recipients.length} recipients, confirmed ${legs.length} legs`,
    );
  }

  // Build an expected multiset keyed by checksummed address. Receive addresses
  // are unique per order (U-P1a), so a duplicate address in either side is itself
  // a mismatch and is surfaced.
  const expected = new Map<string, bigint>();
  for (const leg of legs) {
    const addr = getAddress(leg.receiveAddress);
    if (expected.has(addr)) {
      throw new DecodeMismatchError(`confirmed legs contain duplicate receive address ${addr}`);
    }
    expected.set(addr, leg.amountRaw);
  }

  for (const r of decoded.recipients) {
    const want = expected.get(r.recipient);
    if (want === undefined) {
      throw new DecodeMismatchError(`decoded recipient ${r.recipient} is not among the confirmed legs`);
    }
    if (want !== r.amount) {
      throw new DecodeMismatchError(
        `decoded amount for ${r.recipient} is ${r.amount}, confirmed ${want}`,
      );
    }
    expected.delete(r.recipient); // consume, so a duplicate in the tx fails below
  }

  if (expected.size !== 0) {
    throw new DecodeMismatchError(
      `confirmed legs not present in the transaction: ${[...expected.keys()].join(", ")}`,
    );
  }

  return decoded;
}
