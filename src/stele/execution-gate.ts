export interface SteleExecutionGateResult {
  readonly ok: false;
  readonly code: "capability_unavailable";
  readonly signing: "disabled";
  readonly submission: "disabled";
  readonly reason: "core_sdk_execution_contracts_unavailable";
}

const EXECUTION_UNAVAILABLE: SteleExecutionGateResult = Object.freeze({
  ok: false,
  code: "capability_unavailable",
  signing: "disabled",
  submission: "disabled",
  reason: "core_sdk_execution_contracts_unavailable",
});

/**
 * Foundation execution boundary. It intentionally accepts no draft, key,
 * signer, or submitter and therefore cannot unlock, sign, or broadcast.
 */
export function steleExecutionGate(): SteleExecutionGateResult {
  return EXECUTION_UNAVAILABLE;
}
