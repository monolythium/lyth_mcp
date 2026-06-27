import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  RpcClient,
  type ClusterDirectoryEntryResponse,
  type ClusterDiversityView,
  type ClusterEntityResponse,
  type ClusterStatusResponse,
} from "@monolythium/core-sdk";
import { canonicalize } from "./runbooks.js";

export type ClusterStatus = "active" | "draft" | "degraded" | "sunsetting" | "retired";
export type ClusterServiceType = "rpc" | "archive" | "prover" | "oracle" | "indexer" | "validator";

export interface ClusterRegistry {
  schemaVersion?: number;
  network?: string;
  issuer?: string;
  updatedAt?: string;
  disclaimer?: string;
  clusters: ClusterRecord[];
  operators?: OperatorRecord[];
  [key: string]: unknown;
}

export interface ClusterServiceTier {
  type: ClusterServiceType;
  status: "active" | "draft" | "degraded" | "paused";
  pricePerMonth?: string;
  pricePerProof?: string;
  asset?: string;
  uptime30d?: number;
  gpuClass?: string;
  capacity?: string;
  proofLatencyMsP50?: number;
  [key: string]: unknown;
}

export interface ClusterRecord {
  id: string;
  displayName?: string;
  region?: string;
  jurisdiction?: string;
  status: ClusterStatus;
  foundationControlled?: boolean;
  quorum?: string;
  operatorSeats?: {
    total?: number;
    open?: number;
  };
  serviceTiers?: ClusterServiceTier[];
  reputation?: {
    score?: number;
    uptime30d?: number;
    slashingIncidents?: number;
    missedRounds30d?: number;
    responseTimeMsP50?: number;
    communityTrust?: number;
  };
  diversity?: {
    asnCount?: number;
    hostingClass?: string;
    clientDiversity?: number;
    geographicDiversity?: number;
    decentralizationScore?: number;
  };
  hardware?: {
    cpuClass?: string;
    ramGb?: number;
    storageTb?: number;
    gpu?: boolean;
    gpuClass?: string;
  };
  operators?: string[];
  sunset?: {
    planned?: boolean;
    at?: string;
    reason?: string;
    replacementClusterId?: string;
  };
  notes?: string[];
  [key: string]: unknown;
}

export interface OperatorRecord {
  id: string;
  displayName?: string;
  region?: string;
  foundationControlled?: boolean;
  clusterIds?: string[];
  openSeatInterest?: boolean;
  reputation?: {
    score?: number;
    uptime30d?: number;
    slashingIncidents?: number;
  };
  attestation?: {
    status?: "verified" | "draft" | "missing" | "expired";
    method?: string;
    notes?: string;
  };
  [key: string]: unknown;
}

export interface LoadedClusterRegistry {
  source: string;
  registry: ClusterRegistry;
  contentHash: string;
  bytes: number;
  updatedAt?: string;
}

export async function loadClusterRegistry(path: string): Promise<LoadedClusterRegistry> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ClusterRegistry | ClusterRecord[];
  const registry = Array.isArray(parsed) ? { clusters: parsed } : parsed;
  if (!Array.isArray(registry.clusters)) {
    throw new Error("cluster registry must be an array or an object with a clusters array");
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

export function clusterRegistrySummary(loaded: LoadedClusterRegistry) {
  const regions = [...new Set(loaded.registry.clusters.map((cluster) => cluster.region).filter(Boolean))].sort();
  const statuses = [...new Set(loaded.registry.clusters.map((cluster) => cluster.status))].sort();
  const services = [...new Set(loaded.registry.clusters.flatMap((cluster) => cluster.serviceTiers?.map((service) => service.type) ?? []))].sort();
  return {
    source: loaded.source,
    schemaVersion: loaded.registry.schemaVersion,
    network: loaded.registry.network,
    issuer: loaded.registry.issuer,
    disclaimer: loaded.registry.disclaimer,
    contentHash: loaded.contentHash,
    bytes: loaded.bytes,
    updatedAt: loaded.updatedAt,
    clusterCount: loaded.registry.clusters.length,
    operatorCount: loaded.registry.operators?.length ?? 0,
    foundationControlledCount: loaded.registry.clusters.filter((cluster) => cluster.foundationControlled).length,
    regions,
    statuses,
    services,
  };
}

export function listClusters(registry: ClusterRegistry, args: {
  query?: string;
  region?: string;
  jurisdiction?: string;
  status?: ClusterStatus;
  serviceType?: ClusterServiceType;
  foundationControlled?: boolean;
  gpuRequired?: boolean;
  minOpenSeats?: number;
  limit?: number;
} = {}): ClusterRecord[] {
  const query = args.query?.toLowerCase();
  return registry.clusters
    .filter((cluster) => !query || canonicalize(cluster).toLowerCase().includes(query))
    .filter((cluster) => !args.region || same(cluster.region, args.region))
    .filter((cluster) => !args.jurisdiction || same(cluster.jurisdiction, args.jurisdiction))
    .filter((cluster) => !args.status || cluster.status === args.status)
    .filter((cluster) => args.foundationControlled === undefined || Boolean(cluster.foundationControlled) === args.foundationControlled)
    .filter((cluster) => args.gpuRequired === undefined || Boolean(cluster.hardware?.gpu) === args.gpuRequired)
    .filter((cluster) => !args.serviceType || cluster.serviceTiers?.some((service) => service.type === args.serviceType))
    .filter((cluster) => args.minOpenSeats === undefined || (cluster.operatorSeats?.open ?? 0) >= args.minOpenSeats)
    .sort((a, b) => clusterScore(b) - clusterScore(a))
    .slice(0, args.limit ?? 50);
}

export function getCluster(registry: ClusterRegistry, id: string): ClusterRecord {
  const cluster = registry.clusters.find((item) => item.id === id);
  if (!cluster) {
    throw new Error(`cluster '${id}' not found`);
  }
  return cluster;
}

export function clusterReputation(cluster: ClusterRecord) {
  const warnings: string[] = [];
  const labels: string[] = [];
  const score = clusterScore(cluster);
  if (cluster.foundationControlled) {
    warnings.push("Foundation-controlled cluster: good bootstrap reliability, weaker decentralization for delegation routing.");
    labels.push("foundation_controlled");
  }
  if (cluster.status !== "active") {
    warnings.push(`Cluster status is ${cluster.status}; avoid production routing until active.`);
    labels.push(cluster.status);
  }
  if ((cluster.reputation?.slashingIncidents ?? 0) > 0) {
    warnings.push(`Cluster has ${cluster.reputation?.slashingIncidents} slashing incident(s).`);
    labels.push("slashing_history");
  }
  if ((cluster.reputation?.uptime30d ?? 0) > 0 && (cluster.reputation?.uptime30d ?? 0) < 99.5) {
    warnings.push(`30d uptime ${cluster.reputation?.uptime30d}% is below the 99.5% planning threshold.`);
    labels.push("uptime_watch");
  }
  if ((cluster.diversity?.decentralizationScore ?? 0) >= 85) {
    labels.push("high_decentralization");
  }
  if (cluster.hardware?.gpu || cluster.serviceTiers?.some((service) => service.type === "prover")) {
    labels.push("gpu_prover");
  }
  return {
    clusterId: cluster.id,
    displayName: cluster.displayName,
    score,
    level: score >= 85 ? "low" : score >= 70 ? "medium" : score >= 50 ? "high" : "blocked",
    labels,
    warnings,
    reputation: cluster.reputation,
    diversity: cluster.diversity,
    serviceTiers: cluster.serviceTiers,
    assumptions: [
      "This is local MCP planning metadata, not a live validator selection result.",
      "TODO(mainnet): replace with signed cluster registry, live uptime, slashing, attestation, and quorum data.",
    ],
  };
}

export function clusterFoundationFlag(cluster: ClusterRecord) {
  return {
    clusterId: cluster.id,
    foundationControlled: Boolean(cluster.foundationControlled),
    explanation: cluster.foundationControlled
      ? "Foundation-controlled cluster. Useful for bootstrap operations, but not the best default for maximum decentralization."
      : "Not marked foundation-controlled in the local registry.",
    stakingGuidance: cluster.foundationControlled
      ? "Prefer community/non-foundation clusters for max-decentralization delegation unless reliability is the priority."
      : "Potential candidate for decentralization-oriented delegation, subject to reputation, uptime, and cap checks.",
  };
}

export function clusterSunsetStatus(cluster: ClusterRecord) {
  return {
    clusterId: cluster.id,
    status: cluster.status,
    planned: Boolean(cluster.sunset?.planned || cluster.status === "sunsetting" || cluster.status === "retired"),
    sunset: cluster.sunset,
    warning: cluster.status === "sunsetting" || cluster.status === "retired"
      ? "Avoid new delegation or service routing to this cluster."
      : cluster.sunset?.planned
        ? "Sunset is planned; check replacement routing before delegating."
        : undefined,
  };
}

export function listOperators(registry: ClusterRegistry, args: {
  query?: string;
  region?: string;
  clusterId?: string;
  foundationControlled?: boolean;
  openSeatInterest?: boolean;
  limit?: number;
} = {}): OperatorRecord[] {
  const query = args.query?.toLowerCase();
  return (registry.operators ?? [])
    .filter((operator) => !query || canonicalize(operator).toLowerCase().includes(query))
    .filter((operator) => !args.region || same(operator.region, args.region))
    .filter((operator) => !args.clusterId || operator.clusterIds?.includes(args.clusterId))
    .filter((operator) => args.foundationControlled === undefined || Boolean(operator.foundationControlled) === args.foundationControlled)
    .filter((operator) => args.openSeatInterest === undefined || Boolean(operator.openSeatInterest) === args.openSeatInterest)
    .sort((a, b) => (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0))
    .slice(0, args.limit ?? 50);
}

export function getOperator(registry: ClusterRegistry, id: string): OperatorRecord {
  const operator = (registry.operators ?? []).find((item) => item.id === id);
  if (!operator) {
    throw new Error(`operator '${id}' not found`);
  }
  return operator;
}

export function operatorStatus(registry: ClusterRegistry, operator: OperatorRecord) {
  const clusters = operator.clusterIds?.map((id) => {
    try {
      return getCluster(registry, id);
    } catch {
      return null;
    }
  }).filter((cluster): cluster is ClusterRecord => cluster !== null) ?? [];
  return {
    operator,
    clusters,
    openSeats: clusters.reduce((sum, cluster) => sum + (cluster.operatorSeats?.open ?? 0), 0),
    attestation: operator.attestation,
    warnings: [
      ...(operator.foundationControlled ? ["Foundation-controlled operator."] : []),
      ...(operator.attestation?.status !== "verified" ? ["Operator attestation is not verified in local metadata."] : []),
    ],
    assumptions: [
      "TODO(mainnet): replace local operator metadata with signed operator registry, TPM attestation, and live seat availability.",
    ],
  };
}

export function monarchOperatorAssistant(registry: ClusterRegistry, args: {
  clusterId?: string;
  operatorId?: string;
  region?: string;
  serviceType?: ClusterServiceType;
  includeDraft?: boolean;
  limit?: number;
} = {}) {
  const operator = args.operatorId ? getOperator(registry, args.operatorId) : undefined;
  const clusters = args.clusterId
    ? [getCluster(registry, args.clusterId)]
    : listClusters(registry, {
        region: args.region,
        serviceType: args.serviceType,
        status: args.includeDraft ? undefined : "active",
        limit: args.limit ?? 10,
      }).filter((cluster) => !operator || operator.clusterIds?.includes(cluster.id) || operator.openSeatInterest);
  return {
    scope: {
      clusterId: args.clusterId,
      operatorId: args.operatorId,
      region: args.region,
      serviceType: args.serviceType,
      includeDraft: Boolean(args.includeDraft),
    },
    operator: operator ? operatorStatus(registry, operator) : undefined,
    clusters: clusters.map((cluster) => monarchClusterReport(cluster)),
    recommendations: monarchRecommendations(clusters, operator),
    guardrails: [
      "This assistant is for node/operator planning, not consumer wallet UX.",
      "Do not expose validator maintenance, TPM/PCR, quorum, or service ROI controls inside payment/order flows.",
      "TODO(mainnet): replace local metadata with live quorum, update, resource, and revenue telemetry from core/indexer.",
    ],
  };
}

export function monarchClusterReport(cluster: ClusterRecord) {
  const reputation = clusterReputation(cluster);
  const pressure = resourcePressure(cluster);
  const roi = serviceRoi(cluster);
  return {
    clusterId: cluster.id,
    displayName: cluster.displayName,
    status: cluster.status,
    health: {
      level: reputation.level,
      score: reputation.score,
      uptime30d: cluster.reputation?.uptime30d,
      missedRounds30d: cluster.reputation?.missedRounds30d,
      slashingIncidents: cluster.reputation?.slashingIncidents ?? 0,
      warnings: reputation.warnings,
    },
    quorum: {
      configured: cluster.quorum ?? "unknown",
      explanation: cluster.quorum === "7-of-10"
        ? "Cluster is modeled as 10 operators with a 7-of-10 threshold; losing 4 operators can halt this cluster."
        : "Quorum is local metadata only; verify live consensus configuration before operations.",
      openSeats: cluster.operatorSeats?.open ?? 0,
      totalSeats: cluster.operatorSeats?.total,
    },
    updateStatus: {
      status: cluster.status,
      safeForNewOps: cluster.status === "active",
      note: cluster.status === "active"
        ? "No local update/sunset warning is active."
        : "Cluster is not marked active; avoid new service routing until live status clears.",
      todo: "TODO(mainnet): attach live binary version, upgrade window, and operator rollout status.",
    },
    resourcePressure: pressure,
    serviceRoi: roi,
    operatorSeats: cluster.operatorSeats,
    serviceTiers: cluster.serviceTiers,
    foundation: clusterFoundationFlag(cluster),
    sunset: clusterSunsetStatus(cluster),
    nodeOpsOnly: true,
  };
}

export function searchServices(registry: ClusterRegistry, args: {
  serviceType: ClusterServiceType;
  region?: string;
  activeOnly?: boolean;
  gpuClass?: string;
  maxLatencyMs?: number;
  limit?: number;
}) {
  return registry.clusters
    .filter((cluster) => !args.region || same(cluster.region, args.region))
    .flatMap((cluster) => (cluster.serviceTiers ?? [])
      .filter((service) => service.type === args.serviceType)
      .filter((service) => !args.activeOnly || service.status === "active")
      .filter((service) => !args.gpuClass || same(service.gpuClass, args.gpuClass))
      .filter((service) => args.maxLatencyMs === undefined || (service.proofLatencyMsP50 ?? Number.POSITIVE_INFINITY) <= args.maxLatencyMs)
      .map((service) => ({
        clusterId: cluster.id,
        clusterDisplayName: cluster.displayName,
        region: cluster.region,
        jurisdiction: cluster.jurisdiction,
        foundationControlled: Boolean(cluster.foundationControlled),
        reputation: clusterReputation(cluster),
        service,
      })))
    .sort((a, b) => serviceScore(b) - serviceScore(a))
    .slice(0, args.limit ?? 50);
}

function resourcePressure(cluster: ClusterRecord) {
  const totalSeats = cluster.operatorSeats?.total ?? 0;
  const openSeats = cluster.operatorSeats?.open ?? 0;
  const filledSeats = Math.max(0, totalSeats - openSeats);
  const seatPressure = totalSeats > 0 ? filledSeats / totalSeats : 0;
  const activeServices = (cluster.serviceTiers ?? []).filter((service) => service.status === "active");
  const degradedServices = (cluster.serviceTiers ?? []).filter((service) => service.status === "degraded" || service.status === "paused");
  const gpuPressure = cluster.hardware?.gpu && activeServices.some((service) => service.type === "prover")
    ? "gpu_capacity_should_be_monitored"
    : "no_gpu_pressure_signal";
  const level = degradedServices.length > 0 || cluster.status === "degraded"
    ? "high"
    : seatPressure >= 0.9
      ? "medium"
      : cluster.status !== "active"
        ? "high"
        : "low";
  return {
    level,
    seatPressurePercent: Math.round(seatPressure * 100),
    openSeats,
    activeServiceCount: activeServices.length,
    degradedServiceCount: degradedServices.length,
    gpuPressure,
    hardware: cluster.hardware,
    warnings: [
      ...(openSeats <= 1 && totalSeats > 0 ? ["Few open operator seats remain; onboarding flexibility is low."] : []),
      ...(degradedServices.length ? [`${degradedServices.length} service tier(s) are degraded or paused.`] : []),
      ...(cluster.status !== "active" ? [`Cluster status is ${cluster.status}.`] : []),
    ],
  };
}

function serviceRoi(cluster: ClusterRecord) {
  return (cluster.serviceTiers ?? []).map((service) => {
    const monthly = service.pricePerMonth ? Number(service.pricePerMonth) : undefined;
    const perProof = service.pricePerProof ? Number(service.pricePerProof) : undefined;
    const uptime = service.uptime30d ?? 0;
    const proofLatency = service.proofLatencyMsP50;
    const score = service.type === "prover"
      ? Math.round((uptime / 2) + Math.max(0, 40 - (proofLatency ?? 2000) / 100) - (perProof ?? 0) * 10)
      : Math.round((uptime / 2) + (monthly ? Math.max(0, 30 - monthly / 20) : 10));
    return {
      type: service.type,
      status: service.status,
      pricePerMonth: service.pricePerMonth,
      pricePerProof: service.pricePerProof,
      asset: service.asset,
      uptime30d: service.uptime30d,
      gpuClass: service.gpuClass,
      capacity: service.capacity,
      proofLatencyMsP50: service.proofLatencyMsP50,
      roiScore: Math.max(0, score),
      interpretation: service.type === "prover"
        ? "Prover ROI favors high uptime, low proof latency, and lower per-proof fee."
        : "Service ROI favors high uptime and lower monthly fee.",
      todo: "TODO(mainnet): replace heuristic ROI with live utilization, rewards, operating cost, and SLA revenue data.",
    };
  }).sort((a, b) => b.roiScore - a.roiScore);
}

function monarchRecommendations(clusters: ClusterRecord[], operator?: OperatorRecord) {
  const reports = clusters.map((cluster) => ({ cluster, reputation: clusterReputation(cluster), pressure: resourcePressure(cluster) }));
  const bestHealth = [...reports].sort((a, b) => b.reputation.score - a.reputation.score)[0];
  const openSeats = reports.filter((entry) => (entry.cluster.operatorSeats?.open ?? 0) > 0);
  return [
    bestHealth
      ? `Best health candidate: ${bestHealth.cluster.displayName ?? bestHealth.cluster.id} (${bestHealth.reputation.score}).`
      : "No cluster candidates matched the requested scope.",
    openSeats.length
      ? `Open-seat candidates: ${openSeats.map((entry) => entry.cluster.displayName ?? entry.cluster.id).join(", ")}.`
      : "No open seats found in the requested scope.",
    operator?.openSeatInterest
      ? `${operator.displayName ?? operator.id} is marked interested in open seats.`
      : operator
        ? `${operator.displayName ?? operator.id} is not marked as actively seeking open seats.`
        : "Pass operatorId to tailor onboarding and seat guidance.",
    "Keep operational changes behind explicit operator workflows; do not mix them with consumer wallet/order flows.",
  ];
}

function clusterScore(cluster: ClusterRecord): number {
  const reputation = cluster.reputation?.score ?? 50;
  const uptime = cluster.reputation?.uptime30d ? Math.min(100, cluster.reputation.uptime30d) : 50;
  const diversity = cluster.diversity?.decentralizationScore ?? 50;
  const statusPenalty = cluster.status === "active" ? 0 : cluster.status === "degraded" ? 15 : 35;
  const foundationPenalty = cluster.foundationControlled ? 8 : 0;
  const slashingPenalty = (cluster.reputation?.slashingIncidents ?? 0) * 20;
  return Math.max(0, Math.round(reputation * 0.45 + uptime * 0.2 + diversity * 0.35 - statusPenalty - foundationPenalty - slashingPenalty));
}

function serviceScore(entry: { reputation: ReturnType<typeof clusterReputation>; service: ClusterServiceTier }): number {
  const uptime = entry.service.uptime30d ?? 0;
  const latencyBonus = entry.service.proofLatencyMsP50 ? Math.max(0, 20 - entry.service.proofLatencyMsP50 / 100) : 0;
  const statusBonus = entry.service.status === "active" ? 20 : 0;
  return entry.reputation.score + uptime / 5 + latencyBonus + statusBonus;
}

function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

// ---------------------------------------------------------------------------
// Live on-chain discovery (node-registry 0x1005)
//
// The functions below back the discovery surface (cluster_search /
// operator_search / cluster_reputation / cluster_sunset_status /
// cluster_foundation_flag / operator_open_seats) with the same SDK reads the
// charter / service-score surface already uses, instead of the bundled
// clusters.example.json. Clusters are addressed by their numeric on-chain id;
// reputation, liveness, diversity, membership and entity flags are read live
// from the chain. There are no draft/manual placeholders and no hardcoded
// slashingIncidents — fields the chain does not expose are reported as such.
// ---------------------------------------------------------------------------

const NODE_REGISTRY_SOURCE = "node-registry-0x1005";

function liveClient(endpoint: string): RpcClient {
  return new RpcClient(endpoint);
}

function liveSettled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === "fulfilled"
    ? result.value
    : { error: (result.reason as { message?: string } | undefined)?.message ?? String(result.reason) };
}

function isLiveError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

interface ClusterReads {
  status: ClusterStatusResponse | { error: string };
  diversity: ClusterDiversityView | { error: string };
  score: bigint | { error: string };
  entity: ClusterEntityResponse | { error: string };
}

/**
 * Normalize the four live cluster reads (status / diversity / ServiceScore /
 * entity) into a single JSON-safe record, overlaying the directory-derived
 * fields (aggregate health, region diversity, active flag) when available.
 * Per-read failures are surfaced under `reads` rather than silently dropped.
 */
function shapeLiveCluster(clusterId: number, reads: ClusterReads, directory?: ClusterDirectoryEntryResponse) {
  const status = isLiveError(reads.status) ? null : reads.status;
  const diversity = isLiveError(reads.diversity) ? null : reads.diversity;
  const score = isLiveError(reads.score) ? null : reads.score;
  const entity = isLiveError(reads.entity) ? null : reads.entity;

  return {
    clusterId,
    source: NODE_REGISTRY_SOURCE,
    size: directory?.size ?? status?.size ?? null,
    threshold: directory?.threshold ?? status?.threshold ?? null,
    quorum: status?.quorum ?? null,
    quorumMet: status ? status.live >= status.threshold : null,
    active: directory?.active ?? null,
    aggregateHealth: directory?.aggregateHealth ?? null,
    regionDiversity: directory?.regionDiversity ?? null,
    reputationScore: status?.reputationScore ?? null,
    livenessScore: status?.livenessScore ?? null,
    serviceScore: score !== null ? score.toString() : null,
    diversityScore: diversity?.score ?? null,
    diversity: diversity
      ? {
          score: diversity.score,
          asnVariance: diversity.asnVariance,
          geoVariance: diversity.geoVariance,
          hostingSpread: diversity.hostingSpread,
        }
      : null,
    membership: status
      ? {
          live: status.live,
          lagging: status.lagging,
          offline: status.offline,
          maintenance: status.maintenance,
          members: status.members.map((member) => ({ operatorId: member.operatorId, state: member.state })),
        }
      : null,
    entityLabel: entity?.entity ?? null,
    foundationControlled: entity ? entity.entity !== "independent" : null,
    epoch: status?.epoch != null ? status.epoch.toString() : null,
    round: status?.round != null ? status.round.toString() : null,
    lastUpdateHeight: status ? status.lastUpdateHeight.toString() : null,
    reads: {
      status: isLiveError(reads.status) ? { error: reads.status.error } : "ok",
      diversity: isLiveError(reads.diversity) ? { error: reads.diversity.error } : "ok",
      serviceScore: isLiveError(reads.score) ? { error: reads.score.error } : "ok",
      entity: isLiveError(reads.entity) ? { error: reads.entity.error } : "ok",
    },
  };
}

type LiveClusterRecord = ReturnType<typeof shapeLiveCluster>;

function liveClusterRank(cluster: LiveClusterRecord): number {
  let rank = 0;
  if (cluster.quorumMet === true) rank += 100_000;
  if (cluster.active === true) rank += 50_000;
  rank += (cluster.reputationScore ?? 0) * 100;
  rank += (cluster.livenessScore ?? 0) * 10;
  rank += cluster.diversityScore ?? 0;
  return rank;
}

async function enrichDirectoryEntry(c: RpcClient, entry: ClusterDirectoryEntryResponse): Promise<LiveClusterRecord> {
  const [status, diversity, score, entity] = await Promise.allSettled([
    c.lythClusterStatus(entry.clusterId),
    c.lythGetClusterDiversity(entry.clusterId),
    c.lythGetClusterServiceScore(entry.clusterId),
    c.lythGetClusterEntity(entry.clusterId),
  ]);
  return shapeLiveCluster(
    entry.clusterId,
    {
      status: liveSettled(status),
      diversity: liveSettled(diversity),
      score: liveSettled(score),
      entity: liveSettled(entity),
    },
    entry,
  );
}

/** Read one cluster live, looking up its directory entry for the overlay fields. */
export async function readLiveCluster(endpoint: string, clusterId: number): Promise<LiveClusterRecord> {
  const c = liveClient(endpoint);
  const [directory, status, diversity, score, entity] = await Promise.allSettled([
    c.lythClusterDirectory(0, 100),
    c.lythClusterStatus(clusterId),
    c.lythGetClusterDiversity(clusterId),
    c.lythGetClusterServiceScore(clusterId),
    c.lythGetClusterEntity(clusterId),
  ]);
  const entry = directory.status === "fulfilled"
    ? directory.value.clusters.find((candidate) => candidate.clusterId === clusterId)
    : undefined;
  return shapeLiveCluster(
    clusterId,
    {
      status: liveSettled(status),
      diversity: liveSettled(diversity),
      score: liveSettled(score),
      entity: liveSettled(entity),
    },
    entry,
  );
}

/** cluster_search — live directory of clusters with live health/diversity/entity, filtered by on-chain-backed criteria. */
export async function searchLiveClusters(endpoint: string, args: {
  query?: string;
  region?: string;
  activeOnly?: boolean;
  foundationControlled?: boolean;
  limit?: number;
} = {}) {
  const c = liveClient(endpoint);
  const directory = await c.lythClusterDirectory(0, 100);
  const enriched = await Promise.all(directory.clusters.map((entry) => enrichDirectoryEntry(c, entry)));

  let clusters = enriched;
  if (args.activeOnly) {
    clusters = clusters.filter((cluster) => cluster.active === true);
  }
  if (args.foundationControlled !== undefined) {
    clusters = clusters.filter((cluster) => cluster.foundationControlled === args.foundationControlled);
  }
  if (args.region) {
    const region = args.region.toLowerCase();
    clusters = clusters.filter((cluster) => (cluster.regionDiversity ?? []).some((code) => code.toLowerCase() === region));
  }
  if (args.query) {
    const query = args.query.toLowerCase();
    clusters = clusters.filter((cluster) => canonicalize(cluster).toLowerCase().includes(query));
  }
  clusters = [...clusters].sort((a, b) => liveClusterRank(b) - liveClusterRank(a)).slice(0, args.limit ?? 50);

  return {
    endpoint,
    source: NODE_REGISTRY_SOURCE,
    totalClusters: directory.totalClusters,
    matched: clusters.length,
    clusters,
    notes: [
      "Live read from the on-chain node-registry (0x1005): cluster directory, status, diversity, ServiceScore and entity flag.",
      "Commercial fields (price/capacity/hardware/gpuClass) and service-tier markets have no on-chain representation and are not reported here.",
      "There is no on-chain open-seat primitive; seat availability is not inferred.",
    ],
  };
}

/** operator_search — operators discovered from live cluster rosters, enriched with on-chain identity + network metadata. */
export async function searchLiveOperators(endpoint: string, args: {
  query?: string;
  clusterId?: number;
  region?: string;
  limit?: number;
} = {}) {
  const c = liveClient(endpoint);
  let clusterIds: number[];
  if (args.clusterId !== undefined) {
    clusterIds = [args.clusterId];
  } else {
    const directory = await c.lythClusterDirectory(0, 100);
    clusterIds = directory.clusters.map((entry) => entry.clusterId);
  }

  const statuses = await Promise.allSettled(clusterIds.map((id) => c.lythClusterStatus(id)));
  const memberships = new Map<string, { clusterId: number; state: string }[]>();
  statuses.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const member of result.value.members) {
        const list = memberships.get(member.operatorId) ?? [];
        list.push({ clusterId: clusterIds[index], state: member.state });
        memberships.set(member.operatorId, list);
      }
    }
  });

  const operatorIds = [...memberships.keys()];
  const [infos, metas] = await Promise.all([
    Promise.allSettled(operatorIds.map((id) => c.lythOperatorInfo(id))),
    Promise.allSettled(operatorIds.map((id) => c.lythGetOperatorNetworkMetadata(id))),
  ]);

  let operators = operatorIds.map((id, index) => {
    const infoResult = infos[index];
    const metaResult = metas[index];
    const info = infoResult.status === "fulfilled" ? infoResult.value : null;
    const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
    return {
      operatorId: id,
      moniker: info?.moniker ?? null,
      alias: info?.alias ?? null,
      chainAddress: info?.chainAddress ?? null,
      bonded: info?.bonded ?? null,
      bondedAmount: info?.bondedAmount ?? null,
      lifecycleState: info?.lifecycleState ?? null,
      activeClusterIds: info?.activeClusterIds ?? null,
      memberships: memberships.get(id) ?? [],
      network: meta
        ? { asn: meta.asn, geoRegion: meta.geoRegion, hostingClass: meta.hostingClass }
        : null,
    };
  });

  if (args.region) {
    const region = args.region.toLowerCase();
    operators = operators.filter((operator) => (operator.network?.geoRegion ?? "").toLowerCase() === region);
  }
  if (args.query) {
    const query = args.query.toLowerCase();
    operators = operators.filter((operator) => canonicalize(operator).toLowerCase().includes(query));
  }
  operators = operators.slice(0, args.limit ?? 50);

  return {
    endpoint,
    source: NODE_REGISTRY_SOURCE,
    clusterIdsScanned: clusterIds,
    operatorCount: operators.length,
    operators,
    notes: [
      "Operators are discovered from live cluster rosters (node-registry 0x1005); identity, bond and network metadata are read per operator.",
      "Open-seat interest has no on-chain representation and is not reported.",
    ],
  };
}

/** cluster_reputation — live reputation/liveness/ServiceScore/diversity for one cluster. No slashingIncidents placeholder. */
export async function liveClusterReputation(endpoint: string, clusterId: number) {
  const cluster = await readLiveCluster(endpoint, clusterId);
  const labels: string[] = [];
  const warnings: string[] = [];

  if (cluster.foundationControlled === true) {
    labels.push("foundation_controlled");
    warnings.push("Entity/foundation-controlled cluster: good bootstrap reliability, weaker decentralization for delegation routing.");
  }
  if (cluster.active === false) {
    labels.push("inactive");
    warnings.push("Cluster is not active in the live directory; avoid production routing until it is active.");
  }
  if (cluster.quorumMet === false) {
    labels.push("below_threshold");
    warnings.push("Cluster is below its consensus threshold (live members < threshold); it cannot produce until quorum recovers.");
  }
  if (typeof cluster.diversityScore === "number" && cluster.diversityScore >= 8500) {
    labels.push("high_decentralization");
  }

  return {
    clusterId,
    source: NODE_REGISTRY_SOURCE,
    reputationScore: cluster.reputationScore,
    livenessScore: cluster.livenessScore,
    serviceScore: cluster.serviceScore,
    quorumMet: cluster.quorumMet,
    threshold: cluster.threshold,
    size: cluster.size,
    membership: cluster.membership,
    diversity: cluster.diversity,
    foundationControlled: cluster.foundationControlled,
    entityLabel: cluster.entityLabel,
    labels,
    warnings,
    notes: [
      "Reputation, liveness and ServiceScore are read live from the node-registry (0x1005); no draft/manual placeholders.",
      "Slashing history is not exposed by these reads (it requires chain-event indexing) and is not reported as zero here.",
    ],
  };
}

/** cluster_sunset_status — live operational status. The chain has no sunset/retired primitive; status is derived from live reads. */
export async function liveClusterSunsetStatus(endpoint: string, clusterId: number) {
  const cluster = await readLiveCluster(endpoint, clusterId);
  const warning = cluster.quorumMet === false
    ? "Cluster is below its consensus threshold; avoid new delegation or service routing until quorum recovers."
    : cluster.active === false
      ? "Cluster is not active in the live directory; avoid new delegation or routing."
      : undefined;
  return {
    clusterId,
    source: NODE_REGISTRY_SOURCE,
    active: cluster.active,
    quorumMet: cluster.quorumMet,
    aggregateHealth: cluster.aggregateHealth,
    threshold: cluster.threshold,
    size: cluster.size,
    membership: cluster.membership,
    warning,
    notes: [
      "The chain has no on-chain 'sunset'/'retired' primitive; operational status is derived live from the cluster directory, threshold and membership.",
    ],
  };
}

/** cluster_foundation_flag — live entity flag from the node-registry (independent vs entity/foundation). */
export async function liveClusterFoundationFlag(endpoint: string, clusterId: number) {
  const c = liveClient(endpoint);
  const entity = await c.lythGetClusterEntity(clusterId);
  const foundationControlled = entity.entity !== "independent";
  return {
    clusterId,
    source: NODE_REGISTRY_SOURCE,
    entity: { label: entity.entity, code: entity.entityCode },
    foundationControlled,
    explanation: foundationControlled
      ? `Cluster is registered on-chain to entity '${entity.entity}' (not independent). Useful for bootstrap reliability, but weaker for maximum decentralization.`
      : "Cluster is registered on-chain as an independent entity.",
    stakingGuidance: foundationControlled
      ? "Prefer independent clusters for max-decentralization delegation unless reliability is the priority."
      : "Potential candidate for decentralization-oriented delegation, subject to live reputation, liveness and cap checks.",
  };
}

/**
 * operator_open_seats — HONEST status. There is no on-chain open-seat primitive
 * yet, so this returns a "marketplace launching" status with 0 open seats and
 * lists the live clusters for context only. Seats are never fabricated.
 */
export async function liveOperatorOpenSeats(endpoint: string, args: { limit?: number } = {}) {
  const c = liveClient(endpoint);
  const directory = await c.lythClusterDirectory(0, 100);
  const entries = directory.clusters.slice(0, args.limit ?? 50);
  const statuses = await Promise.allSettled(entries.map((entry) => c.lythClusterStatus(entry.clusterId)));
  const clusters = entries.map((entry, index) => {
    const result = statuses[index];
    const status = result.status === "fulfilled" ? result.value : null;
    return {
      clusterId: entry.clusterId,
      size: entry.size,
      threshold: entry.threshold,
      active: entry.active,
      membersFilled: status ? status.members.length : null,
      openSeats: 0,
    };
  });
  return {
    endpoint,
    source: NODE_REGISTRY_SOURCE,
    status: "marketplace launching; no live on-chain seats yet",
    openSeatPrimitive: "not_live",
    totalOpenSeats: 0,
    clusters,
    notes: [
      "There is no on-chain open-seat / vacancy primitive yet. Cluster admission is mutual-consent formation (10-of-10) or the CJ-1 operator-request + 7-of-10 cluster vote, both coordinated off-chain.",
      "Live clusters are listed for context only; 'openSeats' is reported as 0 and is never fabricated from planning metadata.",
    ],
  };
}
