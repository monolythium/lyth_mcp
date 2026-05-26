import { type BridgeRegistry } from "./bridges.js";
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
export declare function securityStatus(ctx: SecurityContext): {
    checkedAt: string;
    network: string;
    chainId: number;
    submitEnabled: boolean;
    severity: SecuritySeverity;
    decision: string;
    components: {
        id: string;
        severity: SecuritySeverity;
        summary: string;
        actions: string[];
    }[];
    bridgeAlerts: import("./bridges.js").BridgeCircuitAlert[];
    assumptions: string[];
};
export declare function emergencyStateWatch(ctx: SecurityContext): {
    checkedAt: string;
    severity: SecuritySeverity;
    action: string;
    events: {
        severity: SecuritySeverity;
        code: string;
        message: string;
        data: Record<string, unknown> | undefined;
    }[];
    operatorRunbooks: {
        name: string;
        tool: string;
        trigger: string;
    }[];
};
export declare function bridgeBlastRadiusMonitor(ctx: SecurityContext, args?: {
    asset?: string;
    includeDraftRoutes?: boolean;
}): {
    checkedAt: string;
    asset: string | undefined;
    severity: string;
    recommendation: string;
    affectedRoutes: {
        routeId: string;
        displayName: string | undefined;
        status: import("./bridges.js").BridgeRouteStatus;
        routeType: string;
        circuitBreaker: {
            enabled?: boolean;
            paused?: boolean;
            reason?: string;
        } | undefined;
        drainCap: {
            perEpoch?: string;
            remaining?: string;
            asset?: string;
        } | undefined;
        risk: import("./bridges.js").BridgeRisk;
        attention: boolean;
    }[];
    alerts: import("./bridges.js").BridgeCircuitAlert[];
    inFlight: {
        bridgeReceipts: {
            id: string;
            kind: string;
            status: import("./receipts.js").ReceiptStatus;
            txHash: string | undefined;
            summary: string;
        }[];
        signedBridgePayloads: {
            id: string;
            status: import("./outbox.js").OutboxStatus;
            amount: string | undefined;
            asset: string | undefined;
            note: string | undefined;
        }[];
    };
    caveats: string[];
};
export declare function recoveryStatus(ctx: SecurityContext, walletName?: string): {
    checkedAt: string;
    wallets: {
        name: string;
        address: string;
        agent: import("./wallet.js").AgentWalletMetadata | null;
        lowValue: (Omit<import("./wallet.js").LowValuePolicy, "encryptedMnemonic"> & {
            accounting?: import("./wallet.js").LowValueAccountingSummary;
        }) | null;
        recoveryReadiness: SecuritySeverity;
        availableRunbooks: ({
            title: string;
            requiredTool: string;
            arguments: {
                name: string | undefined;
                confirm: string;
                to?: undefined;
                confirmName?: undefined;
                id?: undefined;
                walletName?: undefined;
            };
            effect: string;
            caveat: string;
            schemaVersion: number;
            createdAt: string;
            kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
            reason: string;
            unsigned: boolean;
            todo: string;
        } | {
            title: string;
            requiredTool: string;
            arguments: {
                name: string | undefined;
                to: string;
                confirm: string;
                confirmName?: undefined;
                id?: undefined;
                walletName?: undefined;
            };
            effect: string;
            caveat: string;
            schemaVersion: number;
            createdAt: string;
            kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
            reason: string;
            unsigned: boolean;
            todo: string;
        } | {
            title: string;
            requiredTool: string;
            arguments: {
                name: string | undefined;
                confirmName: string | undefined;
                confirm: string;
                to?: undefined;
                id?: undefined;
                walletName?: undefined;
            };
            effect: string;
            caveat: string;
            schemaVersion: number;
            createdAt: string;
            kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
            reason: string;
            unsigned: boolean;
            todo: string;
        } | {
            title: string;
            requiredTool: string;
            arguments: {
                id: string | undefined;
                confirm: string;
                name?: undefined;
                to?: undefined;
                confirmName?: undefined;
                walletName?: undefined;
            };
            effect: string;
            caveat: string;
            schemaVersion: number;
            createdAt: string;
            kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
            reason: string;
            unsigned: boolean;
            todo: string;
        } | {
            title: string;
            requiredTool: string;
            arguments: {
                walletName: string | undefined;
                name?: undefined;
                confirm?: undefined;
                to?: undefined;
                confirmName?: undefined;
                id?: undefined;
            };
            effect: string;
            caveat: string;
            schemaVersion: number;
            createdAt: string;
            kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
            reason: string;
            unsigned: boolean;
            todo: string;
        })[];
        signedPayloads: number;
        submittedPayloads: number;
    }[];
    missingProductionSignals: string[];
};
export declare function recoveryRunbookDraft(args: {
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    walletName?: string;
    outboxId?: string;
    reason?: string;
}): {
    title: string;
    requiredTool: string;
    arguments: {
        name: string | undefined;
        confirm: string;
        to?: undefined;
        confirmName?: undefined;
        id?: undefined;
        walletName?: undefined;
    };
    effect: string;
    caveat: string;
    schemaVersion: number;
    createdAt: string;
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    reason: string;
    unsigned: boolean;
    todo: string;
} | {
    title: string;
    requiredTool: string;
    arguments: {
        name: string | undefined;
        to: string;
        confirm: string;
        confirmName?: undefined;
        id?: undefined;
        walletName?: undefined;
    };
    effect: string;
    caveat: string;
    schemaVersion: number;
    createdAt: string;
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    reason: string;
    unsigned: boolean;
    todo: string;
} | {
    title: string;
    requiredTool: string;
    arguments: {
        name: string | undefined;
        confirmName: string | undefined;
        confirm: string;
        to?: undefined;
        id?: undefined;
        walletName?: undefined;
    };
    effect: string;
    caveat: string;
    schemaVersion: number;
    createdAt: string;
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    reason: string;
    unsigned: boolean;
    todo: string;
} | {
    title: string;
    requiredTool: string;
    arguments: {
        id: string | undefined;
        confirm: string;
        name?: undefined;
        to?: undefined;
        confirmName?: undefined;
        walletName?: undefined;
    };
    effect: string;
    caveat: string;
    schemaVersion: number;
    createdAt: string;
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    reason: string;
    unsigned: boolean;
    todo: string;
} | {
    title: string;
    requiredTool: string;
    arguments: {
        walletName: string | undefined;
        name?: undefined;
        confirm?: undefined;
        to?: undefined;
        confirmName?: undefined;
        id?: undefined;
    };
    effect: string;
    caveat: string;
    schemaVersion: number;
    createdAt: string;
    kind: "pause_agent" | "drain_agent" | "delete_local_wallet" | "release_stale_outbox" | "rotate_emergency_key";
    reason: string;
    unsigned: boolean;
    todo: string;
};
export declare function auditResearchGateDashboard(ctx: SecurityContext): {
    checkedAt: string;
    gates: {
        id: string;
        status: string;
        detail: string;
        impact: string;
    }[];
    summary: {
        total: number;
        readyLike: number;
        blocking: number;
    };
    warning: string;
};
