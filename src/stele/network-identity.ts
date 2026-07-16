import {
  OperatorTrustError,
  TESTNET_69420,
  selectTrustedOperatorForNetwork,
  version as coreSdkVersion,
  type OperatorTrustReason,
} from "@monolythium/core-sdk";
import { SteleMetaSchema, type SteleApiReader, type SteleMeta } from "./api-client.js";
import {
  SteleOperatorFetchBoundary,
  type SteleOperatorFetchBoundaryOptions,
} from "./operator-fetch.js";

export const REQUIRED_CORE_SDK_VERSION = "0.6.8";
export const REQUIRED_STELE_META_NETWORK = "testnet";

const HASH_32 = /^0x[0-9a-f]{64}$/u;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/u;

export interface SteleNetworkIdentity {
  readonly network: string;
  readonly chainId: string;
  readonly genesisHash: string;
  readonly sdkVersion: string;
}

export interface SteleOperatorIdentity {
  readonly chainId: string;
  readonly genesisHash: string;
}

export type SteleNetworkIdentityFailureReason =
  | "sdk_version_mismatch"
  | "operator_unreachable"
  | "operator_quarantined"
  | "operator_untrusted"
  | "operator_wrong_chain"
  | "operator_regenesis"
  | "operator_identity_invalid"
  | "meta_unavailable"
  | "meta_identity_invalid"
  | "meta_wrong_network"
  | "meta_wrong_chain"
  | "meta_regenesis";

export interface SteleNetworkIdentitySuccess {
  readonly ok: true;
  readonly code: "identity_verified";
  readonly identity: SteleNetworkIdentity;
  readonly operator: { readonly verified: true };
  readonly meta: {
    readonly stage: string;
    readonly network: string;
    readonly walletAuthEnabled: boolean;
    readonly oauthEnabled: boolean;
    readonly economicWritesEnabled: boolean;
    readonly hostedSigningEnabled: false;
  };
}

export interface SteleNetworkIdentityFailure {
  readonly ok: false;
  readonly code: "network_identity_mismatch";
  readonly reason: SteleNetworkIdentityFailureReason;
  readonly expected: SteleNetworkIdentity;
}

export type SteleNetworkIdentityResult =
  | SteleNetworkIdentitySuccess
  | SteleNetworkIdentityFailure;

export interface SteleNetworkIdentityDependencies {
  readonly readSdkVersion?: () => string;
  readonly probeTrustedOperator?: (
    expected: SteleNetworkIdentity,
  ) => Promise<SteleOperatorIdentity>;
}

export class SteleOperatorProbeError extends Error {
  override readonly name = "SteleOperatorProbeError";

  constructor(readonly reason: OperatorTrustReason | "identity-invalid") {
    super("trusted operator probe failed");
  }
}

export class SteleNetworkIdentityGuard {
  readonly #api: SteleApiReader;
  readonly #readSdkVersion: () => string;
  readonly #probeTrustedOperator: (
    expected: SteleNetworkIdentity,
  ) => Promise<SteleOperatorIdentity>;

  constructor(api: SteleApiReader, dependencies: SteleNetworkIdentityDependencies = {}) {
    this.#api = api;
    this.#readSdkVersion = dependencies.readSdkVersion ?? (() => coreSdkVersion);
    this.#probeTrustedOperator = dependencies.probeTrustedOperator ?? probeTrustedOperator;
  }

  async verify(): Promise<SteleNetworkIdentityResult> {
    const expected = sdkNetworkIdentity();
    if (this.#readSdkVersion() !== REQUIRED_CORE_SDK_VERSION) {
      return failure(expected, "sdk_version_mismatch");
    }

    let operator: unknown;
    try {
      operator = await this.#probeTrustedOperator(expected);
    } catch (error) {
      return failure(expected, operatorFailureReason(error));
    }

    if (!isCanonicalIdentity(operator)) {
      return failure(expected, "operator_identity_invalid");
    }
    if (operator.chainId !== expected.chainId) {
      return failure(expected, "operator_wrong_chain");
    }
    if (operator.genesisHash !== expected.genesisHash) {
      return failure(expected, "operator_regenesis");
    }

    let meta: SteleMeta;
    try {
      const parsed = SteleMetaSchema.safeParse(await this.#api.getMeta());
      if (!parsed.success) return failure(expected, "meta_identity_invalid");
      meta = parsed.data;
    } catch {
      return failure(expected, "meta_unavailable");
    }

    if (meta.chainId !== expected.chainId) {
      return failure(expected, "meta_wrong_chain");
    }
    if (meta.network !== REQUIRED_STELE_META_NETWORK) {
      return failure(expected, "meta_wrong_network");
    }
    if (meta.genesisHash !== expected.genesisHash) {
      return failure(expected, "meta_regenesis");
    }

    return {
      ok: true,
      code: "identity_verified",
      identity: expected,
      operator: { verified: true },
      meta: {
        stage: meta.stage,
        network: meta.network,
        walletAuthEnabled: meta.walletAuthEnabled,
        oauthEnabled: meta.oauthEnabled,
        economicWritesEnabled: meta.economicWritesEnabled,
        hostedSigningEnabled: meta.hostedSigningEnabled,
      },
    };
  }
}

export function sdkNetworkIdentity(): SteleNetworkIdentity {
  return {
    network: TESTNET_69420.network,
    chainId: String(TESTNET_69420.chain_id),
    genesisHash: TESTNET_69420.genesis_hash.toLowerCase(),
    sdkVersion: REQUIRED_CORE_SDK_VERSION,
  };
}

export async function probeTrustedOperator(
  expected: SteleNetworkIdentity,
  options: SteleOperatorFetchBoundaryOptions = {},
): Promise<SteleOperatorIdentity> {
  const boundary = new SteleOperatorFetchBoundary(options);
  try {
    const client = await selectTrustedOperatorForNetwork(expected.network, {
      fetch: boundary.fetch,
    });
    if (!boundary.isAllowedEndpoint(client.endpoint)) {
      throw new SteleOperatorProbeError("identity-invalid");
    }

    // The pinned SDK selector has just verified both values for this exact
    // allowlisted endpoint. Re-probing the winner would widen the deadline and
    // create a second, non-atomic identity observation without adding trust.
    return { chainId: expected.chainId, genesisHash: expected.genesisHash };
  } catch (error) {
    if (error instanceof SteleOperatorProbeError) throw error;
    if (error instanceof OperatorTrustError) throw new SteleOperatorProbeError(error.reason);
    throw new SteleOperatorProbeError("unreachable");
  } finally {
    // Promise.any returns before losing SDK probes settle. Abort them all as
    // soon as a winner is known (or the overall discovery deadline expires).
    boundary.close();
  }
}

function isCanonicalIdentity(identity: unknown): identity is SteleOperatorIdentity {
  return (
    typeof identity === "object" &&
    identity !== null &&
    "chainId" in identity &&
    typeof identity.chainId === "string" &&
    CANONICAL_UINT.test(identity.chainId) &&
    "genesisHash" in identity &&
    typeof identity.genesisHash === "string" &&
    HASH_32.test(identity.genesisHash)
  );
}

function operatorFailureReason(error: unknown): SteleNetworkIdentityFailureReason {
  const reason = error instanceof SteleOperatorProbeError ? error.reason : "unreachable";
  switch (reason) {
    case "quarantined":
      return "operator_quarantined";
    case "wrong-chain":
      return "operator_wrong_chain";
    case "regenesis":
      return "operator_regenesis";
    case "untrusted":
      return "operator_untrusted";
    case "identity-invalid":
      return "operator_identity_invalid";
    default:
      return "operator_unreachable";
  }
}

function failure(
  expected: SteleNetworkIdentity,
  reason: SteleNetworkIdentityFailureReason,
): SteleNetworkIdentityFailure {
  return {
    ok: false,
    code: "network_identity_mismatch",
    reason,
    expected,
  };
}
