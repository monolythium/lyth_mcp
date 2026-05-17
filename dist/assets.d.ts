export type AssetKind = "native" | "private_native" | "wrapped" | "issuer_native" | "mrc20" | "nft" | "vault";
export type AssetStatus = "active" | "draft" | "deprecated" | "blocked";
export type AssetDenomination = "public" | "private" | "external";
export type AssetUseCase = "transfer" | "commerce" | "service_payment" | "escrow" | "bridge" | "staking" | "contract" | "market" | "discovery" | "issuer_registration" | "private_transfer" | "private_burn" | "cross_to_private" | "view";
export interface AssetRegistry {
    schemaVersion?: number;
    network?: string;
    issuer?: string;
    updatedAt?: string;
    disclaimer?: string;
    assets: AssetRecord[];
    [key: string]: unknown;
}
export interface AssetRecord {
    symbol: string;
    name: string;
    kind: AssetKind;
    status: AssetStatus;
    denomination: AssetDenomination;
    decimals?: number;
    issuer?: string;
    canonical?: boolean;
    mrcStandard?: string;
    bridgeRouteIds?: string[];
    allowedUseCases?: AssetUseCase[];
    blockedUseCases?: AssetUseCase[];
    riskLabels?: string[];
    complianceNotes?: string[];
    walletWarnings?: string[];
    notes?: string[];
    [key: string]: unknown;
}
export interface LoadedAssetRegistry {
    source: string;
    registry: AssetRegistry;
    contentHash: string;
    bytes: number;
    updatedAt?: string;
}
export interface AssetRisk {
    symbol: string;
    level: "low" | "medium" | "high" | "blocked";
    labels: string[];
    warnings: string[];
    allowedUseCases: AssetUseCase[];
    blockedUseCases: AssetUseCase[];
}
export interface AssetUseCasePolicy {
    ok: boolean;
    code?: "PrivacyDenominationViolation" | "AssetUseCaseBlocked" | "AssetStatusBlocked";
    asset: AssetRecord;
    useCase: AssetUseCase;
    risk: AssetRisk;
    violations: string[];
    warnings: string[];
    explanation: string;
}
export declare function loadAssetRegistry(path: string): Promise<LoadedAssetRegistry>;
export declare function assetRegistrySummary(loaded: LoadedAssetRegistry): {
    source: string;
    schemaVersion: number | undefined;
    network: string | undefined;
    issuer: string | undefined;
    disclaimer: string | undefined;
    contentHash: string;
    bytes: number;
    updatedAt: string | undefined;
    assetCount: number;
    kinds: AssetKind[];
    statuses: AssetStatus[];
    denominations: AssetDenomination[];
};
export declare function listAssets(registry: AssetRegistry, args?: {
    query?: string;
    kind?: AssetKind;
    denomination?: AssetDenomination;
    status?: AssetStatus;
    useCase?: AssetUseCase;
    limit?: number;
}): AssetRecord[];
export declare function getAsset(registry: AssetRegistry, symbol: string): AssetRecord;
export declare function assetRisk(asset: AssetRecord): AssetRisk;
export declare function evaluateAssetUseCase(asset: AssetRecord, useCase: AssetUseCase): AssetUseCasePolicy;
export declare function privateDenominationWarning(asset?: AssetRecord): {
    title: string;
    appliesTo: string;
    warnings: string[];
    allowedUseCases: AssetUseCase[];
    blockedUseCases: AssetUseCase[];
};
