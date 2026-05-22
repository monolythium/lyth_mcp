import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;

export interface NowpaymentsEncryptedPayload {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  params: { n: number; r: number; p: number; keyLen: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface NowpaymentsConfig {
  schemaVersion: 1;
  environment: "sandbox" | "production";
  baseUrl: string;
  encryptedApiKey: NowpaymentsEncryptedPayload;
  encryptedIpnSecret?: NowpaymentsEncryptedPayload;
  ipnCallbackUrl?: string;
  configuredAt: string;
  updatedAt: string;
}

export const NOWPAYMENTS_BASES = {
  sandbox: "https://api-sandbox.nowpayments.io/v1",
  production: "https://api.nowpayments.io/v1",
} as const;

export function nowpaymentsConfigPath(): string {
  return process.env.LYTH_MCP_NOWPAYMENTS_CONFIG || join(homedir(), ".lyth_mcp", "nowpayments.json");
}

function nowpaymentsKeyPath(): string {
  return process.env.LYTH_MCP_NOWPAYMENTS_KEY || join(homedir(), ".lyth_mcp", "nowpayments.key");
}

async function readOrCreateKey(): Promise<string> {
  const path = nowpaymentsKeyPath();
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  return key;
}

function deriveKey(passphrase: string, salt: Uint8Array, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }): Buffer {
  return scryptSync(passphrase, salt, params.keyLen, { N: params.n, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}

function encryptSecret(secret: string, passphrase: string): NowpaymentsEncryptedPayload {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    params: { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSecret(payload: NowpaymentsEncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(passphrase, salt, payload.params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function readNowpaymentsConfig(path = nowpaymentsConfigPath()): Promise<NowpaymentsConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as NowpaymentsConfig;
    if (parsed.schemaVersion !== STORE_VERSION) {
      throw new Error(`unsupported nowpayments config shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeNowpaymentsConfig(config: NowpaymentsConfig, path = nowpaymentsConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function configureNowpayments(args: {
  environment: "sandbox" | "production";
  apiKey: string;
  ipnSecret?: string;
  ipnCallbackUrl?: string;
}): Promise<NowpaymentsConfig> {
  const key = await readOrCreateKey();
  const baseUrl = NOWPAYMENTS_BASES[args.environment];
  const existing = await readNowpaymentsConfig();
  const now = new Date().toISOString();
  const config: NowpaymentsConfig = {
    schemaVersion: STORE_VERSION,
    environment: args.environment,
    baseUrl,
    encryptedApiKey: encryptSecret(args.apiKey, key),
    encryptedIpnSecret: args.ipnSecret ? encryptSecret(args.ipnSecret, key) : existing?.encryptedIpnSecret,
    ipnCallbackUrl: args.ipnCallbackUrl ?? existing?.ipnCallbackUrl,
    configuredAt: existing?.configuredAt ?? now,
    updatedAt: now,
  };
  await writeNowpaymentsConfig(config);
  return config;
}

async function requireConfig(): Promise<{ config: NowpaymentsConfig; apiKey: string; ipnSecret?: string }> {
  const config = await readNowpaymentsConfig();
  if (!config) throw new Error("nowpayments not configured; call nowpayments_configure first");
  const localKey = await readOrCreateKey();
  return {
    config,
    apiKey: decryptSecret(config.encryptedApiKey, localKey),
    ipnSecret: config.encryptedIpnSecret ? decryptSecret(config.encryptedIpnSecret, localKey) : undefined,
  };
}

async function npRequest<T = unknown>(
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const { config, apiKey } = await requireConfig();
  const url = new URL(config.baseUrl + path);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const res = await fetch(url.toString(), { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!res.ok) {
    throw new Error(`nowpayments ${method} ${path} ${res.status}: ${text}`);
  }
  return parsed as T;
}

// -----------------------------------------------------------------------------
// Wrapped endpoints
// -----------------------------------------------------------------------------

export interface NowpaymentsStatus { message: string }
export interface NowpaymentsCurrenciesResponse { currencies: string[] }
export interface NowpaymentsMerchantCoinsResponse { selectedCurrencies: string[] }
export interface NowpaymentsEstimateResponse {
  currency_from: string;
  amount_from: number;
  currency_to: string;
  estimated_amount: number;
}
export interface NowpaymentsPayment {
  payment_id: string | number;
  payment_status: string;
  pay_address: string;
  price_amount: number;
  price_currency: string;
  pay_amount: number;
  pay_currency: string;
  order_id?: string;
  order_description?: string;
  ipn_callback_url?: string;
  created_at?: string;
  updated_at?: string;
  purchase_id?: string;
  amount_received?: number;
  payin_extra_id?: string;
  smart_contract?: string;
  network?: string;
  network_precision?: number;
}
export interface NowpaymentsInvoice {
  id: string | number;
  token_id?: string;
  order_id?: string;
  order_description?: string;
  price_amount: string;
  price_currency: string;
  pay_currency?: string;
  ipn_callback_url?: string;
  invoice_url: string;
  success_url?: string;
  cancel_url?: string;
  created_at?: string;
  updated_at?: string;
}

export async function nowpaymentsStatus(): Promise<NowpaymentsStatus> {
  return npRequest<NowpaymentsStatus>("GET", "/status");
}

export async function nowpaymentsCurrencies(): Promise<NowpaymentsCurrenciesResponse> {
  return npRequest<NowpaymentsCurrenciesResponse>("GET", "/currencies");
}

export async function nowpaymentsMerchantCoins(): Promise<NowpaymentsMerchantCoinsResponse> {
  return npRequest<NowpaymentsMerchantCoinsResponse>("GET", "/merchant/coins");
}

export async function nowpaymentsEstimate(args: {
  amount: number;
  currencyFrom: string;
  currencyTo: string;
}): Promise<NowpaymentsEstimateResponse> {
  return npRequest<NowpaymentsEstimateResponse>("GET", "/estimate", {
    query: { amount: args.amount, currency_from: args.currencyFrom.toLowerCase(), currency_to: args.currencyTo.toLowerCase() },
  });
}

export async function nowpaymentsCreatePayment(args: {
  priceAmount: number;
  priceCurrency: string;
  payCurrency: string;
  orderId?: string;
  orderDescription?: string;
  ipnCallbackUrl?: string;
  payAmount?: number;
  payinExtraId?: string;
}): Promise<NowpaymentsPayment> {
  const config = (await requireConfig()).config;
  return npRequest<NowpaymentsPayment>("POST", "/payment", {
    body: {
      price_amount: args.priceAmount,
      price_currency: args.priceCurrency.toLowerCase(),
      pay_currency: args.payCurrency.toLowerCase(),
      order_id: args.orderId,
      order_description: args.orderDescription,
      ipn_callback_url: args.ipnCallbackUrl ?? config.ipnCallbackUrl,
      pay_amount: args.payAmount,
      payin_extra_id: args.payinExtraId,
    },
  });
}

export async function nowpaymentsCreateInvoice(args: {
  priceAmount: number;
  priceCurrency: string;
  payCurrency?: string;
  orderId?: string;
  orderDescription?: string;
  ipnCallbackUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<NowpaymentsInvoice> {
  const config = (await requireConfig()).config;
  return npRequest<NowpaymentsInvoice>("POST", "/invoice", {
    body: {
      price_amount: args.priceAmount,
      price_currency: args.priceCurrency.toLowerCase(),
      pay_currency: args.payCurrency?.toLowerCase(),
      order_id: args.orderId,
      order_description: args.orderDescription,
      ipn_callback_url: args.ipnCallbackUrl ?? config.ipnCallbackUrl,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    },
  });
}

export async function nowpaymentsGetPayment(paymentId: string): Promise<NowpaymentsPayment> {
  return npRequest<NowpaymentsPayment>("GET", `/payment/${encodeURIComponent(paymentId)}`);
}

export async function nowpaymentsListPayments(args: { limit?: number; page?: number; dateFrom?: string; dateTo?: string } = {}): Promise<{ data: NowpaymentsPayment[]; limit?: number; page?: number; totalCount?: number }> {
  return npRequest("GET", "/payment/", {
    query: {
      limit: args.limit,
      page: args.page,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    },
  });
}

// Refunds on NOWPayments are typically support-mediated; we draft a request rather than auto-submit.
export interface NowpaymentsRefundDraft {
  paymentId: string;
  reason: string;
  recipientAddress?: string;
  status: "drafted_manual";
  note: string;
}

export function nowpaymentsRefundDraft(args: { paymentId: string; reason: string; recipientAddress?: string }): NowpaymentsRefundDraft {
  return {
    paymentId: args.paymentId,
    reason: args.reason,
    recipientAddress: args.recipientAddress,
    status: "drafted_manual",
    note:
      "NOWPayments refunds are partial and support-mediated. Submit this draft to NOWPayments support along with the payment_id; do not assume automatic refund.",
  };
}

// -----------------------------------------------------------------------------
// IPN signature verification
// (sort body keys alphabetically, JSON.stringify, HMAC-SHA512 with IPN secret)
// -----------------------------------------------------------------------------

export function canonicalizeForIpn(obj: unknown): string {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const o = obj as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(o).sort()) {
    sorted[key] = o[key];
  }
  return JSON.stringify(sorted);
}

export async function verifyNowpaymentsIpn(args: { rawBody: string; sigHeader: string }): Promise<{ valid: boolean; reason?: string; parsed?: unknown }> {
  const { ipnSecret } = await requireConfig();
  if (!ipnSecret) return { valid: false, reason: "no IPN secret configured" };
  if (!args.sigHeader) return { valid: false, reason: "missing x-nowpayments-sig header" };
  let parsed: unknown;
  try { parsed = JSON.parse(args.rawBody); }
  catch { return { valid: false, reason: "body is not valid JSON" }; }
  const canonical = canonicalizeForIpn(parsed);
  const expected = createHmac("sha512", ipnSecret).update(canonical).digest("hex");
  const ok = expected.toLowerCase() === args.sigHeader.trim().toLowerCase();
  return { valid: ok, reason: ok ? undefined : "signature mismatch", parsed };
}

export async function nowpaymentsRedactedConfig(): Promise<{ environment: NowpaymentsConfig["environment"]; baseUrl: string; ipnCallbackUrl?: string; apiKeyConfigured: boolean; ipnSecretConfigured: boolean; configuredAt?: string; updatedAt?: string } | null> {
  const c = await readNowpaymentsConfig();
  if (!c) return null;
  return {
    environment: c.environment,
    baseUrl: c.baseUrl,
    ipnCallbackUrl: c.ipnCallbackUrl,
    apiKeyConfigured: true,
    ipnSecretConfigured: !!c.encryptedIpnSecret,
    configuredAt: c.configuredAt,
    updatedAt: c.updatedAt,
  };
}
