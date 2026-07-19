import { randomFillSync } from "node:crypto";
import { addressToBech32 } from "@monolythium/core-sdk";
import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import {
  configuredLockedAgentWalletStatus,
  notConfiguredAgentWalletStatus,
  type DedicatedAgentWalletStatus,
} from "./agent-keystore.js";
import {
  SteleCredentialStoreError,
  createDefaultSteleSeedCustody,
  type SteleSeedCustody,
  type SteleSeedRecord,
} from "./os-credential-store.js";
import {
  FileSteleWalletStateStore,
  SteleWalletStateError,
  randomOperationId,
  type SteleWalletLifecycleAdminStore,
  type SteleWalletLifecycleRecord,
  type SteleWalletProvisioningRecord,
} from "./wallet-state.js";

const SEED_BYTES = 32;

export type SteleWalletAdminErrorCode =
  | "already_configured"
  | "busy"
  | "repair_required"
  | "manual_recovery_required"
  | "credential_store_unavailable"
  | "unavailable";

export class SteleWalletAdminError extends Error {
  override readonly name = "SteleWalletAdminError";

  constructor(readonly code: SteleWalletAdminErrorCode) {
    super("Stele wallet administration failed");
  }
}

export interface SteleWalletAdminResult {
  readonly action: "created" | "recovered" | "verified" | "cleared_incomplete" | "none";
  readonly wallet: DedicatedAgentWalletStatus;
}

export interface SteleWalletAdminDependencies {
  readonly state: SteleWalletLifecycleAdminStore;
  readonly custody: SteleSeedCustody;
  readonly fillRandom?: (seed: Uint8Array) => void;
  readonly operationId?: () => string;
}

export class SteleWalletAdmin {
  readonly #state: SteleWalletLifecycleAdminStore;
  readonly #custody: SteleSeedCustody;
  readonly #fillRandom: (seed: Uint8Array) => void;
  readonly #operationId: () => string;

  constructor(dependencies: SteleWalletAdminDependencies) {
    this.#state = dependencies.state;
    this.#custody = dependencies.custody;
    this.#fillRandom = dependencies.fillRandom ?? ((seed) => void randomFillSync(seed));
    this.#operationId = dependencies.operationId ?? randomOperationId;
  }

  async create(): Promise<SteleWalletAdminResult> {
    let provisioning: SteleWalletProvisioningRecord | undefined;
    let seed: Uint8Array | undefined;
    try {
      const lifecycle = await this.#state.readLifecycle();
      if (lifecycle?.state === "configured") throw new SteleWalletAdminError("already_configured");
      if (lifecycle?.state === "provisioning") {
        throw new SteleWalletAdminError(
          this.#state.isProvisioningActive(lifecycle) ? "busy" : "repair_required",
        );
      }

      const existingIds = await this.#listSeedIds();
      if (existingIds.length > 0) throw new SteleWalletAdminError("repair_required");

      provisioning = await this.#beginProvisioning(this.#operationId());
      seed = new Uint8Array(SEED_BYTES);
      this.#fillRandom(seed);
      const address = deriveAddress(seed);
      provisioning = await this.#state.setExpectedAddress(provisioning, address);
      await this.#createSeed(provisioning.credentialId, address, seed);
      const committedIds = await this.#listSeedIds();
      if (committedIds.length !== 1 || committedIds[0] !== provisioning.credentialId) {
        throw new SteleWalletAdminError("manual_recovery_required");
      }
      const configured = await this.#state.commitConfigured(provisioning, address);
      provisioning = undefined;
      return {
        action: "created",
        wallet: configuredLockedAgentWalletStatus(configured.address, configured.generation),
      };
    } catch (error) {
      if (provisioning !== undefined) {
        await this.#state.abandonProvisioning(provisioning).catch(() => undefined);
      }
      throw normalizeAdminError(error);
    } finally {
      seed?.fill(0);
    }
  }

  async repair(): Promise<SteleWalletAdminResult> {
    let lifecycle: SteleWalletLifecycleRecord | null;
    try {
      lifecycle = await this.#state.readLifecycle();
    } catch (error) {
      throw normalizeAdminError(error);
    }
    if (lifecycle?.state === "provisioning" && this.#state.isProvisioningActive(lifecycle)) {
      throw new SteleWalletAdminError("busy");
    }

    const ids = await this.#listSeedIds();
    if (lifecycle === null) return this.#repairWithoutLifecycle(ids);
    if (lifecycle.state === "configured") return this.#verifyConfigured(lifecycle, ids);
    return this.#repairProvisioning(lifecycle, ids);
  }

  async #repairWithoutLifecycle(ids: readonly string[]): Promise<SteleWalletAdminResult> {
    if (ids.length === 0) return { action: "none", wallet: notConfiguredAgentWalletStatus() };
    if (ids.length !== 1) throw new SteleWalletAdminError("manual_recovery_required");

    let provisioning: SteleWalletProvisioningRecord | undefined;
    let record: SteleSeedRecord | null = null;
    try {
      record = await this.#readSeed(ids[0]!);
      if (record === null) throw new SteleWalletAdminError("manual_recovery_required");
      const address = verifiedRecordAddress(record);
      provisioning = await this.#beginProvisioning(record.credentialId);
      provisioning = await this.#state.setExpectedAddress(provisioning, address);
      const configured = await this.#state.commitConfigured(provisioning, address);
      provisioning = undefined;
      return {
        action: "recovered",
        wallet: configuredLockedAgentWalletStatus(configured.address, configured.generation),
      };
    } catch (error) {
      if (provisioning !== undefined) {
        await this.#state.abandonProvisioning(provisioning).catch(() => undefined);
      }
      throw normalizeAdminError(error);
    } finally {
      record?.seed.fill(0);
    }
  }

  async #verifyConfigured(
    lifecycle: Extract<SteleWalletLifecycleRecord, { state: "configured" }>,
    ids: readonly string[],
  ): Promise<SteleWalletAdminResult> {
    if (ids.length !== 1 || ids[0] !== lifecycle.credentialId) {
      throw new SteleWalletAdminError("manual_recovery_required");
    }
    const record = await this.#readSeed(lifecycle.credentialId);
    if (record === null) throw new SteleWalletAdminError("manual_recovery_required");
    try {
      if (verifiedRecordAddress(record) !== lifecycle.address) {
        throw new SteleWalletAdminError("manual_recovery_required");
      }
      return {
        action: "verified",
        wallet: configuredLockedAgentWalletStatus(lifecycle.address, lifecycle.generation),
      };
    } finally {
      record.seed.fill(0);
    }
  }

  async #repairProvisioning(
    lifecycle: SteleWalletProvisioningRecord,
    ids: readonly string[],
  ): Promise<SteleWalletAdminResult> {
    if (ids.length === 0) {
      await this.#state.clearProvisioning(lifecycle);
      return { action: "cleared_incomplete", wallet: notConfiguredAgentWalletStatus() };
    }
    if (ids.length !== 1 || ids[0] !== lifecycle.credentialId) {
      throw new SteleWalletAdminError("manual_recovery_required");
    }

    const record = await this.#readSeed(lifecycle.credentialId);
    if (record === null) throw new SteleWalletAdminError("manual_recovery_required");
    try {
      const address = verifiedRecordAddress(record);
      if (lifecycle.expectedAddress !== null && lifecycle.expectedAddress !== address) {
        throw new SteleWalletAdminError("manual_recovery_required");
      }
      const committed =
        lifecycle.expectedAddress === null
          ? await this.#state.setExpectedAddress(lifecycle, address)
          : lifecycle;
      const configured = await this.#state.commitConfigured(committed, address);
      return {
        action: "recovered",
        wallet: configuredLockedAgentWalletStatus(configured.address, configured.generation),
      };
    } catch (error) {
      throw normalizeAdminError(error);
    } finally {
      record.seed.fill(0);
    }
  }

  async #beginProvisioning(credentialId: string): Promise<SteleWalletProvisioningRecord> {
    try {
      return await this.#state.createProvisioning(credentialId);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async #listSeedIds(): Promise<readonly string[]> {
    try {
      return await this.#custody.listSeedIds();
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async #readSeed(credentialId: string): Promise<SteleSeedRecord | null> {
    try {
      return await this.#custody.readSeed(credentialId);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async #createSeed(credentialId: string, address: string, seed: Uint8Array): Promise<void> {
    try {
      await this.#custody.createSeed(credentialId, address, seed);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }
}

export async function createDefaultSteleWalletAdmin(): Promise<SteleWalletAdmin> {
  try {
    return new SteleWalletAdmin({
      state: new FileSteleWalletStateStore(),
      custody: await createDefaultSteleSeedCustody(),
    });
  } catch (error) {
    throw normalizeAdminError(error);
  }
}

export function safeSteleWalletAdminErrorCode(error: unknown): SteleWalletAdminErrorCode {
  return normalizeAdminError(error).code;
}

function verifiedRecordAddress(record: SteleSeedRecord): string {
  const derived = deriveAddress(record.seed);
  if (derived !== record.address) throw new SteleWalletAdminError("manual_recovery_required");
  return derived;
}

function deriveAddress(seed: Uint8Array): string {
  let backend: MlDsa65Backend | undefined;
  let addressBytes: Uint8Array | undefined;
  try {
    backend = MlDsa65Backend.fromSeed(seed);
    addressBytes = backend.addressBytes();
    return addressToBech32(addressBytes);
  } catch {
    throw new SteleWalletAdminError("unavailable");
  } finally {
    addressBytes?.fill(0);
    backend?.dispose();
  }
}

function normalizeAdminError(error: unknown): SteleWalletAdminError {
  if (error instanceof SteleWalletAdminError) return error;
  if (error instanceof SteleWalletStateError) {
    switch (error.code) {
      case "already_configured":
        return new SteleWalletAdminError("already_configured");
      case "busy":
        return new SteleWalletAdminError("busy");
      case "repair_required":
        return new SteleWalletAdminError("repair_required");
      case "corrupt":
        return new SteleWalletAdminError("manual_recovery_required");
      default:
        return new SteleWalletAdminError("unavailable");
    }
  }
  if (error instanceof SteleCredentialStoreError) {
    if (error.code === "corrupt") return new SteleWalletAdminError("manual_recovery_required");
    return new SteleWalletAdminError(
      error.code === "already_exists" ? "repair_required" : "credential_store_unavailable",
    );
  }
  return new SteleWalletAdminError("unavailable");
}
