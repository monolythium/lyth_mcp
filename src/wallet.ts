import {
  buildPlaintextSubmission,
  bytesToHex,
  generatePqm1Mnemonic,
  MlDsa65Backend,
  pqm1MnemonicToAddress,
  pqm1MnemonicToMlDsa65Backend,
  type NativeEvmTxFields,
  type PlaintextSubmission,
} from "@monolythium/core-sdk/crypto";
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

export interface WalletRecord {
  name: string;
  address: string;
  publicKey: string;
  algorithm: "PQM1-MLDSA65";
  keyProtection?: "passphrase" | "local_machine_key";
  createdAt: string;
  encryptedMnemonic: EncryptedPayload;
  lowValue?: LowValuePolicy;
  agent?: AgentWalletMetadata;
}

export interface WalletStore {
  schemaVersion: 1;
  wallets: WalletRecord[];
}

export interface LowValuePolicy {
  enabled: boolean;
  asset: "LYTH";
  maxAmount: string;
  dailyLimit?: string;
  day?: string;
  spentToday?: string;
  reservedToday?: string;
  submittedToday?: string;
  confirmedToday?: string;
  failedToday?: string;
  expiredToday?: string;
  configuredAt: string;
  encryptedMnemonic: EncryptedPayload;
}

export type LowValueAccountingBucket = "reserved" | "submitted" | "confirmed" | "failed" | "expired";

export interface LowValueAccountingSummary {
  day: string;
  reserved: string;
  submitted: string;
  confirmed: string;
  failed: string;
  expired: string;
  totalLocked: string;
  remainingToday?: string;
}

export interface AgentWalletMetadata {
  purpose?: string;
  network?: string;
  maxBalance?: string;
  allowedCounterparties?: string[];
  allowedCategories?: string[];
  expiresAt?: string;
  fallbackApproval?: "passphrase" | "wallet_handoff" | "deny";
  paused?: boolean;
  updatedAt: string;
}

export interface EncryptedPayload {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  params: {
    n: number;
    r: number;
    p: number;
    keyLen: number;
  };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface WalletSummary {
  name: string;
  address: string;
  publicKey: string;
  algorithm: WalletRecord["algorithm"];
  keyProtection: "passphrase" | "local_machine_key";
  createdAt: string;
  lowValue?: Omit<LowValuePolicy, "encryptedMnemonic"> & { accounting?: LowValueAccountingSummary };
  agent?: AgentWalletMetadata;
}

export interface BuiltTransfer {
  wallet: WalletSummary;
  tx: NativeEvmTxFields;
  walletRequest: {
    method: "eth_sendTransaction";
    params: Array<{
      from: string;
      to: string;
      value: string;
      data: string;
      gas: string;
      nonce: string;
      chainId: string;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    }>;
  };
  signed?: {
    mode: "passphrase" | "local_machine_key" | "low_value";
    /**
     * Submission path this build will broadcast through. The chain runs a
     * plaintext mempool, so builds always target `mesh_submitTx`.
     */
    submitMethod: "mesh_submitTx";
    /**
     * Canonical native tx hash the node echoes/validates on the plaintext
     * path.
     */
    innerTxHashHex: string;
    signedInnerTxHex: string;
    innerSighashHex: string;
    innerWireBytes: number;
    /**
     * Bincode `SignedTransaction` wire hex, submitted verbatim through the
     * plaintext `mesh_submitTx` path.
     */
    signedTxWireHex: string;
  };
  lowValuePolicy?: {
    used: boolean;
    remainingToday?: string;
    accounting?: LowValueAccountingSummary;
    warning?: string;
  };
}

export function walletStorePath(): string {
  return process.env.LYTH_MCP_WALLET_STORE || join(homedir(), ".lyth_mcp", "wallets.json");
}

export function hotKeyPath(): string {
  return process.env.LYTH_MCP_HOT_KEY || join(homedir(), ".lyth_mcp", "hot.key");
}

export function localKeyPath(): string {
  return process.env.LYTH_MCP_LOCAL_KEY || join(homedir(), ".lyth_mcp", "local.key");
}

export function resolvePassphrase(passphrase?: string): string {
  const resolved = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
  if (!resolved) {
    throw new Error("wallet passphrase missing; pass it explicitly or set LYTH_MCP_WALLET_PASSPHRASE");
  }
  if (resolved.length < 12) {
    throw new Error("wallet passphrase must be at least 12 characters");
  }
  return resolved;
}

export async function readWalletStore(path = walletStorePath()): Promise<WalletStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as WalletStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.wallets)) {
      throw new Error(`unsupported wallet store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, wallets: [] };
    }
    throw err;
  }
}

export async function writeWalletStore(store: WalletStore, path = walletStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function walletStoreInfo(path = walletStorePath()) {
  const store = await readWalletStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
    mode = null;
  }
  return {
    path,
    walletCount: store.wallets.length,
    wallets: store.wallets.map(summarizeWallet),
    hotKeyPath: hotKeyPath(),
    localKeyPath: localKeyPath(),
    fileMode: mode,
  };
}

export async function createWallet(args: {
  name: string;
  passphrase?: string;
  revealMnemonic?: boolean;
  overwrite?: boolean;
  allowLocalKey?: boolean;
  lowValue?: {
    enabled: boolean;
    maxAmount: string;
    dailyLimit?: string;
  };
  agent?: Omit<AgentWalletMetadata, "updatedAt">;
}): Promise<WalletSummary & { mnemonic?: string; storePath: string }> {
  const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
  const store = await readWalletStore();
  const existing = store.wallets.find((w) => w.name === args.name);
  if (existing && !args.overwrite) {
    throw new Error(`wallet '${args.name}' already exists`);
  }

  const mnemonic = generatePqm1Mnemonic();
  const backend = pqm1MnemonicToMlDsa65Backend(mnemonic);
  const record: WalletRecord = {
    name: args.name,
    address: backend.getAddress(),
    publicKey: bytesToHex(backend.publicKey()),
    algorithm: "PQM1-MLDSA65",
    keyProtection: key.protection,
    createdAt: new Date().toISOString(),
    encryptedMnemonic: encryptSecret(mnemonic, key.secret),
  };
  if (args.lowValue?.enabled) {
    record.lowValue = await createLowValuePolicy(mnemonic, args.lowValue.maxAmount, args.lowValue.dailyLimit);
  }
  if (args.agent) {
    record.agent = {
      ...args.agent,
      updatedAt: new Date().toISOString(),
    };
  }

  const next = existing
    ? store.wallets.map((w) => (w.name === args.name ? record : w))
    : [...store.wallets, record];
  await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });

  return {
    ...summarizeWallet(record),
    mnemonic: args.revealMnemonic ? mnemonic : undefined,
    storePath: walletStorePath(),
  };
}

export async function importWallet(args: {
  name: string;
  mnemonic: string;
  passphrase?: string;
  overwrite?: boolean;
  allowLocalKey?: boolean;
  lowValue?: {
    enabled: boolean;
    maxAmount: string;
    dailyLimit?: string;
  };
  agent?: Omit<AgentWalletMetadata, "updatedAt">;
}): Promise<WalletSummary & { storePath: string }> {
  const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
  const address = pqm1MnemonicToAddress(args.mnemonic);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const store = await readWalletStore();
  const existing = store.wallets.find((w) => w.name === args.name);
  if (existing && !args.overwrite) {
    throw new Error(`wallet '${args.name}' already exists`);
  }
  const record: WalletRecord = {
    name: args.name,
    address,
    publicKey: bytesToHex(backend.publicKey()),
    algorithm: "PQM1-MLDSA65",
    keyProtection: key.protection,
    createdAt: new Date().toISOString(),
    encryptedMnemonic: encryptSecret(args.mnemonic, key.secret),
  };
  if (args.lowValue?.enabled) {
    record.lowValue = await createLowValuePolicy(args.mnemonic, args.lowValue.maxAmount, args.lowValue.dailyLimit);
  }
  if (args.agent) {
    record.agent = {
      ...args.agent,
      updatedAt: new Date().toISOString(),
    };
  }
  const next = existing
    ? store.wallets.map((w) => (w.name === args.name ? record : w))
    : [...store.wallets, record];
  await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
  return { ...summarizeWallet(record), storePath: walletStorePath() };
}

export async function listWallets(): Promise<WalletSummary[]> {
  return (await readWalletStore()).wallets.map(summarizeWallet);
}

export async function getWallet(name: string): Promise<WalletRecord> {
  const record = (await readWalletStore()).wallets.find((w) => w.name === name);
  if (!record) {
    throw new Error(`wallet '${name}' not found`);
  }
  return record;
}

export async function exportMnemonic(name: string, passphrase?: string): Promise<string> {
  const record = await getWallet(name);
  return decryptSecret(record.encryptedMnemonic, await resolveWalletKey(record, passphrase));
}

export async function configureLowValuePolicy(args: {
  name: string;
  passphrase?: string;
  enabled: boolean;
  maxAmount?: string;
  dailyLimit?: string;
}): Promise<WalletSummary> {
  const store = await readWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    throw new Error(`wallet '${args.name}' not found`);
  }
  const record = store.wallets[index]!;
  if (!args.enabled) {
    delete record.lowValue;
    await writeWalletStore(store);
    return summarizeWallet(record);
  }
  if (!args.maxAmount) {
    throw new Error("maxAmount is required when enabling low-value mode");
  }
  const mnemonic = decryptSecret(record.encryptedMnemonic, await resolveWalletKey(record, args.passphrase));
  record.lowValue = await createLowValuePolicy(mnemonic, args.maxAmount, args.dailyLimit);
  await writeWalletStore(store);
  return summarizeWallet(record);
}

export async function updateAgentWalletMetadata(args: {
  name: string;
  patch: Partial<Omit<AgentWalletMetadata, "updatedAt">>;
}): Promise<WalletSummary> {
  const store = await readWalletStore();
  const index = store.wallets.findIndex((w) => w.name === args.name);
  if (index < 0) {
    throw new Error(`wallet '${args.name}' not found`);
  }
  const record = store.wallets[index]!;
  record.agent = {
    ...(record.agent ?? {}),
    ...args.patch,
    updatedAt: new Date().toISOString(),
  };
  store.wallets[index] = record;
  await writeWalletStore(store);
  return summarizeWallet(record);
}

export async function deleteWallet(name: string, confirmName: string): Promise<{ deleted: boolean; storePath: string }> {
  if (name !== confirmName) {
    throw new Error("confirmName must exactly match name");
  }
  const store = await readWalletStore();
  const next = store.wallets.filter((w) => w.name !== name);
  if (next.length === store.wallets.length) {
    throw new Error(`wallet '${name}' not found`);
  }
  await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
  return { deleted: true, storePath: walletStorePath() };
}

export async function removeWalletStoreForTestsOnly(path: string): Promise<void> {
  await unlink(path);
}

export async function unlockBackend(name: string, passphrase?: string): Promise<MlDsa65Backend> {
  const mnemonic = await exportMnemonic(name, passphrase);
  return pqm1MnemonicToMlDsa65Backend(mnemonic);
}

export async function buildTransfer(args: {
  walletName: string;
  to: string;
  amountUnits: bigint;
  chainId: number;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  input?: string;
  passphrase?: string;
  sign?: boolean;
  allowLowValueSigning?: boolean;
  allowLocalKeySigning?: boolean;
}): Promise<BuiltTransfer> {
  const record = await getWallet(args.walletName);
  const tx: NativeEvmTxFields = {
    chainId: BigInt(args.chainId),
    nonce: args.nonce,
    maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    maxFeePerGas: args.maxFeePerGas,
    gasLimit: args.gasLimit,
    to: args.to,
    value: args.amountUnits,
    input: args.input ?? "0x",
  };
  const built: BuiltTransfer = {
    wallet: summarizeWallet(record),
    tx,
    walletRequest: {
      method: "eth_sendTransaction",
      params: [
        {
          from: record.address,
          to: args.to,
          value: toQuantity(args.amountUnits),
          data: args.input ?? "0x",
          gas: toQuantity(args.gasLimit),
          nonce: toQuantity(args.nonce),
          chainId: toQuantity(BigInt(args.chainId)),
          maxFeePerGas: toQuantity(args.maxFeePerGas),
          maxPriorityFeePerGas: toQuantity(args.maxPriorityFeePerGas),
        },
      ],
    },
  };

  const signer = args.sign === false
    ? null
    : await resolveSigningBackend({
        walletName: args.walletName,
        amountUnits: args.amountUnits,
        passphrase: args.passphrase,
        allowLowValueSigning: args.allowLowValueSigning ?? true,
        allowLocalKeySigning: args.allowLocalKeySigning ?? false,
      });
  if (signer !== null) {
    const backend = signer.backend;
    const signed = backend.signEvmTx(tx);
    // Plaintext bincode SignedTransaction submitted verbatim through
    // mesh_submitTx — the inclusion path on the plaintext mempool.
    const plaintext: PlaintextSubmission = buildPlaintextSubmission({ backend, tx });
    built.signed = {
      mode: signer.mode,
      submitMethod: "mesh_submitTx",
      innerTxHashHex: plaintext.innerTxHashHex,
      signedInnerTxHex: `0x${signed.wireHex}`,
      innerSighashHex: plaintext.innerSighashHex,
      innerWireBytes: plaintext.innerWireBytes,
      signedTxWireHex: plaintext.signedTxWireHex,
    };
    if (signer.mode === "low_value") {
      const updated = await recordLowValueSpend(args.walletName, args.amountUnits);
      built.lowValuePolicy = {
        used: true,
        remainingToday: updated.remainingToday,
        accounting: updated.accounting,
        warning: "Low-value mode signs without prompting for the passphrase. Keep only capped funds in this agent wallet.",
      };
    }
  }

  return built;
}

export function summarizeWallet(record: WalletRecord): WalletSummary {
  return {
    name: record.name,
    address: record.address,
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    keyProtection: walletKeyProtection(record),
    createdAt: record.createdAt,
    lowValue: record.lowValue
      ? {
          enabled: record.lowValue.enabled,
          asset: record.lowValue.asset,
          maxAmount: record.lowValue.maxAmount,
          dailyLimit: record.lowValue.dailyLimit,
          day: record.lowValue.day,
          spentToday: record.lowValue.spentToday,
          reservedToday: record.lowValue.reservedToday,
          submittedToday: record.lowValue.submittedToday,
          confirmedToday: record.lowValue.confirmedToday,
          failedToday: record.lowValue.failedToday,
          expiredToday: record.lowValue.expiredToday,
          accounting: summarizeLowValueAccounting(record.lowValue),
          configuredAt: record.lowValue.configuredAt,
        }
      : undefined,
    agent: record.agent,
  };
}

export function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function encryptSecret(secret: string, passphrase: string): EncryptedPayload {
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

function decryptSecret(payload: EncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(passphrase, salt, payload.params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: EncryptedPayload["params"] = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN },
): Buffer {
  return scryptSync(passphrase, salt, params.keyLen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
}

async function createLowValuePolicy(
  mnemonic: string,
  maxAmount: string,
  dailyLimit?: string,
): Promise<LowValuePolicy> {
  decimalToUnits(maxAmount);
  if (dailyLimit !== undefined) {
    decimalToUnits(dailyLimit);
  }
  return {
    enabled: true,
    asset: "LYTH",
    maxAmount,
    dailyLimit,
    day: todayKey(),
    spentToday: "0",
    reservedToday: "0",
    submittedToday: "0",
    confirmedToday: "0",
    failedToday: "0",
    expiredToday: "0",
    configuredAt: new Date().toISOString(),
    encryptedMnemonic: encryptSecret(mnemonic, await readOrCreateKey(hotKeyPath())),
  };
}

async function resolveSigningBackend(args: {
  walletName: string;
  amountUnits: bigint;
  passphrase?: string;
  allowLowValueSigning: boolean;
  allowLocalKeySigning: boolean;
}): Promise<{ mode: "passphrase" | "local_machine_key" | "low_value"; backend: MlDsa65Backend } | null> {
  const record = await getWallet(args.walletName);
  if (walletKeyProtection(record) === "passphrase" && (args.passphrase !== undefined || process.env.LYTH_MCP_WALLET_PASSPHRASE)) {
    return {
      mode: "passphrase",
      backend: await unlockBackend(args.walletName, args.passphrase),
    };
  }
  if (walletKeyProtection(record) === "local_machine_key" && args.allowLocalKeySigning) {
    return {
      mode: "local_machine_key",
      backend: await unlockBackend(args.walletName),
    };
  }
  if (!args.allowLowValueSigning) {
    return null;
  }
  const policy = record.lowValue;
  if (!policy?.enabled) {
    return null;
  }
  assertLowValueAllowed(policy, args.amountUnits);
  const mnemonic = decryptSecret(policy.encryptedMnemonic, await readOrCreateKey(hotKeyPath()));
  return {
    mode: "low_value",
    backend: pqm1MnemonicToMlDsa65Backend(mnemonic),
  };
}

function assertLowValueAllowed(policy: LowValuePolicy, amountUnits: bigint): void {
  const max = decimalToUnits(policy.maxAmount);
  if (amountUnits > max) {
    throw new Error(`amount exceeds low-value maxAmount ${policy.maxAmount} LYTH; passphrase required`);
  }
  if (policy.dailyLimit) {
    const spent = lowValueLockedUnits(policy);
    const daily = decimalToUnits(policy.dailyLimit);
    if (spent + amountUnits > daily) {
      throw new Error(`amount exceeds low-value dailyLimit ${policy.dailyLimit} LYTH; passphrase required`);
    }
  }
}

async function recordLowValueSpend(
  walletName: string,
  amountUnits: bigint,
): Promise<{ remainingToday?: string; accounting?: LowValueAccountingSummary }> {
  const store = await readWalletStore();
  const record = store.wallets.find((w) => w.name === walletName);
  if (!record?.lowValue) {
    return {};
  }
  resetLowValueDayIfNeeded(record.lowValue);
  const current = decimalToUnits(record.lowValue.reservedToday ?? record.lowValue.spentToday ?? "0");
  record.lowValue.reservedToday = unitsToDecimal(current + amountUnits);
  record.lowValue.spentToday = record.lowValue.reservedToday;
  await writeWalletStore(store);
  const accounting = summarizeLowValueAccounting(record.lowValue);
  return { remainingToday: accounting.remainingToday, accounting };
}

export async function moveLowValueAccounting(args: {
  walletName: string;
  amount: string;
  from: LowValueAccountingBucket;
  to: LowValueAccountingBucket;
}): Promise<LowValueAccountingSummary | null> {
  const amountUnits = decimalToUnits(args.amount);
  const store = await readWalletStore();
  const record = store.wallets.find((w) => w.name === args.walletName);
  if (!record?.lowValue) {
    return null;
  }
  resetLowValueDayIfNeeded(record.lowValue);
  const fromKey = lowValueBucketKey(args.from);
  const toKey = lowValueBucketKey(args.to);
  const fromValue = decimalToUnits(record.lowValue[fromKey] ?? "0");
  record.lowValue[fromKey] = unitsToDecimal(fromValue > amountUnits ? fromValue - amountUnits : 0n);
  record.lowValue[toKey] = unitsToDecimal(decimalToUnits(record.lowValue[toKey] ?? "0") + amountUnits);
  record.lowValue.spentToday = unitsToDecimal(lowValueLockedUnits(record.lowValue));
  await writeWalletStore(store);
  return summarizeLowValueAccounting(record.lowValue);
}

export function summarizeLowValueAccounting(policy: Omit<LowValuePolicy, "encryptedMnemonic">): LowValueAccountingSummary {
  const today = todayKey();
  if (policy.day !== today) {
    return {
      day: today,
      reserved: "0",
      submitted: "0",
      confirmed: "0",
      failed: "0",
      expired: "0",
      totalLocked: "0",
      remainingToday: policy.dailyLimit,
    };
  }
  const reserved = decimalToUnits(policy.reservedToday ?? policy.spentToday ?? "0");
  const submitted = decimalToUnits(policy.submittedToday ?? "0");
  const confirmed = decimalToUnits(policy.confirmedToday ?? "0");
  const failed = decimalToUnits(policy.failedToday ?? "0");
  const expired = decimalToUnits(policy.expiredToday ?? "0");
  const totalLocked = reserved + submitted + confirmed;
  const remainingToday = policy.dailyLimit
    ? decimalToUnits(policy.dailyLimit) - totalLocked
    : undefined;
  return {
    day: today,
    reserved: unitsToDecimal(reserved),
    submitted: unitsToDecimal(submitted),
    confirmed: unitsToDecimal(confirmed),
    failed: unitsToDecimal(failed),
    expired: unitsToDecimal(expired),
    totalLocked: unitsToDecimal(totalLocked),
    remainingToday: remainingToday === undefined ? undefined : unitsToDecimal(remainingToday < 0n ? 0n : remainingToday),
  };
}

function resetLowValueDayIfNeeded(policy: LowValuePolicy): void {
  const today = todayKey();
  if (policy.day === today) {
    policy.reservedToday ??= policy.spentToday ?? "0";
    policy.submittedToday ??= "0";
    policy.confirmedToday ??= "0";
    policy.failedToday ??= "0";
    policy.expiredToday ??= "0";
    return;
  }
  policy.day = today;
  policy.spentToday = "0";
  policy.reservedToday = "0";
  policy.submittedToday = "0";
  policy.confirmedToday = "0";
  policy.failedToday = "0";
  policy.expiredToday = "0";
}

function lowValueLockedUnits(policy: LowValuePolicy): bigint {
  if (policy.day !== todayKey()) {
    return 0n;
  }
  const reserved = decimalToUnits(policy.reservedToday ?? policy.spentToday ?? "0");
  const submitted = decimalToUnits(policy.submittedToday ?? "0");
  const confirmed = decimalToUnits(policy.confirmedToday ?? "0");
  return reserved + submitted + confirmed;
}

function lowValueBucketKey(bucket: LowValueAccountingBucket): "reservedToday" | "submittedToday" | "confirmedToday" | "failedToday" | "expiredToday" {
  switch (bucket) {
    case "reserved":
      return "reservedToday";
    case "submitted":
      return "submittedToday";
    case "confirmed":
      return "confirmedToday";
    case "failed":
      return "failedToday";
    case "expired":
      return "expiredToday";
  }
}

function walletKeyProtection(record: WalletRecord): "passphrase" | "local_machine_key" {
  return record.keyProtection ?? "passphrase";
}

async function resolveNewWalletKey(
  passphrase: string | undefined,
  allowLocalKey: boolean,
): Promise<{ protection: "passphrase" | "local_machine_key"; secret: string }> {
  const configured = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
  if (configured) {
    return { protection: "passphrase", secret: resolvePassphrase(passphrase) };
  }
  if (allowLocalKey) {
    return { protection: "local_machine_key", secret: await readOrCreateKey(localKeyPath()) };
  }
  throw new Error("wallet passphrase missing; pass it explicitly, set LYTH_MCP_WALLET_PASSPHRASE, or use low-value local-key setup");
}

async function resolveWalletKey(record: WalletRecord, passphrase?: string): Promise<string> {
  if (walletKeyProtection(record) === "local_machine_key") {
    return readOrCreateKey(localKeyPath());
  }
  return resolvePassphrase(passphrase);
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

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function decimalToUnits(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: ${input}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal asset`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function unitsToDecimal(value: bigint, decimals = 18): string {
  const sign = value < 0n ? "-" : "";
  const raw = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals);
  const frac = raw.slice(-decimals).replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
