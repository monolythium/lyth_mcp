import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { addressToBech32, bech32ToAddressBytes } from "@monolythium/core-sdk";
import { z } from "zod";
import {
  configuredLockedAgentWalletStatus,
  notConfiguredAgentWalletStatus,
  type DedicatedAgentWalletStatus,
  type SteleWalletStatusReader,
} from "./agent-keystore.js";
import { sdkNetworkIdentity } from "./network-identity.js";

const STATE_SCHEMA_VERSION = 1 as const;
const STATE_FILE_NAME = "stele-agent-wallet-v1.json";
const MAX_STATE_BYTES = 2_048;
const OPERATION_ID = /^[A-Za-z0-9_-]{43}$/u;
const SDK_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const identity = sdkNetworkIdentity();

const LifecycleIdentitySchema = {
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  provenance: z.literal("stele_dedicated_agent"),
  algorithm: z.literal("ml-dsa-65"),
  network: z.literal(identity.network),
  chainId: z.literal(identity.chainId),
  genesisHash: z.literal(identity.genesisHash),
  createdWithSdkVersion: z.string().min(1).max(64).regex(SDK_VERSION),
  generation: z.literal(1),
  credentialId: z.string().regex(OPERATION_ID),
} as const;

const ProvisioningRecordSchema = z
  .object({
    ...LifecycleIdentitySchema,
    state: z.literal("provisioning"),
    ownerPid: z.number().int().positive().safe(),
    active: z.boolean(),
    expectedAddress: z.string().min(1).max(128).nullable(),
  })
  .strict();

const ConfiguredRecordSchema = z
  .object({
    ...LifecycleIdentitySchema,
    state: z.literal("configured"),
    address: z.string().min(1).max(128),
  })
  .strict();

export type SteleWalletProvisioningRecord = z.infer<typeof ProvisioningRecordSchema>;
export type SteleWalletConfiguredRecord = z.infer<typeof ConfiguredRecordSchema>;
export type SteleWalletLifecycleRecord =
  | SteleWalletProvisioningRecord
  | SteleWalletConfiguredRecord;

export type SteleWalletStateErrorCode =
  | "unavailable"
  | "busy"
  | "corrupt"
  | "repair_required"
  | "already_configured";

export class SteleWalletStateError extends Error {
  override readonly name = "SteleWalletStateError";

  constructor(readonly code: SteleWalletStateErrorCode) {
    super("Stele wallet lifecycle state is unavailable");
  }
}

export interface SteleWalletLifecycleAdminStore extends SteleWalletStatusReader {
  readLifecycle(): Promise<SteleWalletLifecycleRecord | null>;
  createProvisioning(credentialId: string): Promise<SteleWalletProvisioningRecord>;
  setExpectedAddress(
    provisioning: SteleWalletProvisioningRecord,
    address: string,
  ): Promise<SteleWalletProvisioningRecord>;
  abandonProvisioning(
    provisioning: SteleWalletProvisioningRecord,
  ): Promise<SteleWalletProvisioningRecord>;
  commitConfigured(
    provisioning: SteleWalletProvisioningRecord,
    address: string,
  ): Promise<SteleWalletConfiguredRecord>;
  clearProvisioning(provisioning: SteleWalletProvisioningRecord): Promise<void>;
  isProvisioningActive(provisioning: SteleWalletProvisioningRecord): boolean;
}

export class FileSteleWalletStateStore implements SteleWalletLifecycleAdminStore {
  readonly #statePath: string;
  readonly #directory: string;

  constructor(statePath = defaultSteleWalletStatePath()) {
    this.#statePath = statePath;
    this.#directory = dirname(statePath);
  }

  async readStatus(): Promise<DedicatedAgentWalletStatus> {
    const record = await this.readLifecycle();
    if (record === null) return notConfiguredAgentWalletStatus();
    if (record.state !== "configured") throw new SteleWalletStateError("repair_required");
    return configuredLockedAgentWalletStatus(record.address, record.generation);
  }

  async readLifecycle(): Promise<SteleWalletLifecycleRecord | null> {
    const directoryExists = await inspectSecureDirectory(this.#directory);
    if (!directoryExists) return null;

    const bytes = await readSecureRegularFile(this.#statePath, MAX_STATE_BYTES);
    if (bytes === null) return null;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      const provisioning = ProvisioningRecordSchema.safeParse(parsed);
      if (provisioning.success) {
        if (
          provisioning.data.expectedAddress !== null &&
          !isCanonicalAddress(provisioning.data.expectedAddress)
        ) {
          throw new SteleWalletStateError("corrupt");
        }
        return provisioning.data;
      }
      const configured = ConfiguredRecordSchema.safeParse(parsed);
      if (!configured.success || !isCanonicalAddress(configured.data.address)) {
        throw new SteleWalletStateError("corrupt");
      }
      return configured.data;
    } catch (error) {
      if (error instanceof SteleWalletStateError) throw error;
      throw new SteleWalletStateError("corrupt");
    } finally {
      bytes.fill(0);
    }
  }

  async createProvisioning(credentialId: string): Promise<SteleWalletProvisioningRecord> {
    if (!OPERATION_ID.test(credentialId)) throw new SteleWalletStateError("unavailable");
    await ensureSecureDirectory(this.#directory);
    const record: SteleWalletProvisioningRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      provenance: "stele_dedicated_agent",
      algorithm: "ml-dsa-65",
      network: identity.network,
      chainId: identity.chainId,
      genesisHash: identity.genesisHash,
      createdWithSdkVersion: identity.sdkVersion,
      generation: 1,
      credentialId,
      state: "provisioning",
      ownerPid: process.pid,
      active: true,
      expectedAddress: null,
    };
    const created = await atomicCreate(this.#statePath, canonicalJson(record));
    if (created) return record;

    const existing = await this.readLifecycle();
    if (existing?.state === "configured") throw new SteleWalletStateError("already_configured");
    if (existing?.state === "provisioning" && this.isProvisioningActive(existing)) {
      throw new SteleWalletStateError("busy");
    }
    throw new SteleWalletStateError("repair_required");
  }

  async setExpectedAddress(
    provisioning: SteleWalletProvisioningRecord,
    address: string,
  ): Promise<SteleWalletProvisioningRecord> {
    if (!isCanonicalAddress(address)) throw new SteleWalletStateError("unavailable");
    const current = await this.#matchingProvisioning(provisioning);
    if (current.expectedAddress !== null && current.expectedAddress !== address) {
      throw new SteleWalletStateError("corrupt");
    }
    const updated = { ...current, expectedAddress: address };
    await atomicReplace(this.#statePath, canonicalJson(updated));
    return updated;
  }

  async abandonProvisioning(
    provisioning: SteleWalletProvisioningRecord,
  ): Promise<SteleWalletProvisioningRecord> {
    const current = await this.#matchingProvisioning(provisioning);
    if (!current.active) return current;
    const updated = { ...current, active: false };
    await atomicReplace(this.#statePath, canonicalJson(updated));
    return updated;
  }

  async commitConfigured(
    provisioning: SteleWalletProvisioningRecord,
    address: string,
  ): Promise<SteleWalletConfiguredRecord> {
    if (!isCanonicalAddress(address)) throw new SteleWalletStateError("unavailable");
    const current = await this.#matchingProvisioning(provisioning);
    if (current.expectedAddress !== address) throw new SteleWalletStateError("corrupt");
    const record: SteleWalletConfiguredRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      provenance: "stele_dedicated_agent",
      algorithm: "ml-dsa-65",
      network: identity.network,
      chainId: identity.chainId,
      genesisHash: identity.genesisHash,
      createdWithSdkVersion: current.createdWithSdkVersion,
      generation: current.generation,
      credentialId: current.credentialId,
      state: "configured",
      address,
    };
    await atomicReplace(this.#statePath, canonicalJson(record));
    return record;
  }

  async clearProvisioning(provisioning: SteleWalletProvisioningRecord): Promise<void> {
    const current = await this.readLifecycle();
    if (current === null) return;
    if (current.state !== "provisioning" || current.credentialId !== provisioning.credentialId) {
      throw new SteleWalletStateError("corrupt");
    }
    try {
      await unlink(this.#statePath);
      await syncDirectory(this.#directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw new SteleWalletStateError("unavailable");
    }
  }

  isProvisioningActive(provisioning: SteleWalletProvisioningRecord): boolean {
    return provisioning.active && processIsAlive(provisioning.ownerPid);
  }

  async #matchingProvisioning(
    provisioning: SteleWalletProvisioningRecord,
  ): Promise<SteleWalletProvisioningRecord> {
    const current = await this.readLifecycle();
    if (current?.state !== "provisioning" || current.credentialId !== provisioning.credentialId) {
      throw new SteleWalletStateError("corrupt");
    }
    return current;
  }
}

export function defaultSteleWalletStatePath(): string {
  const home = userInfo().homedir;
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "lyth-mcp", STATE_FILE_NAME);
  }
  if (process.platform === "win32") {
    return join(home, "AppData", "Local", "lyth-mcp", STATE_FILE_NAME);
  }
  return join(home, ".local", "state", "lyth-mcp", STATE_FILE_NAME);
}

export function randomOperationId(): string {
  return randomBytes(32).toString("base64url");
}

async function ensureSecureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new SteleWalletStateError("unavailable");
  }
  if (!(await inspectSecureDirectory(path))) throw new SteleWalletStateError("unavailable");
}

async function inspectSecureDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !ownedAndPrivate(stats)) {
      throw new SteleWalletStateError("unavailable");
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (error instanceof SteleWalletStateError) throw error;
    throw new SteleWalletStateError("unavailable");
  }
}

async function readSecureRegularFile(path: string, maximum: number): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum || !ownedAndPrivate(stats)) {
      throw new SteleWalletStateError("unavailable");
    }
    return await readFile(handle);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SteleWalletStateError) throw error;
    throw new SteleWalletStateError("unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function ownedAndPrivate(stats: { readonly uid: number; readonly mode: number }): boolean {
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return (uid === undefined || stats.uid === uid) && (stats.mode & 0o077) === 0;
}

async function atomicCreate(path: string, contents: string): Promise<boolean> {
  const temporary = `${path}.${randomOperationId()}.tmp`;
  try {
    await writeTemporary(temporary, contents);
    try {
      await link(temporary, path);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (error instanceof SteleWalletStateError) throw error;
    throw new SteleWalletStateError("unavailable");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicReplace(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomOperationId()}.tmp`;
  try {
    await writeTemporary(temporary, contents);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch {
    throw new SteleWalletStateError("unavailable");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeTemporary(path: string, contents: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    throw new SteleWalletStateError("unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function isCanonicalAddress(address: string): boolean {
  try {
    return addressToBech32(bech32ToAddressBytes(address)) === address;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
