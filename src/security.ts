import {
  bridgeCircuitBreakerAlerts,
  bridgeStatusSummary,
  type BridgeRegistry,
} from "./bridges.js";
import type { ClusterRegistry } from "./clusters.js";
import type { NodeRegistry } from "./nodes.js";
import type { TxOutboxEntry } from "./outbox.js";
import type { OperationReceipt } from "./receipts.js";
import type { WalletSummary } from "./wallet.js";

export type SecuritySeverity = "ok" | "watch" | "degraded" | "critical";

export interface RpcEndpointHealth {
  endpoint: string;
  ok?: boolean;
  score?: number;
  writeReady?: boolean;
  quarantined?: boolean;
  warnings?: string[];
}

export interface RpcHealthSnapshot {
  selectedRead?: string | null;
  selectedWrite?: string | null;
  endpoints?: RpcEndpointHealth[];
}

export interface SecurityContext {
  network: string;
  chainId: number;
  submitEnabled: boolean;
  rpcHealth?: RpcHealthSnapshot;
  bridgeRegistry: BridgeRegistry;
  clusterRegistry?: ClusterRegistry;
  nodeRegistry?: NodeRegistry;
  wallets: WalletSummary[];
  outboxEntries: TxOutboxEntry[];
  receipts: OperationReceipt[];
  runbookCount?: number;
  now?: Date;
}

export function securityStatus(ctx: SecurityContext) {
  const components = [
    mempoolPosture(ctx.rpcHealth),
    ferveoPosture(),
    ccipBridgePosture(ctx.bridgeRegistry),
    oraclePosture(ctx.clusterRegistry),
    riscVmGatePosture(),
    walletPosture(ctx.wallets, ctx.outboxEntries),
    outboxPosture(ctx.outboxEntries, ctx.now ?? new Date()),
  ];
  const severity = highestSeverity(components.map((component) => component.severity));
  return {
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    network: ctx.network,
    chainId: ctx.chainId,
    submitEnabled: ctx.submitEnabled,
    severity,
    decision: severity === "critical"
      ? "freeze_sensitive_actions"
      : severity === "degraded"
        ? "operator_review_before_writes"
        : severity === "watch"
          ? "safe_for_demos_with_warnings"
          : "normal",
    components,
    bridgeAlerts: bridgeCircuitBreakerAlerts(ctx.bridgeRegistry),
    assumptions: [
      "This is an MCP-local dashboard over current RPC health and bundled/example registries.",
      "TODO(mainnet): replace Ferveo, PQ checkpoint, emergency, verifier, and VM gate statuses with signed core/indexer data.",
    ],
  };
}

export function emergencyStateWatch(ctx: SecurityContext) {
  const alerts = bridgeCircuitBreakerAlerts(ctx.bridgeRegistry);
  const events = [];
  if (!ctx.rpcHealth?.selectedRead) {
    events.push(event("critical", "NoReadableRpc", "No readable RPC endpoint is selected."));
  }
  if (!ctx.rpcHealth?.selectedWrite) {
    events.push(event("degraded", "NoWritableRpc", "No write-ready RPC endpoint is selected."));
  }
  for (const alert of alerts) {
    if (alert.severity === "critical") {
      events.push(event("critical", alert.code, alert.message, { routeId: alert.routeId }));
    } else if (alert.severity === "warning") {
      events.push(event("watch", alert.code, alert.message, { routeId: alert.routeId }));
    }
  }
  for (const entry of ctx.outboxEntries.filter((item) => item.status === "signed" && isPast(item.expiresAt, ctx.now))) {
    events.push(event("watch", "ExpiredSignedPayload", `Outbox ${entry.id} is locally expired but may still be submit-capable if copied elsewhere.`, { outboxId: entry.id }));
  }
  const failedBroadcasts = ctx.receipts.filter((receipt) => (
    receipt.status === "failed" &&
    /submit|retry|wallet_transfer|drain/i.test(receipt.kind) &&
    Date.parse(receipt.createdAt) >= (ctx.now ?? new Date()).getTime() - 24 * 60 * 60 * 1000
  ));
  if (failedBroadcasts.length >= 3) {
    events.push(event("degraded", "BroadcastFailureSpike", `${failedBroadcasts.length} failed broadcast/signing receipts in the last 24h.`));
  }
  events.push(event("watch", "G3EmergencyDeclarationUnavailable", "G3/PQ emergency declaration state is not exposed to this MCP yet. TODO(mainnet)."));
  const severity = highestSeverity(events.map((item) => item.severity));
  return {
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    severity,
    action: severity === "critical"
      ? "freeze_new_bridge_ops_and_high_value_writes"
      : severity === "degraded"
        ? "operator_review_required"
        : "normal_with_watch_items",
    events,
    operatorRunbooks: [
      { name: "pause agent wallet", tool: "agent_wallet_pause", trigger: "suspected agent wallet compromise" },
      { name: "drain agent wallet", tool: "agent_wallet_drain", trigger: "move remaining operating funds to recovery address" },
      { name: "freeze route client-side", tool: "bridge_circuit_breaker_watch", trigger: "critical bridge alert or paused route" },
      { name: "release stale allowance", tool: "tx_outbox_release", trigger: "signed payload is locally stale and user accepts allowance release semantics" },
    ],
  };
}

export function bridgeBlastRadiusMonitor(ctx: SecurityContext, args: {
  asset?: string;
  includeDraftRoutes?: boolean;
} = {}) {
  const routes = ctx.bridgeRegistry.routes
    .filter((route) => !args.asset || route.sourceAsset.toUpperCase() === args.asset.toUpperCase() || route.destinationAsset.toUpperCase() === args.asset.toUpperCase())
    .filter((route) => args.includeDraftRoutes !== false || route.status === "active");
  const alerts = bridgeCircuitBreakerAlerts({ ...ctx.bridgeRegistry, routes }, { asset: args.asset });
  const routeSummaries = bridgeStatusSummary({ ...ctx.bridgeRegistry, routes });
  const inflightReceipts = ctx.receipts.filter((receipt) => /bridge|xswap|swap_cross_chain/i.test(`${receipt.kind} ${receipt.title} ${receipt.summary}`));
  const signedBridgePayloads = ctx.outboxEntries.filter((entry) => /bridge|xswap|swap/i.test(`${entry.runbookId ?? ""} ${entry.note ?? ""}`));
  const criticalRoutes = routeSummaries.filter((route) => route.status === "paused" || route.risk.level === "blocked");
  return {
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    asset: args.asset?.toUpperCase(),
    severity: criticalRoutes.length || alerts.some((alert) => alert.severity === "critical") ? "critical" : alerts.length ? "watch" : "ok",
    recommendation: criticalRoutes.length
      ? "Freeze new bridge operations for affected routes and review in-flight settlements."
      : alerts.length
        ? "Show warnings before bridge quotes and keep draft routes non-executable."
        : "No local bridge blast-radius alerts.",
    affectedRoutes: routeSummaries,
    alerts,
    inFlight: {
      bridgeReceipts: inflightReceipts.map((receipt) => ({
        id: receipt.id,
        kind: receipt.kind,
        status: receipt.status,
        txHash: receipt.txHash,
        summary: receipt.summary,
      })),
      signedBridgePayloads: signedBridgePayloads.map((entry) => ({
        id: entry.id,
        status: entry.status,
        amount: entry.amount,
        asset: entry.asset,
        note: entry.note,
      })),
    },
    caveats: [
      "The current MCP does not build live bridge transactions yet, so in-flight detection is local receipt/outbox based.",
      "TODO(mainnet): use core/indexer bridge settlement state, source-chain finality, proof verifier status, drain cap, and route emergency state.",
    ],
  };
}

export function recoveryStatus(ctx: SecurityContext, walletName?: string) {
  const wallets = walletName ? ctx.wallets.filter((wallet) => wallet.name === walletName) : ctx.wallets;
  if (walletName && wallets.length === 0) {
    throw new Error(`wallet '${walletName}' not found`);
  }
  return {
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    wallets: wallets.map((wallet) => {
      const signedPayloads = ctx.outboxEntries.filter((entry) => entry.walletName === wallet.name && entry.status === "signed");
      const submittedPayloads = ctx.outboxEntries.filter((entry) => entry.walletName === wallet.name && entry.status === "submitted");
      return {
        name: wallet.name,
        address: wallet.address,
        agent: wallet.agent ?? null,
        lowValue: wallet.lowValue ?? null,
        recoveryReadiness: recoveryReadiness(wallet, signedPayloads.length, submittedPayloads.length),
        availableRunbooks: recoveryRunbooks(wallet.name),
        signedPayloads: signedPayloads.length,
        submittedPayloads: submittedPayloads.length,
      };
    }),
    missingProductionSignals: [
      "TODO(core): emergency-key registration and frozen-account state.",
      "TODO(wallet): principal wallet handoff and hardware/passkey approval state.",
      "TODO(indexer): account-level recovery event history.",
    ],
  };
}

export function recoveryRunbookDraft(args: {
  kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
  walletName?: string;
  outboxId?: string;
  reason?: string;
}) {
  const createdAt = new Date().toISOString();
  const base = {
    schemaVersion: 1,
    createdAt,
    kind: args.kind,
    reason: args.reason ?? "operator requested recovery runbook draft",
    unsigned: true,
    todo: "TODO(mainnet): replace local recovery drafts with wallet/core recovery builders where applicable.",
  };
  if (args.kind === "pause_agent") {
    return {
      ...base,
      title: "Pause agent wallet",
      requiredTool: "agent_wallet_pause",
      arguments: { name: args.walletName, confirm: "PAUSE_AGENT_WALLET" },
      effect: "Disables future low-value local signing and marks the agent wallet paused.",
      caveat: "Does not invalidate signed payloads already copied outside the MCP outbox.",
    };
  }
  if (args.kind === "drain_agent") {
    return {
      ...base,
      title: "Drain agent wallet",
      requiredTool: "agent_wallet_drain",
      arguments: { name: args.walletName, to: "<principal-or-recovery-address>", confirm: "DRAIN_AGENT_WALLET" },
      effect: "Moves remaining operating funds to a principal/recovery address, then pauses the wallet.",
      caveat: "Requires user approval and should not use low-value signing.",
    };
  }
  if (args.kind === "delete_local_wallet") {
    return {
      ...base,
      title: "Delete local wallet record",
      requiredTool: "agent_wallet_delete",
      arguments: { name: args.walletName, confirmName: args.walletName, confirm: "DELETE_AGENT_WALLET" },
      effect: "Removes local encrypted wallet metadata after funds are drained or intentionally abandoned.",
      caveat: "Deleting local metadata does not move funds or revoke copied mnemonics.",
    };
  }
  if (args.kind === "release_stale_outbox") {
    return {
      ...base,
      title: "Release stale low-value reservation",
      requiredTool: "tx_outbox_release",
      arguments: { id: args.outboxId, confirm: "RELEASE_LOW_VALUE_RESERVATION" },
      effect: "Moves local allowance reservation into expired/failed bucket.",
      caveat: "Cannot invalidate a signed payload that was copied elsewhere.",
    };
  }
  return {
    ...base,
    title: "Rotate/register emergency key",
    requiredTool: "emergency_key_register_draft",
    arguments: { walletName: args.walletName },
    effect: "Future core/wallet flow to register or rotate an SLH-DSA emergency key.",
    caveat: "Not live in MCP yet. Requires core and wallet support.",
  };
}

export function auditResearchGateDashboard(ctx: SecurityContext) {
  const bridgeRoutes = ctx.bridgeRegistry.routes;
  const ccipRoutes = bridgeRoutes.filter((route) => route.routeType === "chainlink_ccip");
  const ccipLinkRoutes = ccipRoutes.filter((route) => (route.feeToken ?? "").trim().toUpperCase() === "LINK");
  const gates = [
    gate("zkml_verifier", "TODO(mainnet)", "No live zkML verifier registry is exposed to the MCP yet.", "critical_for_zkml"),
    gate("riscv_vm", "TODO(core)", "Rust/RISC-V contract VM gate is not queryable from MCP yet.", "critical_for_contracts"),
    gate("mrc_standards", "TODO(core/indexer)", "MRC assets are represented by local registry labels only.", "critical_for_tokens_nfts"),
    gate("evm_retirement", "MCP_READY", "MCP gives explicit no-EVM guidance; core removal/readiness must be checked in mono-core.", "strategy"),
    gate("chainlink_ccip", ccipLinkRoutes.some((route) => route.status === "active") ? "WATCH" : "TODO(mainnet)", `${ccipLinkRoutes.length} Chainlink CCIP + LINK route(s) in local registry.`, "critical_for_bridges"),
    gate("ferveo", "TODO(core/indexer)", "Ferveo threshold/decryption status is not exposed to MCP yet.", "critical_for_mempool"),
    gate("oracle", hasOracleService(ctx.clusterRegistry) ? "LOCAL_METADATA" : "TODO(core/indexer)", "Oracle service posture is local cluster metadata only.", "critical_for_markets"),
    gate("dag_sync", "TODO(core/indexer)", "DAG sync/finality health needs signed chain telemetry.", "critical_for_consensus"),
  ];
  return {
    checkedAt: (ctx.now ?? new Date()).toISOString(),
    gates,
    summary: {
      total: gates.length,
      readyLike: gates.filter((item) => ["MCP_READY", "LOCAL_METADATA", "LOCAL_DRAFT", "WATCH"].includes(item.status)).length,
      blocking: gates.filter((item) => item.status.startsWith("TODO")).length,
    },
    warning: "This dashboard is intentionally conservative. Local metadata can guide demos, but mainnet gates must be signed/core-backed.",
  };
}

function mempoolPosture(rpcHealth?: RpcHealthSnapshot) {
  const selectedWrite = rpcHealth?.selectedWrite;
  const quarantined = rpcHealth?.endpoints?.filter((endpoint) => endpoint.quarantined).length ?? 0;
  if (!rpcHealth?.selectedRead) {
    return component("mempool_rpc", "critical", "No readable RPC endpoint selected.", ["Check LYTH_RPC_URLS and chain reachability."]);
  }
  if (!selectedWrite) {
    return component("mempool_rpc", "degraded", "No write-ready RPC endpoint selected.", ["Read-only queries may work; signing/broadcast flows should stop."]);
  }
  if (quarantined > 0) {
    return component("mempool_rpc", "watch", `${quarantined} endpoint(s) quarantined or low-score.`, ["Use rpc_health before writes."]);
  }
  return component("mempool_rpc", "ok", "Readable and write-ready RPC endpoint selected.", []);
}

function ferveoPosture() {
  return component("ferveo_threshold", "watch", "Ferveo threshold/decryption status is not queryable from MCP yet.", ["TODO(mainnet): read signed threshold status from core/indexer."]);
}

function ccipBridgePosture(registry: BridgeRegistry) {
  const ccipRoutes = registry.routes.filter((route) => route.routeType === "chainlink_ccip");
  if (ccipRoutes.length === 0) {
    return component("chainlink_ccip_bridge", "degraded", "No Chainlink CCIP route metadata exists.", ["Bridge route readiness cannot be assessed."]);
  }
  const nonLinkRoutes = ccipRoutes.filter((route) => (route.feeToken ?? "").trim().toUpperCase() !== "LINK");
  if (nonLinkRoutes.length > 0) {
    return component("chainlink_ccip_bridge", "critical", "CCIP route(s) are missing LINK fee-token metadata.", nonLinkRoutes.map((route) => route.id));
  }
  const activeUnaudited = ccipRoutes.filter((route) => route.status === "active" && !route.audits?.length);
  if (activeUnaudited.length > 0) {
    return component("chainlink_ccip_bridge", "critical", "Active CCIP route(s) are missing audit metadata.", activeUnaudited.map((route) => route.id));
  }
  return component("chainlink_ccip_bridge", "watch", `${ccipRoutes.length} Chainlink CCIP route(s) are present in local metadata.`, ["Activation still requires live route rows from core/indexer."]);
}

function oraclePosture(registry?: ClusterRegistry) {
  return hasOracleService(registry)
    ? component("oracle_services", "watch", "Oracle service tier exists in local cluster metadata.", ["TODO(mainnet): read live oracle status and slashing/attestation data."])
    : component("oracle_services", "degraded", "No oracle service tier found in local cluster metadata.", []);
}

function riscVmGatePosture() {
  return component("riscv_vm_gate", "watch", "Rust/RISC-V contract gate is a strategic target but not queryable from MCP yet.", ["TODO(core): expose VM/version/gas/cycle gate status."]);
}

function walletPosture(wallets: WalletSummary[], outboxEntries: TxOutboxEntry[]) {
  const hotWallets = wallets.filter((wallet) => Boolean((wallet.lowValue as { enabled?: boolean } | undefined)?.enabled));
  const signed = outboxEntries.filter((entry) => entry.status === "signed").length;
  if (hotWallets.length > 0 || signed > 0) {
    return component("wallet_hot_mode", "watch", `${hotWallets.length} hot wallet(s), ${signed} signed payload(s) pending.`, ["Keep balances capped; retry from outbox instead of rebuilding."]);
  }
  return component("wallet_hot_mode", "ok", "No low-value hot-wallet or signed-payload pressure detected.", []);
}

function outboxPosture(entries: TxOutboxEntry[], now: Date) {
  const stale = entries.filter((entry) => entry.status === "signed" && isPast(entry.expiresAt, now)).length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  if (stale > 0) {
    return component("signed_payload_outbox", "watch", `${stale} locally expired signed payload(s) should be reviewed.`, ["Use tx_outbox_release only with user approval."]);
  }
  if (failed > 0) {
    return component("signed_payload_outbox", "watch", `${failed} failed outbox payload(s) recorded.`, ["Use tx_error_explain before retrying."]);
  }
  return component("signed_payload_outbox", "ok", "No stale signed outbox pressure detected.", []);
}

function recoveryReadiness(wallet: WalletSummary, signed: number, submitted: number): SecuritySeverity {
  if ((wallet.agent as { paused?: boolean } | undefined)?.paused) {
    return "watch";
  }
  if (signed > 0 || submitted > 0) {
    return "degraded";
  }
  if ((wallet.lowValue as { enabled?: boolean } | undefined)?.enabled) {
    return "watch";
  }
  return "ok";
}

function recoveryRunbooks(walletName: string) {
  return [
    recoveryRunbookDraft({ kind: "pause_agent", walletName }),
    recoveryRunbookDraft({ kind: "drain_agent", walletName }),
    recoveryRunbookDraft({ kind: "delete_local_wallet", walletName }),
    recoveryRunbookDraft({ kind: "rotate_emergency_key", walletName }),
  ];
}

function hasOracleService(registry?: ClusterRegistry): boolean {
  return Boolean(registry?.clusters.some((cluster) => cluster.serviceTiers?.some((service) => service.type === "oracle")));
}

function event(severity: SecuritySeverity, code: string, message: string, data?: Record<string, unknown>) {
  return { severity, code, message, data };
}

function gate(id: string, status: string, detail: string, impact: string) {
  return { id, status, detail, impact };
}

function component(id: string, severity: SecuritySeverity, summary: string, actions: string[]) {
  return { id, severity, summary, actions };
}

function isPast(value: string | undefined, now = new Date()): boolean {
  return Boolean(value && Date.parse(value) <= now.getTime());
}

function highestSeverity(values: SecuritySeverity[]): SecuritySeverity {
  return values.reduce<SecuritySeverity>((highest, value) => severityRank(value) > severityRank(highest) ? value : highest, "ok");
}

function severityRank(value: SecuritySeverity): number {
  return value === "critical" ? 4 : value === "degraded" ? 3 : value === "watch" ? 2 : 1;
}
