import { timingSafeEqual } from "node:crypto";
import { addressToBech32, bech32ToAddressBytes } from "@monolythium/core-sdk";
import { sdkNetworkIdentity } from "./network-identity.js";

const KEYRING_SERVICE = "com.monolythium.stele.agent-wallet";
const ACCOUNT_PREFIX = "dedicated-seed-v1:";
const RECORD_VERSION = "stele-agent-seed-v1";
const SEED_BYTES = 32;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_SEED = /^[A-Za-z0-9_-]{43}$/u;
const identity = sdkNetworkIdentity();

export type SteleCredentialBackend =
  | "macos_keychain"
  | "windows_credential_manager"
  | "linux_secret_service";

export type SteleCredentialStoreErrorCode =
  | "unavailable"
  | "already_exists"
  | "corrupt";

export class SteleCredentialStoreError extends Error {
  override readonly name = "SteleCredentialStoreError";

  constructor(readonly code: SteleCredentialStoreErrorCode) {
    super("Stele OS credential store is unavailable");
  }
}

export interface SteleSeedRecord {
  readonly credentialId: string;
  readonly address: string;
  readonly seed: Uint8Array;
}

/** Admin-only capability. This type is never imported into the MCP server. */
export interface SteleSeedCustody {
  readonly backend: SteleCredentialBackend;
  listSeedIds(): Promise<readonly string[]>;
  readSeed(credentialId: string): Promise<SteleSeedRecord | null>;
  createSeed(credentialId: string, address: string, seed: Uint8Array): Promise<void>;
}

export interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export class NativeSteleSeedCustody implements SteleSeedCustody {
  readonly backend: SteleCredentialBackend;
  readonly #keytar: KeytarApi;

  constructor(keytar: KeytarApi, backend = credentialBackendForPlatform()) {
    this.#keytar = keytar;
    this.backend = backend;
  }

  async listSeedIds(): Promise<readonly string[]> {
    let credentials: Array<{ account: string; password: string }>;
    try {
      credentials = await this.#keytar.findCredentials(KEYRING_SERVICE);
    } catch {
      throw new SteleCredentialStoreError("unavailable");
    }
    if (!Array.isArray(credentials)) throw new SteleCredentialStoreError("corrupt");

    const ids = new Set<string>();
    for (const credential of credentials) {
      if (
        typeof credential !== "object" ||
        credential === null ||
        typeof credential.account !== "string" ||
        typeof credential.password !== "string" ||
        !credential.account.startsWith(ACCOUNT_PREFIX)
      ) {
        throw new SteleCredentialStoreError("corrupt");
      }
      const credentialId = credential.account.slice(ACCOUNT_PREFIX.length);
      if (!CREDENTIAL_ID.test(credentialId) || ids.has(credentialId)) {
        throw new SteleCredentialStoreError("corrupt");
      }
      const parsed = decodeSeedRecord(credentialId, credential.password);
      parsed.seed.fill(0);
      ids.add(credentialId);
    }
    return [...ids].sort();
  }

  async readSeed(credentialId: string): Promise<SteleSeedRecord | null> {
    assertCredentialId(credentialId);
    let stored: string | null;
    try {
      stored = await this.#keytar.getPassword(
        KEYRING_SERVICE,
        credentialAccount(credentialId),
      );
    } catch {
      throw new SteleCredentialStoreError("unavailable");
    }
    return stored === null ? null : decodeSeedRecord(credentialId, stored);
  }

  async createSeed(credentialId: string, address: string, seed: Uint8Array): Promise<void> {
    assertCredentialId(credentialId);
    if (!isCanonicalAddress(address) || !(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
      throw new SteleCredentialStoreError("corrupt");
    }
    const existing = await this.readSeed(credentialId);
    if (existing !== null) {
      existing.seed.fill(0);
      throw new SteleCredentialStoreError("already_exists");
    }

    // @github/keytar currently accepts strings. Keep the immutable base64url
    // representation scoped to this short-lived admin call; mutable source and
    // readback buffers are wiped. This adapter is not the future signer path.
    const encodedSeed = Buffer.from(
      seed.buffer,
      seed.byteOffset,
      seed.byteLength,
    ).toString("base64url");
    const encoded = [
      RECORD_VERSION,
      identity.network,
      identity.chainId,
      identity.genesisHash,
      credentialId,
      address,
      encodedSeed,
    ].join(":");
    try {
      await this.#keytar.setPassword(
        KEYRING_SERVICE,
        credentialAccount(credentialId),
        encoded,
      );
    } catch {
      throw new SteleCredentialStoreError("unavailable");
    }

    const readback = await this.readSeed(credentialId);
    if (readback === null) throw new SteleCredentialStoreError("corrupt");
    try {
      if (readback.address !== address || !timingSafeEqual(readback.seed, seed)) {
        throw new SteleCredentialStoreError("corrupt");
      }
    } finally {
      readback.seed.fill(0);
    }
  }
}

export async function createDefaultSteleSeedCustody(): Promise<SteleSeedCustody> {
  credentialBackendForPlatform();
  try {
    const imported: unknown = await import("@github/keytar");
    return new NativeSteleSeedCustody(keytarApiFromModule(imported));
  } catch (error) {
    if (error instanceof SteleCredentialStoreError) throw error;
    throw new SteleCredentialStoreError("unavailable");
  }
}

export function keytarApiFromModule(imported: unknown): KeytarApi {
  if (isKeytarApi(imported)) return imported;
  if (
    typeof imported === "object" &&
    imported !== null &&
    "default" in imported &&
    isKeytarApi(imported.default)
  ) {
    return imported.default;
  }
  throw new SteleCredentialStoreError("unavailable");
}

export function credentialBackendForPlatform(
  platform: NodeJS.Platform = process.platform,
): SteleCredentialBackend {
  switch (platform) {
    case "darwin":
      return "macos_keychain";
    case "win32":
      return "windows_credential_manager";
    case "linux":
      return "linux_secret_service";
    default:
      throw new SteleCredentialStoreError("unavailable");
  }
}

function decodeSeedRecord(credentialId: string, stored: string): SteleSeedRecord {
  const fields = stored.split(":");
  if (
    fields.length !== 7 ||
    fields[0] !== RECORD_VERSION ||
    fields[1] !== identity.network ||
    fields[2] !== identity.chainId ||
    fields[3] !== identity.genesisHash ||
    fields[4] !== credentialId ||
    !isCanonicalAddress(fields[5]!) ||
    !BASE64URL_SEED.test(fields[6]!)
  ) {
    throw new SteleCredentialStoreError("corrupt");
  }
  const decoded = Buffer.from(fields[6]!, "base64url");
  try {
    if (decoded.length !== SEED_BYTES || decoded.toString("base64url") !== fields[6]) {
      throw new SteleCredentialStoreError("corrupt");
    }
    return {
      credentialId,
      address: fields[5]!,
      seed: Uint8Array.from(decoded),
    };
  } finally {
    decoded.fill(0);
  }
}

function credentialAccount(credentialId: string): string {
  return `${ACCOUNT_PREFIX}${credentialId}`;
}

function assertCredentialId(credentialId: string): void {
  if (!CREDENTIAL_ID.test(credentialId)) throw new SteleCredentialStoreError("corrupt");
}

function isCanonicalAddress(address: string): boolean {
  try {
    return addressToBech32(bech32ToAddressBytes(address)) === address;
  } catch {
    return false;
  }
}

function isKeytarApi(value: unknown): value is KeytarApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "getPassword" in value &&
    typeof value.getPassword === "function" &&
    "setPassword" in value &&
    typeof value.setPassword === "function" &&
    "findCredentials" in value &&
    typeof value.findCredentials === "function"
  );
}
