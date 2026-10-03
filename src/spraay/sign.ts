// Signing and broadcast. Non-custodial (I6): this key signs ONLY an ERC-20
// `approve` and the `sprayToken` batch — nothing else. The key never leaves the
// operator's box; the gateway and Paycrest never see it.
//
// I4 — failed is not disproven. Once a transaction is broadcast, a later error
// (timeout, RPC hiccup) does NOT mean it did not land. We return the hash and a
// status of "unconfirmed" and require an explicit retry/recheck rather than
// re-broadcasting blind and risking a double spend.

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";
import { BASE_CHAIN_ID } from "../config.js";
import type { UnsignedBatchTx } from "./gateway.js";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
] as const;

export interface Signer {
  readonly wallet: Wallet;
  readonly provider: JsonRpcProvider;
  readonly address: string;
}

/** Connect a signing wallet to Base and verify the RPC is on the right chain. */
export async function makeSigner(privateKey: string, rpcUrl: string): Promise<Signer> {
  const provider = new JsonRpcProvider(rpcUrl, Number(BASE_CHAIN_ID));
  const network = await provider.getNetwork();
  if (network.chainId !== BASE_CHAIN_ID) {
    throw new Error(`RPC chainId is ${network.chainId}, expected Base (${BASE_CHAIN_ID})`);
  }
  const wallet = new Wallet(privateKey, provider);
  return { wallet, provider, address: await wallet.getAddress() };
}

/** Raw USDC balance of the signing wallet. */
export async function usdcBalance(signer: Signer, token: string): Promise<bigint> {
  const erc20 = new Contract(getAddress(token), ERC20_ABI, signer.provider);
  return BigInt(await (erc20 as unknown as { balanceOf(a: string): Promise<bigint> }).balanceOf(signer.address));
}

export interface ApproveResult {
  /** True if an approve was broadcast; false if the existing allowance sufficed. */
  readonly approved: boolean;
  readonly txHash: string | undefined;
  readonly allowanceBefore: bigint;
}

/**
 * Ensure `spender` can pull at least `requiredRaw` of `token`. Approves the
 * EXACT required amount (not max-uint) when the current allowance is short, and
 * waits for one confirmation so the subsequent sprayToken nonce is clean.
 */
export async function ensureAllowance(
  signer: Signer,
  token: string,
  spender: string,
  requiredRaw: bigint,
): Promise<ApproveResult> {
  const tokenAddr = getAddress(token);
  const spenderAddr = getAddress(spender);
  const erc20 = new Contract(tokenAddr, ERC20_ABI, signer.wallet);

  const current = BigInt(
    await (erc20 as unknown as { allowance(o: string, s: string): Promise<bigint> }).allowance(
      signer.address,
      spenderAddr,
    ),
  );
  if (current >= requiredRaw) {
    return { approved: false, txHash: undefined, allowanceBefore: current };
  }

  const nonce = await signer.provider.getTransactionCount(signer.address, "pending");
  const tx: TransactionResponse = await (
    erc20 as unknown as {
      approve(s: string, v: bigint, o: { nonce: number }): Promise<TransactionResponse>;
    }
  ).approve(spenderAddr, requiredRaw, { nonce });
  await tx.wait(1);
  return { approved: true, txHash: tx.hash, allowanceBefore: current };
}

export interface BroadcastResult {
  readonly txHash: string;
  /** "unconfirmed" means broadcast but not yet mined — NOT failed (I4). */
  readonly status: "unconfirmed";
}

/**
 * Sign and broadcast the gateway's unsigned sprayToken transaction. The caller
 * MUST have run assertTxMatchesLegs (I7) on this tx first. Returns as soon as the
 * tx is broadcast, with status "unconfirmed"; confirmation is a separate step so
 * a wait timeout can never be mistaken for a failed batch.
 */
export async function broadcastBatch(signer: Signer, tx: UnsignedBatchTx): Promise<BroadcastResult> {
  if (tx.chainId !== Number(BASE_CHAIN_ID)) {
    throw new Error(`refusing to sign a tx for chainId ${tx.chainId}; adapter is Base-only`);
  }
  const nonce = await signer.provider.getTransactionCount(signer.address, "pending");
  const response = await signer.wallet.sendTransaction({
    to: getAddress(tx.to),
    data: tx.data,
    value: BigInt(tx.value),
    chainId: BigInt(tx.chainId),
    gasLimit: BigInt(tx.gasLimit),
    nonce,
  });
  return { txHash: response.hash, status: "unconfirmed" };
}

export interface ConfirmResult {
  readonly txHash: string;
  readonly mined: boolean;
  readonly success: boolean | undefined;
  readonly receipt: TransactionReceipt | null;
}

/**
 * Wait for a broadcast tx to mine, with a bounded number of polls. A timeout
 * returns { mined: false } — the caller treats that as "recheck later", never as
 * failure (I4). Only a mined receipt with status 0 is a real on-chain revert.
 */
export async function confirmBatch(
  signer: Signer,
  txHash: string,
  confirmations = 1,
): Promise<ConfirmResult> {
  const receipt = await signer.provider.waitForTransaction(txHash, confirmations, 180_000);
  if (receipt === null) {
    return { txHash, mined: false, success: undefined, receipt: null };
  }
  return { txHash, mined: true, success: receipt.status === 1, receipt };
}
