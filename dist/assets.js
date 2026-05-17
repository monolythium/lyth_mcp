import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { canonicalize } from "./runbooks.js";
const PRIVATE_BLOCKED_USE_CASES = [
    "commerce",
    "service_payment",
    "escrow",
    "bridge",
    "staking",
    "contract",
    "market",
    "discovery",
    "issuer_registration",
];
const PRIVATE_ALLOWED_USE_CASES = ["private_transfer", "private_burn", "cross_to_private", "view"];
export async function loadAssetRegistry(path) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const registry = Array.isArray(parsed) ? { assets: parsed } : parsed;
    if (!Array.isArray(registry.assets)) {
        throw new Error("asset registry must be an array or an object with an assets array");
    }
    const stats = await stat(path);
    const canonical = canonicalize(registry);
    return {
        source: path,
        registry,
        contentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
        bytes: Buffer.byteLength(raw),
        updatedAt: stats.mtime.toISOString(),
    };
}
export function assetRegistrySummary(loaded) {
    const kinds = [...new Set(loaded.registry.assets.map((asset) => asset.kind))].sort();
    const statuses = [...new Set(loaded.registry.assets.map((asset) => asset.status))].sort();
    const denominations = [...new Set(loaded.registry.assets.map((asset) => asset.denomination))].sort();
    return {
        source: loaded.source,
        schemaVersion: loaded.registry.schemaVersion,
        network: loaded.registry.network,
        issuer: loaded.registry.issuer,
        disclaimer: loaded.registry.disclaimer,
        contentHash: loaded.contentHash,
        bytes: loaded.bytes,
        updatedAt: loaded.updatedAt,
        assetCount: loaded.registry.assets.length,
        kinds,
        statuses,
        denominations,
    };
}
export function listAssets(registry, args = {}) {
    const q = args.query?.toLowerCase();
    return registry.assets
        .filter((asset) => !q || canonicalize(asset).toLowerCase().includes(q))
        .filter((asset) => !args.kind || asset.kind === args.kind)
        .filter((asset) => !args.denomination || asset.denomination === args.denomination)
        .filter((asset) => !args.status || asset.status === args.status)
        .filter((asset) => !args.useCase || assetUseCases(asset).includes(args.useCase))
        .slice(0, args.limit ?? 50);
}
export function getAsset(registry, symbol) {
    const normalized = normalizeSymbol(symbol);
    const asset = registry.assets.find((item) => normalizeSymbol(item.symbol) === normalized);
    if (!asset) {
        throw new Error(`asset '${symbol}' not found`);
    }
    return asset;
}
export function assetRisk(asset) {
    const labels = [...new Set([
            ...baseLabels(asset),
            ...(asset.riskLabels ?? []),
        ])];
    const warnings = [
        ...(asset.walletWarnings ?? []),
        ...(asset.complianceNotes ?? []),
    ];
    return {
        symbol: asset.symbol,
        level: riskLevel(asset, warnings),
        labels,
        warnings,
        allowedUseCases: assetUseCases(asset),
        blockedUseCases: blockedUseCases(asset),
    };
}
export function evaluateAssetUseCase(asset, useCase) {
    const risk = assetRisk(asset);
    const violations = [];
    const warnings = [...risk.warnings];
    let code;
    if (asset.status === "blocked" || asset.status === "deprecated") {
        code = "AssetStatusBlocked";
        violations.push(`Asset status is ${asset.status}.`);
    }
    if (asset.denomination === "private" && PRIVATE_BLOCKED_USE_CASES.includes(useCase)) {
        code = "PrivacyDenominationViolation";
        violations.push(`Private-denominated ${asset.symbol} cannot be used for ${useCase}.`);
    }
    if (blockedUseCases(asset).includes(useCase)) {
        code = code ?? "AssetUseCaseBlocked";
        violations.push(`${useCase} is blocked for ${asset.symbol}.`);
    }
    if (!assetUseCases(asset).includes(useCase)) {
        warnings.push(`${useCase} is not listed as an allowed use case for ${asset.symbol}.`);
    }
    const ok = violations.length === 0;
    return {
        ok,
        code,
        asset,
        useCase,
        risk,
        violations,
        warnings,
        explanation: ok
            ? `${asset.symbol} is allowed for ${useCase} under the local asset registry.`
            : code === "PrivacyDenominationViolation"
                ? "Privacy-denominated LYTH is intentionally cordoned off: it can move privately or burn/cross into privacy, but it cannot interact with commerce, bridges, staking, contracts, markets, discovery, issuer registration, escrow, or service payments."
                : `${asset.symbol} is not allowed for ${useCase} under the local asset registry.`,
    };
}
export function privateDenominationWarning(asset) {
    return {
        title: "Private denomination guardrail",
        appliesTo: asset?.symbol ?? "private-denominated LYTH",
        warnings: [
            "Private LYTH and public LYTH must be treated as separate denominations, not one combined balance.",
            "Private LYTH is not for commerce, bridges, staking, contracts, markets, discovery, issuer registration, escrow, or service payments.",
            "Crossing into privacy is one-way at the protocol level in this model; application-layer proofs may be needed for exchanges or frontends.",
            "Exchanges, vendors, and regulated frontends may reject privacy-denominated funds or require additional provenance checks.",
        ],
        allowedUseCases: PRIVATE_ALLOWED_USE_CASES,
        blockedUseCases: PRIVATE_BLOCKED_USE_CASES,
    };
}
function assetUseCases(asset) {
    if (asset.allowedUseCases?.length) {
        return asset.allowedUseCases;
    }
    if (asset.denomination === "private") {
        return PRIVATE_ALLOWED_USE_CASES;
    }
    if (asset.kind === "native") {
        return ["transfer", "commerce", "service_payment", "escrow", "bridge", "staking", "contract", "market", "discovery", "issuer_registration", "view"];
    }
    if (asset.kind === "wrapped" || asset.kind === "issuer_native" || asset.kind === "mrc20") {
        return ["transfer", "commerce", "service_payment", "escrow", "bridge", "market", "view"];
    }
    return ["transfer", "view"];
}
function blockedUseCases(asset) {
    const blocked = asset.blockedUseCases ?? [];
    return asset.denomination === "private"
        ? [...new Set([...PRIVATE_BLOCKED_USE_CASES, ...blocked])]
        : blocked;
}
function baseLabels(asset) {
    const labels = [asset.kind, asset.denomination, asset.status];
    if (asset.canonical) {
        labels.push("canonical");
    }
    if (asset.bridgeRouteIds?.length) {
        labels.push("bridge_route");
    }
    if (asset.kind === "wrapped") {
        labels.push("wrapped_asset");
    }
    if (asset.kind === "issuer_native") {
        labels.push("issuer_supported");
    }
    if (asset.denomination === "private") {
        labels.push("privacy_cordon");
    }
    return labels;
}
function riskLevel(asset, warnings) {
    if (asset.status === "blocked" || asset.status === "deprecated") {
        return "blocked";
    }
    if (asset.denomination === "private" || asset.kind === "wrapped") {
        return "high";
    }
    if (asset.status === "draft" || warnings.length > 0 || asset.kind === "issuer_native") {
        return "medium";
    }
    return "low";
}
function normalizeSymbol(symbol) {
    return symbol.trim().toUpperCase();
}
