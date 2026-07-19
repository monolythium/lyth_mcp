import assert from "node:assert/strict";
import test from "node:test";

import { steleExecutionGate } from "../../dist/stele/execution-gate.js";
import {
  REQUIRED_CORE_SDK_VERSION,
  SteleNetworkIdentityGuard,
  SteleOperatorProbeError,
  sdkNetworkIdentity,
} from "../../dist/stele/network-identity.js";

const expected = sdkNetworkIdentity();

function metadata(overrides = {}) {
  return {
    product: "stele",
    stage: "data-auth",
    network: "testnet",
    chainId: expected.chainId,
    genesisHash: expected.genesisHash,
    walletAuthEnabled: true,
    oauthEnabled: true,
    providerDraftsEnabled: true,
    economicWritesEnabled: false,
    hostedSigningEnabled: false,
    ...overrides,
  };
}

function guard({ sdkVersion = REQUIRED_CORE_SDK_VERSION, operator = {}, meta = metadata() } = {}) {
  let metaReads = 0;
  const api = {
    async getMeta() {
      metaReads += 1;
      if (meta instanceof Error) throw meta;
      return meta;
    },
    async searchServices() {
      throw new Error("not used");
    },
  };
  const instance = new SteleNetworkIdentityGuard(api, {
    readSdkVersion: () => sdkVersion,
    probeTrustedOperator: async () => {
      if (operator instanceof Error) throw operator;
      return { chainId: expected.chainId, genesisHash: expected.genesisHash, ...operator };
    },
  });
  return { instance, metaReads: () => metaReads };
}

test("the SDK, trusted operator, and Stele metadata must all match", async () => {
  const { instance } = guard();
  const result = await instance.verify();
  assert.equal(result.ok, true);
  assert.deepEqual(result.identity, expected);
  assert.deepEqual(result.operator, { verified: true });
  assert.equal(result.meta.providerDraftsEnabled, true);
});

test("each SDK/operator/meta identity mismatch fails closed", async (t) => {
  const cases = [
    ["SDK version", { sdkVersion: "0.6.7" }, "sdk_version_mismatch"],
    ["operator chain", { operator: { chainId: "69421" } }, "operator_wrong_chain"],
    [
      "operator same-chain re-genesis",
      { operator: { genesisHash: `0x${"11".repeat(32)}` } },
      "operator_regenesis",
    ],
    ["operator missing genesis", { operator: { genesisHash: undefined } }, "operator_identity_invalid"],
    ["metadata chain", { meta: metadata({ chainId: "69421" }) }, "meta_wrong_chain"],
    [
      "metadata same-chain re-genesis",
      { meta: metadata({ genesisHash: `0x${"22".repeat(32)}` }) },
      "meta_regenesis",
    ],
    [
      "metadata network label mismatch",
      { meta: metadata({ network: "mainnet" }) },
      "meta_wrong_network",
    ],
    [
      "metadata missing genesis",
      { meta: Object.fromEntries(Object.entries(metadata()).filter(([key]) => key !== "genesisHash")) },
      "meta_identity_invalid",
    ],
    [
      "metadata missing provider drafts flag",
      { meta: Object.fromEntries(Object.entries(metadata()).filter(([key]) => key !== "providerDraftsEnabled")) },
      "meta_identity_invalid",
    ],
    [
      "metadata malformed provider drafts flag",
      { meta: metadata({ providerDraftsEnabled: "true" }) },
      "meta_identity_invalid",
    ],
    [
      "metadata unknown security flag",
      { meta: metadata({ providerDraftSigningEnabled: true }) },
      "meta_identity_invalid",
    ],
    ["metadata unavailable", { meta: new Error("token=super-secret") }, "meta_unavailable"],
  ];

  for (const [label, configuration, reason] of cases) {
    await t.test(label, async () => {
      const { instance } = guard(configuration);
      const result = await instance.verify();
      assert.deepEqual(
        { ok: result.ok, code: result.code, reason: result.reason },
        { ok: false, code: "network_identity_mismatch", reason },
      );
      assert.equal(JSON.stringify(result).includes("super-secret"), false);
    });
  }
});

test("quarantine, untrusted, and unreachable operator states stay classified and skip metadata", async () => {
  for (const [probeReason, resultReason] of [
    ["quarantined", "operator_quarantined"],
    ["untrusted", "operator_untrusted"],
    ["unreachable", "operator_unreachable"],
  ]) {
    const state = guard({ operator: new SteleOperatorProbeError(probeReason) });
    const result = await state.instance.verify();
    assert.equal(result.reason, resultReason);
    assert.equal(state.metaReads(), 0);
  }
});

test("a fully green identity still cannot enable execution or touch signing hooks", async () => {
  let unlockCalls = 0;
  let signCalls = 0;
  let submitCalls = 0;
  const forbiddenHooks = {
    unlock: () => (unlockCalls += 1),
    sign: () => (signCalls += 1),
    submit: () => (submitCalls += 1),
  };

  assert.equal((await guard().instance.verify()).ok, true);
  assert.deepEqual(steleExecutionGate(), {
    ok: false,
    code: "capability_unavailable",
    signing: "disabled",
    submission: "disabled",
    reason: "core_sdk_execution_contracts_unavailable",
  });
  assert.equal(steleExecutionGate.length, 0);
  assert.deepEqual({ unlockCalls, signCalls, submitCalls }, { unlockCalls: 0, signCalls: 0, submitCalls: 0 });
  assert.deepEqual(Object.keys(forbiddenHooks).sort(), ["sign", "submit", "unlock"]);
});
