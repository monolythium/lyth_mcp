import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { canonicalize } from "./runbooks.js";

export type BridgeRouteType = "chainlink_ccip";
export type BridgeRouteStatus = "active" | "draft" | "degraded" | "paused";

export interface BridgeRegistry {
  schemaVersion?: number;
  network?: string;
  issuer?: string;
  updatedAt?: string;
  epochHours?: number;
  disclaimer?: string;
  routes: BridgeRoute[];
  [key: string]: unknown;
}

export interface BridgeRoute {
  id: string;
  displayName?: string;
  status: BridgeRouteStatus;
  routeType: string;
  feeToken?: string;
  sourceChain: string;
  destinationChain: string;
  sourceAsset: string;
  destinationAsset: string;
  cooldown?: {
    epochs?: number;
    hours?: number;
    label?: string;
  };
  finality?: {
    threshold?: string;
    notes?: string;
  };
  fees?: {
    flat?: string;
    bps?: number;
    asset?: string;
  };
  limits?: {
    minAmount?: string;
    maxAmount?: string;
  };
  drainCap?: {
    perEpoch?: string;
    remaining?: string;
    asset?: string;
  };
  circuitBreaker?: {
    enabled?: boolean;
    paused?: boolean;
    reason?: string;
  };
  trustAssumptions?: string[];
  dependencies?: string[];
  audits?: string[];
  insurance?: string;
  upgradeAuthority?: string;
  liquidityVenues?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface LoadedBridgeRegistry {
  source: string;
  registry: BridgeRegistry;
  contentHash: string;
  bytes: number;
  updatedAt?: string;
}

export interface BridgeQuote {
  executable: boolean;
  route: BridgeRoute;
  amount: string;
  asset: string;
  estimatedFee: string;
  estimatedReceiveAmount: string;
  cooldown: {
    epochs?: number;
    hours: number;
    label: string;
  };
  risk: BridgeRisk;
  violations: string[];
  warnings: string[];
}

export interface BridgeRisk {
  level: "low" | "medium" | "high" | "blocked";
  reasons: string[];
  trustModel: string;
}

export interface BridgeCircuitAlert {
  routeId: string;
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
  routeStatus: BridgeRouteStatus;
  routeType: string;
}

export async function loadBridgeRegistry(path: string): Promise<LoadedBridgeRegistry> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as BridgeRegistry | BridgeRoute[];
  const registry = Array.isArray(parsed) ? { routes: parsed } : parsed;
  if (!Array.isArray(registry.routes)) {
    throw new Error("bridge registry must be an array or an object with a routes array");
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

export function bridgeRegistrySummary(loaded: LoadedBridgeRegistry) {
  const routeTypes = [...new Set(loaded.registry.routes.map((route) => route.routeType))].sort();
  const statuses = [...new Set(loaded.registry.routes.map((route) => route.status))].sort();
  const assets = [...new Set(loaded.registry.routes.flatMap((route) => [route.sourceAsset, route.destinationAsset]).map((asset) => asset.toUpperCase()))].sort();
  return {
    source: loaded.source,
    schemaVersion: loaded.registry.schemaVersion,
    network: loaded.registry.network,
    issuer: loaded.registry.issuer,
    epochHours: loaded.registry.epochHours ?? 14,
    disclaimer: loaded.registry.disclaimer,
    contentHash: loaded.contentHash,
    bytes: loaded.bytes,
    updatedAt: loaded.updatedAt,
    routeCount: loaded.registry.routes.length,
    routeTypes,
    statuses,
    assets,
  };
}

export function listBridgeRoutes(registry: BridgeRegistry, args: {
  asset?: string;
  sourceChain?: string;
  destinationChain?: string;
  status?: BridgeRouteStatus;
  routeType?: BridgeRouteType;
  limit?: number;
} = {}): BridgeRoute[] {
  const asset = args.asset?.toUpperCase();
  return registry.routes
    .filter((route) => !asset || route.sourceAsset.toUpperCase() === asset || route.destinationAsset.toUpperCase() === asset)
    .filter((route) => !args.sourceChain || same(route.sourceChain, args.sourceChain))
    .filter((route) => !args.destinationChain || same(route.destinationChain, args.destinationChain))
    .filter((route) => !args.status || route.status === args.status)
    .filter((route) => !args.routeType || route.routeType === args.routeType)
    .slice(0, args.limit ?? 50);
}

export function getBridgeRoute(registry: BridgeRegistry, id: string): BridgeRoute {
  const route = registry.routes.find((item) => item.id === id);
  if (!route) {
    throw new Error(`bridge route '${id}' not found`);
  }
  return route;
}

export function selectBridgeRoute(registry: BridgeRegistry, args: {
  asset: string;
  sourceChain?: string;
  destinationChain?: string;
}): BridgeRoute | null {
  const candidates = listBridgeRoutes(registry, {
    asset: args.asset,
    sourceChain: args.sourceChain,
    destinationChain: args.destinationChain,
  });
  return candidates.sort((a, b) => routeScore(b) - routeScore(a))[0] ?? null;
}

export function quoteBridgeRoute(route: BridgeRoute, args: {
  amount: string;
  asset?: string;
  epochHours?: number;
}): BridgeQuote {
  decimalToUnits(args.amount);
  const asset = (args.asset ?? route.sourceAsset).toUpperCase();
  const warnings: string[] = [];
  const violations: string[] = [];
  if (asset !== route.sourceAsset.toUpperCase() && asset !== route.destinationAsset.toUpperCase()) {
    violations.push(`Asset ${asset} is not part of route ${route.id}.`);
  }
  if (route.status !== "active") {
    violations.push(`Route status is ${route.status}; this MCP will not treat it as executable.`);
  }
  if (route.routeType !== "chainlink_ccip") {
    violations.push(`Route ${route.id} is not a Chainlink CCIP route.`);
  }
  if ((route.feeToken ?? "").trim().toUpperCase() !== "LINK") {
    violations.push(`Route ${route.id} must use LINK as the route fee token.`);
  }
  if (route.circuitBreaker?.paused) {
    violations.push(`Circuit breaker is paused${route.circuitBreaker.reason ? `: ${route.circuitBreaker.reason}` : "."}`);
  }
  if (route.limits?.minAmount && compareDecimal(args.amount, route.limits.minAmount) < 0) {
    violations.push(`Amount ${args.amount} is below route minAmount ${route.limits.minAmount}.`);
  }
  if (route.limits?.maxAmount && compareDecimal(args.amount, route.limits.maxAmount) > 0) {
    violations.push(`Amount ${args.amount} exceeds route maxAmount ${route.limits.maxAmount}.`);
  }
  if (route.drainCap?.remaining && compareDecimal(args.amount, route.drainCap.remaining) > 0) {
    violations.push(`Amount ${args.amount} exceeds route drain-cap remaining ${route.drainCap.remaining}.`);
  }
  if (!route.audits?.length) {
    warnings.push("No audit metadata is configured for this bridge route.");
  }
  if (!route.insurance) {
    warnings.push("No insurance/backstop metadata is configured for this bridge route.");
  }
  const estimatedFee = estimateFee(args.amount, route.fees);
  const estimatedReceiveAmount = subtractDecimal(args.amount, estimatedFee);
  const cooldown = routeCooldown(route, args.epochHours ?? 14);
  const risk = riskForRoute(route, violations, warnings);
  return {
    executable: violations.length === 0,
    route,
    amount: args.amount,
    asset,
    estimatedFee,
    estimatedReceiveAmount,
    cooldown,
    risk,
    violations,
    warnings,
  };
}

export function bridgeCooldownMatrix(registry: BridgeRegistry) {
  const epochHours = registry.epochHours ?? 14;
  return registry.routes.map((route) => ({
    routeId: route.id,
    sourceChain: route.sourceChain,
    destinationChain: route.destinationChain,
    asset: `${route.sourceAsset}->${route.destinationAsset}`,
    routeType: route.routeType,
    status: route.status,
    cooldown: routeCooldown(route, epochHours),
    finality: route.finality,
    circuitBreaker: route.circuitBreaker,
  }));
}

export function bridgeStatusSummary(registry: BridgeRegistry) {
  return registry.routes.map((route) => {
    const risk = riskForRoute(route, route.status === "active" ? [] : [`Route status is ${route.status}.`], []);
    return {
      routeId: route.id,
      displayName: route.displayName,
      status: route.status,
      routeType: route.routeType,
      circuitBreaker: route.circuitBreaker,
      drainCap: route.drainCap,
      risk,
      attention: route.status !== "active" || route.circuitBreaker?.paused || risk.level !== "low",
    };
  });
}

export function bridgeCircuitBreakerAlerts(registry: BridgeRegistry, args: {
  asset?: string;
  drainCapWarnPercent?: number;
} = {}): BridgeCircuitAlert[] {
  const routes = listBridgeRoutes(registry, { asset: args.asset });
  const drainCapWarnPercent = args.drainCapWarnPercent ?? 20;
  const alerts: BridgeCircuitAlert[] = [];
  for (const route of routes) {
    if (route.circuitBreaker?.paused) {
      alerts.push(alert(route, "critical", "BridgeRoutePaused", `Route ${route.id} is paused${route.circuitBreaker.reason ? `: ${route.circuitBreaker.reason}` : "."}`));
    }
    if (route.status !== "active") {
      alerts.push(alert(route, route.status === "paused" ? "critical" : "warning", "BridgeRouteNotActive", `Route ${route.id} status is ${route.status}; do not treat it as executable.`));
    }
    if (route.routeType !== "chainlink_ccip") {
      alerts.push(alert(route, "critical", "BridgeRouteNotCcip", `Route ${route.id} is not configured as Chainlink CCIP.`));
    }
    if ((route.feeToken ?? "").trim().toUpperCase() !== "LINK") {
      alerts.push(alert(route, "critical", "BridgeRouteFeeTokenNotLink", `Route ${route.id} does not use LINK as the route fee token.`));
    }
    if (!route.audits?.length) {
      alerts.push(alert(route, "warning", "MissingBridgeAuditMetadata", `Route ${route.id} has no audit metadata configured.`));
    }
    if (!route.insurance || route.insurance.toLowerCase() === "tbd") {
      alerts.push(alert(route, "info", "MissingBridgeInsuranceMetadata", `Route ${route.id} has no finalized insurance/backstop metadata.`));
    }
    const remaining = route.drainCap?.remaining;
    const perEpoch = route.drainCap?.perEpoch;
    if (remaining && perEpoch) {
      const remainingUnits = decimalToUnits(remaining);
      const capUnits = decimalToUnits(perEpoch);
      if (capUnits > 0n) {
        const percent = Number(remainingUnits * 10_000n / capUnits) / 100;
        if (percent <= drainCapWarnPercent) {
          alerts.push(alert(route, percent <= 5 ? "critical" : "warning", "BridgeDrainCapLow", `Route ${route.id} drain-cap remaining is ${percent}% (${remaining}/${perEpoch} ${route.drainCap?.asset ?? route.sourceAsset}).`));
        }
      }
    }
  }
  return alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.routeId.localeCompare(b.routeId));
}

function routeCooldown(route: BridgeRoute, epochHours: number): BridgeQuote["cooldown"] {
  const hours = route.cooldown?.hours ?? (route.cooldown?.epochs ? route.cooldown.epochs * epochHours : epochHours);
  return {
    epochs: route.cooldown?.epochs,
    hours,
    label: route.cooldown?.label ?? (route.cooldown?.epochs ? `${route.cooldown.epochs} epoch${route.cooldown.epochs === 1 ? "" : "s"} (~${hours}h)` : `~${hours}h`),
  };
}

function alert(route: BridgeRoute, severity: BridgeCircuitAlert["severity"], code: string, message: string): BridgeCircuitAlert {
  return {
    routeId: route.id,
    severity,
    code,
    message,
    routeStatus: route.status,
    routeType: route.routeType,
  };
}

function severityRank(severity: BridgeCircuitAlert["severity"]): number {
  if (severity === "critical") {
    return 3;
  }
  if (severity === "warning") {
    return 2;
  }
  return 1;
}

function riskForRoute(route: BridgeRoute, violations: string[], warnings: string[]): BridgeRisk {
  const reasons: string[] = [];
  if (violations.length > 0) {
    reasons.push(...violations);
    return { level: "blocked", reasons, trustModel: route.routeType };
  }
  if (route.routeType !== "chainlink_ccip" || (route.feeToken ?? "").trim().toUpperCase() !== "LINK") {
    reasons.push("Route is outside the Chainlink CCIP + LINK scope.");
    return { level: "blocked", reasons: [...reasons, ...warnings], trustModel: route.routeType };
  }
  if (route.status === "degraded") {
    reasons.push("Route is degraded.");
    return { level: "high", reasons: [...reasons, ...warnings], trustModel: route.routeType };
  }
  reasons.push("Route is Chainlink CCIP scoped with LINK fees.");
  return { level: warnings.length ? "medium" : "low", reasons: [...reasons, ...warnings], trustModel: route.routeType };
}

function routeScore(route: BridgeRoute): number {
  let score = 0;
  if (route.status === "active") {
    score += 100;
  }
  if (route.routeType === "chainlink_ccip") {
    score += 20;
  }
  if ((route.feeToken ?? "").trim().toUpperCase() !== "LINK") {
    score -= 100;
  }
  if (route.circuitBreaker?.paused) {
    score -= 100;
  }
  return score;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function estimateFee(amount: string, fees?: BridgeRoute["fees"]): string {
  const flat = fees?.flat ? decimalToUnits(fees.flat) : 0n;
  const bps = BigInt(fees?.bps ?? 0);
  const variable = decimalToUnits(amount) * bps / 10_000n;
  return unitsToDecimal(flat + variable);
}

function subtractDecimal(a: string, b: string): string {
  const result = decimalToUnits(a) - decimalToUnits(b);
  return unitsToDecimal(result < 0n ? 0n : result);
}

function compareDecimal(a: string, b: string): number {
  const aa = decimalToUnits(a);
  const bb = decimalToUnits(b);
  return aa === bb ? 0 : aa > bb ? 1 : -1;
}

function decimalToUnits(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: ${input}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal asset`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function unitsToDecimal(value: bigint, decimals = 18): string {
  const sign = value < 0n ? "-" : "";
  const raw = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals);
  const frac = raw.slice(-decimals).replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
