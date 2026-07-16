import { steleExecutionGate } from "./execution-gate.js";

export interface DedicatedAgentWalletStatus {
  readonly state: "not_configured";
  readonly provenance: "stele_dedicated_agent";
  readonly keyStorage: "os_credential_store_required";
  readonly address: null;
  readonly generation: "unavailable";
  readonly import: "forbidden";
  readonly export: "forbidden";
  readonly signing: "disabled";
  readonly execution: ReturnType<typeof steleExecutionGate>;
}

/**
 * Status-only foundation scaffold. It performs no filesystem access and never
 * inspects desktop, browser, or legacy MCP wallet stores. A lifecycle can only
 * replace this after an audited OS-credential-backed design is available.
 */
export function dedicatedAgentWalletStatus(): DedicatedAgentWalletStatus {
  return {
    state: "not_configured",
    provenance: "stele_dedicated_agent",
    keyStorage: "os_credential_store_required",
    address: null,
    generation: "unavailable",
    import: "forbidden",
    export: "forbidden",
    signing: "disabled",
    execution: steleExecutionGate(),
  };
}
