import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;

export const EVM_CHAINS: Record<number, { name: string; symbol: string; explorer?: string }> = {
  1: { name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" },
  8453: { name: "Base", symbol: "ETH", explorer: "https://basescan.org" },
  137: { name: "Polygon", symbol: "POL", explorer: "https://polygonscan.com" },
  42161: { name: "Arbitrum One", symbol: "ETH", explorer: "https://arbiscan.io" },
  10: { name: "Optimism", symbol: "ETH", explorer: "https://optimistic.etherscan.io" },
};

export const DEFAULT_EVM_CHAIN_IDS = [1, 8453];

export interface EvmEncryptedPayload {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  params: { n: number; r: number; p: number; keyLen: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EvmAgentMetadata {
  purpose?: string;
  maxBalance?: string;
  allowedCounterparties?: string[];
  allowedCategories?: string[];
  expiresAt?: string;
  fallbackApproval?: "passphrase" | "wallet_handoff" | "deny";
  paused?: boolean;
  updatedAt: string;
}

export type EvmAccountingBucket = "reserved" | "submitted" | "confirmed" | "failed" | "expired";

export interface EvmCap {
  chainId: number;
  asset: string;
  maxPerTx: string;
  dailyLimit?: string;
}

export interface EvmCapAccounting {
  day: string;
  reserved: string;
  submitted: string;
  confirmed: string;
  failed: string;
  expired: string;
}

export interface EvmLowValuePolicy {
  enabled: boolean;
  caps: EvmCap[];
  day?: string;
  accounting?: Record<string, EvmCapAccounting>;
  configuredAt: string;
}

export interface EvmWalletRecord {
  name: string;
  address: string;
  publicKey: string;
  algorithm: "secp256k1-EVM";
  keyProtection: "passphrase" | "local_machine_key";
  createdAt: string;
  encryptedPrivateKey: EvmEncryptedPayload;
  allowedChainIds: number[];
  allowedAssets: string[];
  agent?: EvmAgentMetadata;
  lowValue?: EvmLowValuePolicy;
}

export interface EvmWalletStore {
  schemaVersion: 1;
  wallets: EvmWalletRecord[];
}

export interface EvmWalletSummary {
  name: string;
  address: string;
  publicKey: string;
  algorithm: "secp256k1-EVM";
  keyProtection: "passphrase" | "local_machine_key";
  createdAt: string;
  allowedChainIds: number[];
  allowedAssets: string[];
  agent?: EvmAgentMetadata;
  lowValue?: EvmLowValuePolicy;
}

export function evmWalletStorePath(): string {
  return process.env.LYTH_MCP_EVM_WALLET_STORE || join(homedir(), ".lyth_mcp", "evm_wallets.json");
}

export function evmHotKeyPath(): string {
  return process.env.LYTH_MCP_EVM_HOT_KEY || join(homedir(), ".lyth_mcp", "evm_hot.key");
}

export function evmLocalKeyPath(): string {
  return process.env.LYTH_MCP_EVM_LOCAL_KEY || join(homedir(), ".lyth_mcp", "evm_local.key");
}

export async function readEvmWalletStore(path = evmWalletStorePath()): Promise<EvmWalletStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as EvmWalletStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.wallets)) {
      throw new Error(`unsupported EVM wallet store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, wallets: [] };
    }
    throw err;
  }
}

export async function writeEvmWalletStore(store: EvmWalletStore, path = evmWalletStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function evmWalletStoreInfo(path = evmWalletStorePath()) {
  const store = await readEvmWalletStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
    mode = null;
  }
  return {
    path,
    walletCount: store.wallets.length,
    wallets: store.wallets.map(summarizeEvmWallet),
    hotKeyPath: evmHotKeyPath(),
    localKeyPath: evmLocalKeyPath(),
    fileMode: mode,
  };
}

export async function createEvmWallet(args: {
  name: string;
  passphrase?: string;
  revealPrivateKey?: boolean;
  overwrite?: boolean;
  allowLocalKey?: boolean;
  allowedChainIds?: number[];
  allowedAssets?: string[];
  agent?: Omit<EvmAgentMetadata, "updatedAt">;
  lowValue?: {
    enabled: boolean;
    caps: EvmCap[];
  };
}): Promise<EvmWalletSummary & { privateKey?: string; storePath: string }> {
  const allowedChainIds = normalizeChainIds(args.allowedChainIds ?? DEFAULT_EVM_CHAIN_IDS);
  const allowedAssets = normalizeAssets(args.allowedAssets ?? ["ETH", "USDC", "USDT"]);
  if (args.lowValue?.enabled) {
    validateCaps(args.lowValue.caps, allowedChainIds, allowedAssets);
  }

  const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
  const store = await readEvmWalletStore();
  const existing = store.wallets.find((w) => w.name === args.name);
  if (existing && !args.overwrite) {
    throw new Error(`evm wallet '${args.name}' already exists`);
  }

  const privBytes = secp256k1.utils.randomSecretKey();
  const privHex = bytesToHex(privBytes);
  const { address, publicKeyHex } = deriveEvmAddress(privBytes);

  const record: EvmWalletRecord = {
    name: args.name,
    address,
    publicKey: publicKeyHex,
    algorithm: "secp256k1-EVM",
    keyProtection: key.protection,
    createdAt: new Date().toISOString(),
    encryptedPrivateKey: encryptSecret(privHex, key.secret),
    allowedChainIds,
    allowedAssets,
  };
  if (args.agent) {
    record.agent = { ...args.agent, updatedAt: new Date().toISOString() };
  }
  if (args.lowValue?.enabled) {
    record.lowValue = {
      enabled: true,
      caps: args.lowValue.caps,
      day: todayKey(),
      accounting: {},
      configuredAt: new Date().toISOString(),
    };
  }

  const next = existing
    ? store.wallets.map((w) => (w.name === args.name ? record : w))
    : [...store.wallets, record];
  await writeEvmWalletStore({ schemaVersion: STORE_VERSION, wallets: next });

  return {
    ...summarizeEvmWallet(record),
    privateKey: args.revealPrivateKey ? `0x${privHex}` : undefined,
    storePath: evmWalletStorePath(),
  };
}

export async function importEvmWallet(args: {
  name: string;
  privateKey: string;
  passphrase?: string;
  overwrite?: boolean;
  allowLocalKey?: boolean;
  allowedChainIds?: number[];
  allowedAssets?: string[];
  agent?: Omit<EvmAgentMetadata, "updatedAt">;
}): Promise<EvmWalletSummary & { storePath: string }> {
  const allowedChainIds = normalizeChainIds(args.allowedChainIds ?? DEFAULT_EVM_CHAIN_IDS);
  const allowedAssets = normalizeAssets(args.allowedAssets ?? ["ETH", "USDC", "USDT"]);
  const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
  const privHex = normalizePrivateKey(args.privateKey);
  const privBytes = hexToBytes(privHex);
  const { address, publicKeyHex } = deriveEvmAddress(privBytes);

  const store = await readEvmWalletStore();
  const existing = store.wallets.find((w) => w.name === args.name);
  if (existing && !args.overwrite) {
    throw new Error(`evm wallet '${args.name}' already exists`);
  }
  const record: EvmWalletRecord = {
    name: args.name,
    address,
    publicKey: publicKeyHex,
    algorithm: "secp256k1-EVM",
    keyProtection: key.protection,
    createdAt: new Date().toISOString(),
    encryptedPrivateKey: encryptSecret(privHex, key.secret),
    allowedChainIds,
    allowedAssets,
  };
  if (args.agent) {
    record.agent = { ...args.agent, updatedAt: new Date().toISOString() };
  }
  const next = existing
    ? store.wallets.map((w) => (w.name === args.name ? record : w))
    : [...store.wallets, record];
  await writeEvmWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
  return { ...summarizeEvmWallet(record), storePath: evmWalletStorePath() };
}

export async function listEvmWallets(): Promise<EvmWalletSummary[]> {
  return (await readEvmWalletStore()).wallets.map(summarizeEvmWallet);
}

export async function getEvmWallet(name: string): Promise<EvmWalletRecord> {
  const record = (await readEvmWalletStore()).wallets.find((w) => w.name === name);
  if (!record) {
    throw new Error(`evm wallet '${name}' not found`);
  }
  return record;
}

export async function exportEvmPrivateKey(name: string, passphrase?: string): Promise<string> {
  const record = await getEvmWallet(name);
  const secret = await resolveWalletKey(record, passphrase);
  return `0x${decryptSecret(record.encryptedPrivateKey, secret)}`;
}

export async function unlockEvmPrivateKeyBytes(name: string, passphrase?: string): Promise<Uint8Array> {
  const record = await getEvmWallet(name);
  const secret = await resolveWalletKey(record, passphrase);
  return hexToBytes(decryptSecret(record.encryptedPrivateKey, secret));
}

export async function configureEvmLowValuePolicy(args: {
  name: string;
  enabled: boolean;
  caps?: EvmCap[];
}): Promise<EvmWalletSummary> {
  const store = await readEvmWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    throw new Error(`evm wallet '${args.name}' not found`);
  }
  const record = store.wallets[index]!;
  if (!args.enabled) {
    delete record.lowValue;
    await writeEvmWalletStore(store);
    return summarizeEvmWallet(record);
  }
  if (!args.caps || args.caps.length === 0) {
    throw new Error("caps required when enabling EVM low-value mode");
  }
  validateCaps(args.caps, record.allowedChainIds, record.allowedAssets);
  record.lowValue = {
    enabled: true,
    caps: args.caps,
    day: todayKey(),
    accounting: record.lowValue?.accounting ?? {},
    configuredAt: new Date().toISOString(),
  };
  store.wallets[index] = record;
  await writeEvmWalletStore(store);
  return summarizeEvmWallet(record);
}

export async function updateEvmAgentMetadata(args: {
  name: string;
  patch: Partial<Omit<EvmAgentMetadata, "updatedAt">>;
}): Promise<EvmWalletSummary> {
  const store = await readEvmWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    throw new Error(`evm wallet '${args.name}' not found`);
  }
  const record = store.wallets[index]!;
  record.agent = { ...(record.agent ?? {}), ...args.patch, updatedAt: new Date().toISOString() };
  store.wallets[index] = record;
  await writeEvmWalletStore(store);
  return summarizeEvmWallet(record);
}

export async function pauseEvmWallet(name: string): Promise<EvmWalletSummary> {
  await configureEvmLowValuePolicy({ name, enabled: false });
  return updateEvmAgentMetadata({
    name,
    patch: { paused: true, fallbackApproval: "deny" },
  });
}

export async function deleteEvmWallet(name: string, confirmName: string): Promise<{ deleted: boolean; storePath: string }> {
  if (name !== confirmName) {
    throw new Error("confirmName must exactly match name");
  }
  const store = await readEvmWalletStore();
  const next = store.wallets.filter((w) => w.name !== name);
  if (next.length === store.wallets.length) {
    throw new Error(`evm wallet '${name}' not found`);
  }
  await writeEvmWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
  return { deleted: true, storePath: evmWalletStorePath() };
}

export async function removeEvmWalletStoreForTestsOnly(path: string): Promise<void> {
  await unlink(path);
}

export interface EvmFundingDraft {
  network: "evm";
  chainId: number;
  chainName: string;
  asset: string;
  amount: string;
  recipientAddress: string;
  purpose: string;
  expiresAt?: string;
  walletName: string;
  message: string;
  warning: string;
}

export async function draftEvmFundingRequest(args: {
  name: string;
  chainId: number;
  asset: string;
  amount: string;
  purpose: string;
  expiresAt?: string;
}): Promise<EvmFundingDraft> {
  const wallet = await getEvmWallet(args.name);
  const chain = EVM_CHAINS[args.chainId];
  if (!chain) {
    throw new Error(`unsupported EVM chain ${args.chainId}`);
  }
  if (!wallet.allowedChainIds.includes(args.chainId)) {
    throw new Error(`evm wallet '${args.name}' is not configured for chain ${args.chainId} (${chain.name})`);
  }
  const asset = args.asset.toUpperCase();
  if (!wallet.allowedAssets.includes(asset)) {
    throw new Error(`evm wallet '${args.name}' is not configured for asset ${asset}`);
  }
  validateDecimal(args.amount);
  return {
    network: "evm",
    chainId: args.chainId,
    chainName: chain.name,
    asset,
    amount: args.amount,
    recipientAddress: wallet.address,
    purpose: args.purpose,
    expiresAt: args.expiresAt,
    walletName: args.name,
    message: `Send up to ${args.amount} ${asset} on ${chain.name} to ${wallet.address} for: ${args.purpose}`,
    warning:
      "This is a low-value EVM operating wallet. Only fund the amount approved for this task. Bridges and centralized exchanges cannot be reversed.",
  };
}

export interface EvmDrainDraftStub {
  network: "evm";
  chainId: number;
  chainName: string;
  walletName: string;
  fromAddress: string;
  toAddress: string;
  assets: string[];
  note: string;
}

export async function draftEvmDrain(args: {
  name: string;
  chainId: number;
  toAddress: string;
}): Promise<EvmDrainDraftStub> {
  const wallet = await getEvmWallet(args.name);
  const chain = EVM_CHAINS[args.chainId];
  if (!chain) {
    throw new Error(`unsupported EVM chain ${args.chainId}`);
  }
  if (!wallet.allowedChainIds.includes(args.chainId)) {
    throw new Error(`evm wallet '${args.name}' is not configured for chain ${args.chainId}`);
  }
  if (!isAddress(args.toAddress)) {
    throw new Error(`invalid EVM address: ${args.toAddress}`);
  }
  return {
    network: "evm",
    chainId: args.chainId,
    chainName: chain.name,
    walletName: args.name,
    fromAddress: wallet.address,
    toAddress: args.toAddress,
    assets: wallet.allowedAssets,
    note: "Draft only. ERC-20 + native transfer builders land in P14.1; signing/broadcast remain TODO until then.",
  };
}

export interface EvmCapDecision {
  ok: boolean;
  reason?: string;
  cap?: EvmCap;
  accountingKey?: string;
  before?: EvmCapAccounting;
}

export function checkEvmCap(
  policy: EvmLowValuePolicy | undefined,
  chainId: number,
  asset: string,
  amount: string,
): EvmCapDecision {
  if (!policy?.enabled) {
    return { ok: false, reason: "low-value mode disabled" };
  }
  const cap = policy.caps.find((c) => c.chainId === chainId && c.asset.toUpperCase() === asset.toUpperCase());
  if (!cap) {
    return { ok: false, reason: `no cap configured for chain ${chainId} / ${asset}` };
  }
  const requested = parseDecimal(amount);
  const maxPerTx = parseDecimal(cap.maxPerTx);
  if (requested > maxPerTx) {
    return { ok: false, reason: `amount ${amount} ${asset} exceeds per-tx cap ${cap.maxPerTx}`, cap };
  }
  const key = capKey(chainId, asset);
  const acct = freshenAccounting(policy.accounting?.[key]);
  if (cap.dailyLimit) {
    const daily = parseDecimal(cap.dailyLimit);
    const locked = parseDecimal(acct.reserved) + parseDecimal(acct.submitted) + parseDecimal(acct.confirmed);
    if (locked + requested > daily) {
      return {
        ok: false,
        reason: `amount ${amount} ${asset} exceeds daily limit ${cap.dailyLimit} (locked today ${formatDecimal(locked)})`,
        cap,
        accountingKey: key,
        before: acct,
      };
    }
  }
  return { ok: true, cap, accountingKey: key, before: acct };
}

export async function moveEvmAccounting(args: {
  name: string;
  chainId: number;
  asset: string;
  amount: string;
  from: EvmAccountingBucket;
  to: EvmAccountingBucket;
}): Promise<EvmCapAccounting | null> {
  const amount = parseDecimal(args.amount);
  const store = await readEvmWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    return null;
  }
  const record = store.wallets[index]!;
  if (!record.lowValue) {
    return null;
  }
  if (!record.lowValue.accounting) {
    record.lowValue.accounting = {};
  }
  const key = capKey(args.chainId, args.asset);
  const acct = freshenAccounting(record.lowValue.accounting[key]);
  const fromValue = parseDecimal(acct[args.from]);
  acct[args.from] = formatDecimal(fromValue > amount ? fromValue - amount : 0n);
  acct[args.to] = formatDecimal(parseDecimal(acct[args.to]) + amount);
  record.lowValue.accounting[key] = acct;
  store.wallets[index] = record;
  await writeEvmWalletStore(store);
  return acct;
}

export async function reserveEvmCap(args: {
  name: string;
  chainId: number;
  asset: string;
  amount: string;
}): Promise<EvmCapAccounting | null> {
  const store = await readEvmWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    return null;
  }
  const record = store.wallets[index]!;
  if (!record.lowValue) {
    return null;
  }
  if (!record.lowValue.accounting) {
    record.lowValue.accounting = {};
  }
  const key = capKey(args.chainId, args.asset);
  const acct = freshenAccounting(record.lowValue.accounting[key]);
  acct.reserved = formatDecimal(parseDecimal(acct.reserved) + parseDecimal(args.amount));
  record.lowValue.accounting[key] = acct;
  store.wallets[index] = record;
  await writeEvmWalletStore(store);
  return acct;
}

export function summarizeEvmWallet(record: EvmWalletRecord): EvmWalletSummary {
  return {
    name: record.name,
    address: record.address,
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    keyProtection: record.keyProtection,
    createdAt: record.createdAt,
    allowedChainIds: record.allowedChainIds,
    allowedAssets: record.allowedAssets,
    agent: record.agent,
    lowValue: record.lowValue,
  };
}

export function deriveEvmAddress(privBytes: Uint8Array): { address: string; publicKeyHex: string } {
  const pubFull = secp256k1.getPublicKey(privBytes, false);
  // pubFull is 65 bytes: 0x04 || X(32) || Y(32). Address is keccak256(X||Y)[12:].
  const pubXY = pubFull.subarray(1);
  const hash = keccak_256(pubXY);
  const addrBytes = hash.subarray(12);
  return {
    address: toChecksumAddress(`0x${bytesToHex(addrBytes)}`),
    publicKeyHex: `0x${bytesToHex(pubXY)}`,
  };
}

export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hashHex = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    if (/[0-9]/.test(c)) {
      out += c;
    } else {
      out += parseInt(hashHex[i]!, 16) >= 8 ? c.toUpperCase() : c;
    }
  }
  return out;
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizePrivateKey(input: string): string {
  const hex = input.trim().replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("invalid EVM private key (expected 32-byte hex)");
  }
  return hex;
}

function normalizeChainIds(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`invalid chain id: ${id}`);
    }
    if (!EVM_CHAINS[id]) {
      throw new Error(`unsupported EVM chain ${id} (supported: ${Object.keys(EVM_CHAINS).join(", ")})`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length === 0) {
    throw new Error("at least one EVM chain id is required");
  }
  return out;
}

function normalizeAssets(assets: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of assets) {
    const sym = a.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(sym)) {
      throw new Error(`invalid asset symbol: ${a}`);
    }
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  if (out.length === 0) {
    throw new Error("at least one asset symbol is required");
  }
  return out;
}

function validateCaps(caps: EvmCap[], allowedChainIds: number[], allowedAssets: string[]): void {
  for (const cap of caps) {
    if (!allowedChainIds.includes(cap.chainId)) {
      throw new Error(`cap references chain ${cap.chainId} which is not in allowedChainIds`);
    }
    const asset = cap.asset.toUpperCase();
    if (!allowedAssets.includes(asset)) {
      throw new Error(`cap references asset ${asset} which is not in allowedAssets`);
    }
    validateDecimal(cap.maxPerTx);
    if (cap.dailyLimit) {
      validateDecimal(cap.dailyLimit);
    }
  }
}

function validateDecimal(input: string): void {
  if (!/^\d+(\.\d+)?$/.test(input.trim())) {
    throw new Error(`invalid decimal amount: ${input}`);
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function capKey(chainId: number, asset: string): string {
  return `${chainId}:${asset.toUpperCase()}`;
}

function freshenAccounting(existing?: EvmCapAccounting): EvmCapAccounting {
  const today = todayKey();
  if (!existing || existing.day !== today) {
    return { day: today, reserved: "0", submitted: "0", confirmed: "0", failed: "0", expired: "0" };
  }
  return { ...existing };
}

const DECIMAL_SCALE = 18;

function parseDecimal(input: string): bigint {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal: ${input}`);
  }
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = abs.split(".");
  if (frac.length > DECIMAL_SCALE) {
    throw new Error(`too many decimal places (max ${DECIMAL_SCALE}): ${input}`);
  }
  const padded = whole + frac.padEnd(DECIMAL_SCALE, "0");
  const value = BigInt(padded);
  return negative ? -value : value;
}

function formatDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const raw = abs.toString().padStart(DECIMAL_SCALE + 1, "0");
  const whole = raw.slice(0, -DECIMAL_SCALE);
  const frac = raw.slice(-DECIMAL_SCALE).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

function encryptSecret(secret: string, passphrase: string): EvmEncryptedPayload {
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

function decryptSecret(payload: EvmEncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(passphrase, salt, payload.params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: EvmEncryptedPayload["params"] = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN },
): Buffer {
  return scryptSync(passphrase, salt, params.keyLen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
}

async function resolveNewWalletKey(
  passphrase: string | undefined,
  allowLocalKey: boolean,
): Promise<{ protection: "passphrase" | "local_machine_key"; secret: string }> {
  const configured = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
  if (configured) {
    if (configured.length < 12) {
      throw new Error("wallet passphrase must be at least 12 characters");
    }
    return { protection: "passphrase", secret: configured };
  }
  if (allowLocalKey) {
    return { protection: "local_machine_key", secret: await readOrCreateKey(evmLocalKeyPath()) };
  }
  throw new Error("evm wallet passphrase missing; pass it explicitly, set LYTH_MCP_WALLET_PASSPHRASE, or set allowLocalKey for low-value setup");
}

async function resolveWalletKey(record: EvmWalletRecord, passphrase?: string): Promise<string> {
  if (record.keyProtection === "local_machine_key") {
    return readOrCreateKey(evmLocalKeyPath());
  }
  const resolved = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
  if (!resolved) {
    throw new Error("wallet passphrase missing; pass it explicitly or set LYTH_MCP_WALLET_PASSPHRASE");
  }
  if (resolved.length < 12) {
    throw new Error("wallet passphrase must be at least 12 characters");
  }
  return resolved;
}

async function readOrCreateKey(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const key = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(input: string): Uint8Array {
  const hex = input.replace(/^0x/, "");
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must be even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
