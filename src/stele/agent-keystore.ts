import { addressToBech32, bech32ToAddressBytes } from "@monolythium/core-sdk";
import { steleExecutionGate } from "./execution-gate.js";

interface DedicatedAgentWalletStatusBase {
  readonly provenance: "stele_dedicated_agent";
  readonly keyStorage: "os_credential_store";
  readonly import: "forbidden";
  readonly export: "forbidden";
  readonly signing: "disabled";
  readonly execution: ReturnType<typeof steleExecutionGate>;
}

export interface DedicatedAgentWalletNotConfiguredStatus
  extends DedicatedAgentWalletStatusBase {
  readonly state: "not_configured";
  readonly address: null;
  readonly generation: null;
}

export interface DedicatedAgentWalletConfiguredStatus
  extends DedicatedAgentWalletStatusBase {
  readonly state: "configured_locked";
  readonly address: string;
  readonly generation: number;
}

export type DedicatedAgentWalletStatus =
  | DedicatedAgentWalletNotConfiguredStatus
  | DedicatedAgentWalletConfiguredStatus;

/**
 * Deliberately narrow MCP capability. Implementations may read only public
 * lifecycle state; this interface cannot open, create, import, or sign with a
 * Stele seed.
 */
export interface SteleWalletStatusReader {
  readStatus(): Promise<DedicatedAgentWalletStatus>;
}

export function notConfiguredAgentWalletStatus(): DedicatedAgentWalletNotConfiguredStatus {
  return {
    state: "not_configured",
    provenance: "stele_dedicated_agent",
    keyStorage: "os_credential_store",
    address: null,
    generation: null,
    import: "forbidden",
    export: "forbidden",
    signing: "disabled",
    execution: steleExecutionGate(),
  };
}

export function configuredLockedAgentWalletStatus(
  address: string,
  generation: number,
): DedicatedAgentWalletConfiguredStatus {
  return {
    state: "configured_locked",
    provenance: "stele_dedicated_agent",
    keyStorage: "os_credential_store",
    address,
    generation,
    import: "forbidden",
    export: "forbidden",
    signing: "disabled",
    execution: steleExecutionGate(),
  };
}

export async function dedicatedAgentWalletStatus(
  reader: SteleWalletStatusReader,
): Promise<DedicatedAgentWalletStatus> {
  return parseDedicatedAgentWalletStatus(await reader.readStatus());
}

/** Strict runtime boundary for injected/local status implementations. */
export function parseDedicatedAgentWalletStatus(value: unknown): DedicatedAgentWalletStatus {
  if (!isExactStatusObject(value)) throw new Error("Invalid Stele wallet status");
  if (
    value.provenance !== "stele_dedicated_agent" ||
    value.keyStorage !== "os_credential_store" ||
    value.import !== "forbidden" ||
    value.export !== "forbidden" ||
    value.signing !== "disabled" ||
    !isDisabledExecutionGate(value.execution)
  ) {
    throw new Error("Invalid Stele wallet status");
  }
  if (value.state === "not_configured") {
    if (value.address !== null || value.generation !== null) {
      throw new Error("Invalid Stele wallet status");
    }
    return notConfiguredAgentWalletStatus();
  }
  if (
    value.state !== "configured_locked" ||
    typeof value.address !== "string" ||
    !isCanonicalAddress(value.address) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new Error("Invalid Stele wallet status");
  }
  return configuredLockedAgentWalletStatus(value.address, value.generation);
}

function isExactStatusObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    "address",
    "execution",
    "export",
    "generation",
    "import",
    "keyStorage",
    "provenance",
    "signing",
    "state",
  ];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isDisabledExecutionGate(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["code", "ok", "reason", "signing", "submission"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.ok === false &&
    record.code === "capability_unavailable" &&
    record.signing === "disabled" &&
    record.submission === "disabled" &&
    record.reason === "core_sdk_execution_contracts_unavailable"
  );
}

function isCanonicalAddress(address: string): boolean {
  try {
    return addressToBech32(bech32ToAddressBytes(address)) === address;
  } catch {
    return false;
  }
}
