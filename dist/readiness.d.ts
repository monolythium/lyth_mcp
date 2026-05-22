export type ReadinessGateId = "no_evm" | "mrc" | "agent_commerce" | "bridge" | "wallet" | "runbook" | "security" | "docs" | "tests" | "external_commerce";
export interface ReadinessContext {
    toolNames: string[];
    runbookCount: number;
    vendorCount: number;
    bridgeRouteCount: number;
    activeBridgeRouteCount: number;
    assetCount: number;
    walletCount: number;
    docsUpdated?: boolean;
    testsUpdated?: boolean;
}
export declare function readinessCheck(ctx: ReadinessContext, gate?: ReadinessGateId | "all"): {
    checkedAt: string;
    gate: "all" | ReadinessGateId;
    completionPercent: number;
    status: string;
    gates: {
        status: string;
        next: string;
        id: ReadinessGateId;
        title: string;
        percent: number;
        done: string[];
        missing: string[];
    }[];
    mainnetWarning: string;
};
export declare function buildReadinessGates(ctx: ReadinessContext): {
    status: string;
    next: string;
    id: ReadinessGateId;
    title: string;
    percent: number;
    done: string[];
    missing: string[];
}[];
