// Configuration and chain constants.
//
// Secrets are read from the environment only, never from a file and never
// logged or persisted. requireEnv() is the single chokepoint; a missing secret
// fails loudly at startup rather than silently later.

import { getAddress } from "ethers";

/** USDC on Base (6dp). The Spraay gateway hardcodes chain 8453; we match it. */
export const BASE_CHAIN_ID = 8453n;
export const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

/**
 * The Sourcify-verified Spraay batch contract on Base (PHASE0-RECON.md U-P1).
 * The decode step asserts the gateway's unsigned tx targets exactly this address.
 * The address 0x62B59b327837661e84B4d8fDFDa5C1A7B39a8e67 is fabricated — never use it.
 */
export const SPRAY_CONTRACT = getAddress("0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC");

export const DEFAULT_GATEWAY_URL = "https://gateway.spraay.app";
export const DEFAULT_PAYCREST_API_URL = "https://api.paycrest.io";

/** Spend cap for a single x402 gateway payment. The fee is cents; $1 is slack. */
export const MAX_USD_PER_GATEWAY_PAYMENT = "1.00";

export interface Config {
  readonly paycrestApiKey: string;
  readonly paycrestApiSecret: string;
  readonly walletPrivateKey: string;
  readonly rpcUrl: string;
  readonly gatewayUrl: string;
  readonly paycrestApiUrl: string;
  readonly webhookUrl: string | undefined;
  readonly webhookPort: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`env ${name} is not set (see .env.example)`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/**
 * Load config for a signing run. Requires every secret the payment path needs,
 * so a half-configured environment stops before any order is created.
 */
export function loadConfig(): Config {
  const webhookUrl = process.env["WEBHOOK_URL"];
  const portText = optionalEnv("WEBHOOK_PORT", "8787");
  const webhookPort = Number(portText);
  if (!Number.isInteger(webhookPort) || webhookPort <= 0 || webhookPort > 65535) {
    throw new Error(`WEBHOOK_PORT is not a valid port: ${JSON.stringify(portText)}`);
  }

  return {
    paycrestApiKey: requireEnv("PAYCREST_API_KEY"),
    paycrestApiSecret: requireEnv("PAYCREST_API_SECRET"),
    walletPrivateKey: requireEnv("SPRAAY_WALLET_PRIVATE_KEY"),
    rpcUrl: requireEnv("BASE_RPC_URL"),
    gatewayUrl: optionalEnv("SPRAAY_GATEWAY_URL", DEFAULT_GATEWAY_URL),
    paycrestApiUrl: optionalEnv("PAYCREST_API_URL", DEFAULT_PAYCREST_API_URL),
    webhookUrl: webhookUrl && webhookUrl.trim() !== "" ? webhookUrl.trim() : undefined,
    webhookPort,
  };
}

/**
 * Read-only config for dry-runs and read-only provider calls (rates, tokens,
 * institutions). Needs no signing key, so a `--dry-run` works with only an API
 * key set — or, for the fully public endpoints, nothing at all.
 */
export function loadReadonlyConfig(): Pick<Config, "paycrestApiUrl" | "gatewayUrl"> & {
  paycrestApiKey: string | undefined;
} {
  const key = process.env["PAYCREST_API_KEY"];
  return {
    paycrestApiKey: key && key.trim() !== "" ? key.trim() : undefined,
    paycrestApiUrl: optionalEnv("PAYCREST_API_URL", DEFAULT_PAYCREST_API_URL),
    gatewayUrl: optionalEnv("SPRAAY_GATEWAY_URL", DEFAULT_GATEWAY_URL),
  };
}
