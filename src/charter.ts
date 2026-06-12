/**
 * charter.ts — service-reward / cluster-economics surface for the MCP.
 *
 * Thin, wallet-safe wrappers over @monolythium/core-sdk 0.4.x Component-H
 * (cluster charters, Law §6.8) and Component-A (per-cluster ServiceScore)
 * reads, plus the `updateCharter` draft builder.
 *
 * Reads use a fresh `RpcClient` bound to the caller-selected endpoint.
 * The draft builder is OFFLINE: it validates and encodes the charter wire
 * payload, derives the per-signer consent digest, and returns the
 * updateCharter selector — it never assembles a submittable calldata
 * (that needs the operators' ML-DSA signatures) and never broadcasts.
 */

import {
  RpcClient,
  decodeClusterCharter,
  encodeClusterCharter,
  updateCharterMessageHex,
  NODE_REGISTRY_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  NODE_REGISTRY_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  NODE_REGISTRY_FORM_CLUSTER_MEMBER_COUNT,
  NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD,
  NODE_REGISTRY_CHARTER_COOLDOWN_EPOCHS,
  NODE_REGISTRY_SELECTORS,
  nodeRegistryAddressHex,
  type ActiveCharterView,
  type PendingCharterView,
} from "@monolythium/core-sdk";

const NODE_REGISTRY_ADDRESS = nodeRegistryAddressHex();
const UPDATE_CHARTER_SELECTOR =
  (NODE_REGISTRY_SELECTORS as Record<string, string>).updateCharter;

function client(endpoint: string): RpcClient {
  return new RpcClient(endpoint);
}

function settled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === "fulfilled"
    ? result.value
    : { error: result.reason?.message ?? String(result.reason) };
}

function bps(value: number): { bps: number; percent: number } {
  return { bps: value, percent: Math.round((value / 100) * 100) / 100 };
}

/** Constants every charter surface is bound by (Law §6.8). */
export const CHARTER_RULES = {
  memberCount: NODE_REGISTRY_FORM_CLUSTER_MEMBER_COUNT,
  shareDenominatorBps: NODE_REGISTRY_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  delegatorFloorBps: NODE_REGISTRY_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  updateThreshold: NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD,
  cooldownEpochs: NODE_REGISTRY_CHARTER_COOLDOWN_EPOCHS,
} as const;

/**
 * Read a cluster's ACTIVE + PENDING economics charter (Law §6.8): the
 * per-operator member shares, the delegator share, and the pending
 * amendment's effective epoch. Both reads are settled independently so a
 * node that lacks one view (older binary / 3-arg-formCluster cluster)
 * still returns the other.
 */
export async function readClusterCharter(endpoint: string, clusterId: number) {
  const c = client(endpoint);
  const [active, pending] = await Promise.allSettled([
    c.lythGetClusterCharter(clusterId),
    c.lythGetPendingCharter(clusterId),
  ]);
  return {
    clusterId,
    endpoint,
    rules: CHARTER_RULES,
    active: shapeActive(settled(active)),
    pending: shapePending(settled(pending)),
    notes: [
      "Shares are in basis points; member shares are member-declaration order (active 0..7, then standby 7..10).",
      `An active charter requires Σ member = ${CHARTER_RULES.shareDenominatorBps} bps and delegator ≥ ${CHARTER_RULES.delegatorFloorBps} bps.`,
      "A cluster with no charter ('present: false') splits the pot under the genesis default; not an error.",
      "A pending amendment lands at 'effectiveEpoch' — the delegator-protective cooldown (Law §6.8).",
    ],
  };
}

function shapeActive(view: ActiveCharterView | { error: string }) {
  if ("error" in view) {
    return { present: false, unavailable: true, error: view.error };
  }
  if (!view.present) {
    return { present: false, note: "No active charter record; genesis-default split applies." };
  }
  return {
    present: true,
    delegatorShare: bps(view.delegatorShareBps),
    memberShares: view.memberShareBps.map((value, index) => ({
      memberIndex: index,
      ...bps(value),
    })),
  };
}

function shapePending(view: PendingCharterView | { error: string }) {
  if ("error" in view) {
    return { present: false, unavailable: true, error: view.error };
  }
  if (!view.present) {
    return { present: false, note: "No pending charter amendment posted." };
  }
  return {
    present: true,
    effectiveEpoch: view.effectiveEpoch.toString(),
    signerCount: view.signerCount,
    delegatorShare: bps(view.delegatorShareBps),
    memberShares: view.memberShareBps.map((value, index) => ({
      memberIndex: index,
      ...bps(value),
    })),
  };
}

/**
 * Build + validate an `updateCharter` DRAFT (Law §6.8) for a cluster.
 *
 * Validates Σ member = 10000 bps and delegator ≥ 2000 bps floor (the SDK
 * `encodeClusterCharter` is the SSOT — it enforces both client-side
 * before any nonce is burned), then returns the 30-byte charter wire
 * payload, the per-signer consent digest to sign, and the selector +
 * governance flow. Does NOT assemble submittable calldata (needs the
 * operators' ML-DSA-65 signatures) and does NOT broadcast.
 */
export function buildUpdateCharterDraft(args: {
  clusterId: number;
  memberShares: readonly number[];
  delegatorShareBps: number;
  expiresMs?: number;
}) {
  const { clusterId, memberShares, delegatorShareBps } = args;
  if (memberShares.length !== CHARTER_RULES.memberCount) {
    throw new Error(
      `memberShares must have exactly ${CHARTER_RULES.memberCount} entries (active 0..7, standby 7..10); got ${memberShares.length}`,
    );
  }
  const memberSum = memberShares.reduce((sum, value) => sum + value, 0);
  if (memberSum !== CHARTER_RULES.shareDenominatorBps) {
    throw new Error(
      `member shares must sum to ${CHARTER_RULES.shareDenominatorBps} bps (got ${memberSum})`,
    );
  }
  if (delegatorShareBps < CHARTER_RULES.delegatorFloorBps || delegatorShareBps > 10_000) {
    throw new Error(
      `delegatorShareBps must be in [${CHARTER_RULES.delegatorFloorBps}, 10000] (got ${delegatorShareBps})`,
    );
  }

  // 1h default consent window; the on-chain check is the expiry, not this default.
  const expiresMs = BigInt(args.expiresMs ?? Date.now() + 60 * 60 * 1000);

  // encodeClusterCharter re-runs the same structural validation as
  // mono-core's decode_cluster_charter — the SSOT guard.
  const charter = encodeClusterCharter({
    memberShareBps: memberShares,
    delegatorShareBps,
    expiresMs,
  });
  const charterHex = `0x${Buffer.from(charter).toString("hex")}`;
  const consentDigest = updateCharterMessageHex(clusterId, charter);

  return {
    clusterId,
    valid: true,
    rules: CHARTER_RULES,
    proposed: {
      delegatorShare: bps(delegatorShareBps),
      memberShares: memberShares.map((value, index) => ({ memberIndex: index, ...bps(value) })),
      consentExpiresMs: expiresMs.toString(),
    },
    charter: {
      bytes: charter.length,
      hex: charterHex,
      decoded: roundTrip(charter),
    },
    sign: {
      consentDigest,
      signersRequired: CHARTER_RULES.updateThreshold,
      scheme: "ML-DSA-65",
      domain: "..._CLUSTER_UPDATE_CHARTER_V1\\0",
      instruction: `Each consenting operator signs 'consentDigest' with its ML-DSA-65 consensus key; collect ≥ ${CHARTER_RULES.updateThreshold} signatures, then encode updateCharter calldata (signerPubkeys + signatures) and submit from a cluster operator.`,
    },
    submit: {
      target: NODE_REGISTRY_ADDRESS,
      selector: UPDATE_CHARTER_SELECTOR,
      cooldownEpochs: CHARTER_RULES.cooldownEpochs,
      note: "MCP does not assemble or broadcast updateCharter calldata; the signatures and a funded operator submission happen in the operator flow.",
    },
    governance: [
      `updateCharter is a ${CHARTER_RULES.updateThreshold}-of-cluster consent action; no single operator can move the split.`,
      `The amendment lands after a ${CHARTER_RULES.cooldownEpochs}-epoch delegator-protective cooldown.`,
      "Lowering the delegator share below the floor, or a member sum ≠ 10000, is rejected here before any submission.",
    ],
  };
}

function roundTrip(charter: Uint8Array) {
  const decoded = decodeClusterCharter(charter);
  return {
    memberShareBps: decoded.memberShareBps,
    delegatorShareBps: decoded.delegatorShareBps,
    expiresMs: decoded.expiresMs.toString(),
  };
}

/**
 * ServiceScore report — the "rewards = proved service" story (Component A,
 * Law §7). Returns the settled aggregate per-cluster ServiceScore (the u64
 * the reward path reads each block) plus the term reads that compose it:
 * the availability/base term (cluster status: live/threshold, reputation,
 * liveness) and the diversity term (asn/geo/hosting spread). The
 * archive/prover/rpc/indexer service terms are surfaced as the per-cluster
 * service-capability summary derived from cluster status.
 */
export async function clusterServiceScoreReport(endpoint: string, clusterId: number) {
  const c = client(endpoint);
  const [score, status, diversity] = await Promise.allSettled([
    c.lythGetClusterServiceScore(clusterId),
    c.lythClusterStatus(clusterId),
    c.lythGetClusterDiversity(clusterId),
  ]);

  const scoreValue = score.status === "fulfilled" ? score.value : null;
  const statusValue = status.status === "fulfilled" ? status.value : null;
  const diversityValue = diversity.status === "fulfilled" ? diversity.value : null;

  return {
    clusterId,
    endpoint,
    serviceScore: scoreValue !== null
      ? {
          value: scoreValue.toString(),
          scored: scoreValue > 0n,
          note: scoreValue > 0n
            ? "Settled aggregate ServiceScore (u64) the reward path reads each block."
            : "Cluster has never been scored (0).",
        }
      : { value: null, error: settled(score) },
    breakdown: {
      base: statusValue
        ? {
            term: "availability",
            size: statusValue.size,
            threshold: statusValue.threshold,
            live: statusValue.live,
            lagging: statusValue.lagging,
            offline: statusValue.offline,
            maintenance: statusValue.maintenance,
            quorum: statusValue.quorum,
            reputationScore: statusValue.reputationScore,
            livenessScore: statusValue.livenessScore,
            epoch: statusValue.epoch?.toString() ?? null,
            note: "Base/availability term: a cluster scores while it stays at/above its threshold and produces.",
          }
        : { term: "availability", error: settled(status) },
      diversity: diversityValue
        ? {
            term: "diversity",
            score: diversityValue.score,
            asnVariance: diversityValue.asnVariance,
            geoVariance: diversityValue.geoVariance,
            hostingSpread: diversityValue.hostingSpread,
            note: "Diversity term (0..10000): ASN/geo/hosting-class spread of the cluster roster.",
          }
        : { term: "diversity", error: settled(diversity) },
      services: {
        terms: ["archive", "prover", "rpc", "indexer"],
        note: "Per-service score terms (archive/prover/rpc/indexer) are folded into the aggregate ServiceScore on-chain; this node exposes the settled aggregate plus the base/diversity term reads above. Use operator-level capability reads for the per-operator service masks.",
      },
    },
    story: [
      "Rewards are proved service, not just stake: the per-cluster ServiceScore gates the cluster's slice of the reward pot.",
      "The charter (charter_read / update_charter_draft) then splits that slice across operators and delegators.",
      "A cluster that drops below threshold, loses diversity, or stops serving its declared capabilities earns a lower ServiceScore.",
    ],
  };
}

/** List the live clusters (id + headline health) for the optional-cluster path. */
export async function listLiveClusters(endpoint: string) {
  const c = client(endpoint);
  const directory = await c.lythClusterDirectory(0, 100);
  return directory.clusters.map((entry) => ({
    clusterId: entry.clusterId,
    size: entry.size,
    threshold: entry.threshold,
    aggregateHealth: entry.aggregateHealth,
    regionDiversity: entry.regionDiversity,
    active: entry.active,
  }));
}
