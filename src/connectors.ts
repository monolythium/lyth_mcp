import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;

export type ConnectorAuthMode = "none" | "bearer" | "header" | "hmac_sha256";
export type ConnectorMethod = "POST" | "PUT";

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

export interface ConnectorRecord {
  id: string;
  kind: "webhook";
  enabled: boolean;
  displayName?: string;
  vendorId?: string;
  endpoint: string;
  method: ConnectorMethod;
  auth: {
    mode: ConnectorAuthMode;
    headerName?: string;
    scheme?: string;
    encryptedSecret?: EncryptedPayload;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorSummary {
  id: string;
  kind: ConnectorRecord["kind"];
  enabled: boolean;
  displayName?: string;
  vendorId?: string;
  endpoint: string;
  method: ConnectorMethod;
  auth: {
    mode: ConnectorAuthMode;
    headerName?: string;
    scheme?: string;
    secretConfigured: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorStore {
  schemaVersion: 1;
  connectors: ConnectorRecord[];
}

export interface ConnectorPatch {
  id?: string;
  vendorId?: string;
  displayName?: string;
  endpoint: string;
  method?: ConnectorMethod;
  enabled?: boolean;
  authMode?: ConnectorAuthMode;
  headerName?: string;
  scheme?: string;
  secret?: string;
}

export function connectorStorePath(): string {
  return process.env.LYTH_MCP_CONNECTOR_STORE || join(homedir(), ".lyth_mcp", "connectors.json");
}

export function connectorKeyPath(): string {
  return process.env.LYTH_MCP_CONNECTOR_KEY || join(homedir(), ".lyth_mcp", "connector.key");
}

export async function readConnectorStore(path = connectorStorePath()): Promise<ConnectorStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConnectorStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.connectors)) {
      throw new Error(`unsupported connector store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, connectors: [] };
    }
    throw err;
  }
}

export async function writeConnectorStore(store: ConnectorStore, path = connectorStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function connectorStoreInfo(path = connectorStorePath()) {
  const store = await readConnectorStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
    mode = null;
  }
  return {
    path,
    connectorCount: store.connectors.length,
    fileMode: mode,
  };
}

export async function upsertConnector(patch: ConnectorPatch): Promise<ConnectorRecord> {
  validateEndpoint(patch.endpoint);
  const store = await readConnectorStore();
  const id = patch.id ?? patch.vendorId ?? endpointId(patch.endpoint);
  const index = store.connectors.findIndex((connector) => connector.id === id);
  const current = index >= 0 ? store.connectors[index]! : null;
  const now = new Date().toISOString();
  const authMode = patch.authMode ?? current?.auth.mode ?? (patch.secret ? "bearer" : "none");
  const encryptedSecret = patch.secret
    ? encryptSecret(patch.secret, await readOrCreateKey(connectorKeyPath()))
    : current?.auth.encryptedSecret;
  const next: ConnectorRecord = {
    id,
    kind: "webhook",
    enabled: patch.enabled ?? current?.enabled ?? true,
    displayName: patch.displayName ?? current?.displayName,
    vendorId: patch.vendorId ?? current?.vendorId,
    endpoint: patch.endpoint,
    method: patch.method ?? current?.method ?? "POST",
    auth: {
      mode: authMode,
      headerName: patch.headerName ?? current?.auth.headerName ?? defaultHeaderName(authMode),
      scheme: patch.scheme ?? current?.auth.scheme ?? (authMode === "bearer" ? "Bearer" : undefined),
      encryptedSecret: authMode === "none" ? undefined : encryptedSecret,
    },
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (next.auth.mode !== "none" && !next.auth.encryptedSecret) {
    throw new Error("secret is required for bearer, header, and hmac_sha256 connector auth modes");
  }
  if (index >= 0) {
    store.connectors[index] = next;
  } else {
    store.connectors.unshift(next);
  }
  await writeConnectorStore(store);
  return next;
}

export async function getConnector(id: string): Promise<ConnectorRecord> {
  const connector = (await readConnectorStore()).connectors.find((item) => item.id === id);
  if (!connector) {
    throw new Error(`connector '${id}' not found`);
  }
  return connector;
}

export async function listConnectors(args: { vendorId?: string; enabledOnly?: boolean; limit?: number } = {}): Promise<ConnectorSummary[]> {
  return (await readConnectorStore()).connectors
    .filter((connector) => !args.vendorId || connector.vendorId === args.vendorId)
    .filter((connector) => !args.enabledOnly || connector.enabled)
    .slice(0, args.limit ?? 100)
    .map(redactConnector);
}

export async function removeConnector(id: string): Promise<{ removed: boolean; id: string }> {
  const store = await readConnectorStore();
  const before = store.connectors.length;
  store.connectors = store.connectors.filter((connector) => connector.id !== id);
  if (store.connectors.length !== before) {
    await writeConnectorStore(store);
  }
  return { removed: store.connectors.length !== before, id };
}

export async function resolveConnector(args: { connectorId?: string; vendorId?: string }): Promise<ConnectorRecord> {
  if (args.connectorId) {
    return getConnector(args.connectorId);
  }
  if (!args.vendorId) {
    throw new Error("connectorId or vendorId is required");
  }
  const connector = (await readConnectorStore()).connectors.find((item) => item.vendorId === args.vendorId && item.enabled);
  if (!connector) {
    throw new Error(`no enabled connector found for vendor '${args.vendorId}'`);
  }
  return connector;
}

export function redactConnector(connector: ConnectorRecord): ConnectorSummary {
  return {
    id: connector.id,
    kind: connector.kind,
    enabled: connector.enabled,
    displayName: connector.displayName,
    vendorId: connector.vendorId,
    endpoint: connector.endpoint,
    method: connector.method,
    auth: {
      mode: connector.auth.mode,
      headerName: connector.auth.headerName,
      scheme: connector.auth.scheme,
      secretConfigured: Boolean(connector.auth.encryptedSecret),
    },
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

export async function buildConnectorHeaders(connector: ConnectorRecord, body: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "lyth-mcp/0.1.0",
  };
  if (connector.auth.mode === "none") {
    return headers;
  }
  const secret = connector.auth.encryptedSecret
    ? decryptSecret(connector.auth.encryptedSecret, await readOrCreateKey(connectorKeyPath()))
    : null;
  if (!secret) {
    throw new Error(`connector '${connector.id}' is missing encrypted auth secret`);
  }
  if (connector.auth.mode === "bearer") {
    headers.Authorization = `${connector.auth.scheme ?? "Bearer"} ${secret}`;
  }
  if (connector.auth.mode === "header") {
    headers[connector.auth.headerName ?? "X-API-Key"] = secret;
  }
  if (connector.auth.mode === "hmac_sha256") {
    const timestamp = new Date().toISOString();
    headers["X-Lyth-Timestamp"] = timestamp;
    headers[connector.auth.headerName ?? "X-Lyth-Signature"] = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  }
  return headers;
}

export function connectorPayloadHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function validateEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("connector endpoint must be http or https");
  }
}

function endpointId(endpoint: string): string {
  const url = new URL(endpoint);
  const hash = createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  return `connector_${url.hostname.replace(/[^a-zA-Z0-9]+/g, "_")}_${hash}`;
}

function defaultHeaderName(mode: ConnectorAuthMode): string | undefined {
  if (mode === "header") {
    return "X-API-Key";
  }
  if (mode === "hmac_sha256") {
    return "X-Lyth-Signature";
  }
  return undefined;
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
