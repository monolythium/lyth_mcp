import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "lyth-mcp-smoke-"));
process.env.LYTH_MCP_CONNECTOR_STORE = join(temp, "connectors.json");
process.env.LYTH_MCP_CONNECTOR_KEY = join(temp, "connector.key");
process.env.LYTH_MCP_MERCHANT_POLICY_STORE = join(temp, "merchant_policies.json");
process.env.LYTH_MCP_BOOKING_STORE = join(temp, "bookings.json");
process.env.LYTH_MCP_ORDER_STORE = join(temp, "orders.json");
process.env.LYTH_MCP_INVOICE_STORE = join(temp, "invoices.json");

const connectors = await import("../dist/connectors.js");
const merchant = await import("../dist/merchant_policy.js");
const bookings = await import("../dist/bookings.js");
const orders = await import("../dist/orders.js");
const invoices = await import("../dist/invoices.js");
const bridges = await import("../dist/bridges.js");
const assets = await import("../dist/assets.js");
const runbooks = await import("../dist/runbooks.js");
const commerceSafety = await import("../dist/commerce_safety.js");
const riskRenderer = await import("../dist/risk_renderer.js");
const errorExplain = await import("../dist/error_explain.js");
const clusters = await import("../dist/clusters.js");
const delegation = await import("../dist/delegation.js");
const nodes = await import("../dist/nodes.js");
const walletSafety = await import("../dist/wallet_safety.js");
const security = await import("../dist/security.js");
const readiness = await import("../dist/readiness.js");
const demoConnectors = await import("../dist/demo_connectors.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const connector = await connectors.upsertConnector({
  id: "pizza-demo-webhook",
  vendorId: "pizza-demo",
  endpoint: "https://vendor.example/orders",
  authMode: "hmac_sha256",
  secret: "test-secret",
});
const listedConnectors = await connectors.listConnectors({ vendorId: "pizza-demo" });
const headers = await connectors.buildConnectorHeaders(connector, JSON.stringify({ test: true }));
assert(listedConnectors.length === 1, "expected connector list to include one connector");
assert(listedConnectors[0].auth.secretConfigured === true, "expected connector secret to be redacted but configured");
assert(typeof headers["X-Lyth-Signature"] === "string", "expected hmac signature header");

const vendor = { id: "pizza-demo", displayName: "Pizza Demo", category: "food", fulfillment: { type: "demo" } };
await merchant.upsertMerchantPolicy({
  vendorId: "pizza-demo",
  allowlisted: true,
  maxOrderAmount: "15",
  allowedAssets: ["LYTH"],
  allowedCategories: ["food"],
});
const policy = await merchant.getMerchantPolicy("pizza-demo");
const allowedRisk = merchant.evaluateMerchantPolicy({ vendor, policy, amount: "12", asset: "LYTH" });
const blockedRisk = merchant.evaluateMerchantPolicy({ vendor, policy, amount: "20", asset: "LYTH" });
assert(allowedRisk.ok === true, "expected merchant policy to allow 12 LYTH");
assert(blockedRisk.ok === false, "expected merchant policy to block 20 LYTH");

const order = await orders.createOrder({
  network: "testnet-69420",
  chainId: 69420,
  vendorId: "pizza-demo",
  vendorDisplayName: "Pizza Demo",
  vendorAddress: "0x1111111111111111111111111111111111111111",
  itemName: "Margherita",
  quantity: 1,
  amount: "9",
  asset: "LYTH",
  registryHash: "sha256:test",
  quote: {},
});
await orders.updateOrder(order.id, {
  status: "fulfillment_requested",
  fulfillment: {
    adapter: "webhook",
    confirmation: "accepted",
    requestedAt: new Date().toISOString(),
    connectorId: connector.id,
    responseStatus: 202,
    responseHash: "sha256:test",
  },
}, { type: "fulfillment_webhook_sent" });
assert((await orders.getOrder(order.id)).status === "fulfillment_requested", "expected order webhook status");

const booking = await bookings.createBooking({
  network: "testnet-69420",
  chainId: 69420,
  vendorId: "pizza-demo",
  service: "Pizza delivery",
  amount: "9",
  asset: "LYTH",
  registryHash: "sha256:test",
});
await bookings.updateBooking(booking.id, { status: "provider_requested" }, { type: "booking_webhook_sent" });
assert((await bookings.getBooking(booking.id)).status === "provider_requested", "expected booking provider request status");

const invoice = await invoices.createInvoice({
  type: "funding_request",
  network: "testnet-69420",
  chainId: 69420,
  recipient: "0x1111111111111111111111111111111111111111",
  amount: "10",
  asset: "LYTH",
  purpose: "Smoke test funding",
});
await invoices.updateInvoice(invoice.id, { status: "paid", txHash: "0xabc" }, "paid", { txHash: "0xabc" });
assert((await invoices.getInvoice(invoice.id)).status === "paid", "expected paid invoice");

const bridgeRegistry = await bridges.loadBridgeRegistry("./bridge_routes.example.json");
const bridgeRoute = bridges.selectBridgeRoute(bridgeRegistry.registry, {
  asset: "USDC",
  sourceChain: "Ethereum",
  destinationChain: "Monolythium",
});
assert(bridgeRoute?.id === "eth-usdc-to-mono-zk", "expected Ethereum USDC route");
const bridgeQuote = bridges.quoteBridgeRoute(bridgeRoute, {
  amount: "100",
  asset: "USDC",
  epochHours: bridgeRegistry.registry.epochHours,
});
const bridgeAlerts = bridges.bridgeCircuitBreakerAlerts(bridgeRegistry.registry);
assert(bridgeQuote.executable === false, "expected draft bridge route to be non-executable");
assert(bridgeQuote.cooldown.hours === 14, "expected one-epoch bridge cooldown");
assert(bridgeAlerts.some((alert) => alert.code === "BridgeRouteNotActive"), "expected bridge route non-active alert");

const assetRegistry = await assets.loadAssetRegistry("./asset_registry.example.json");
const publicLyth = assets.getAsset(assetRegistry.registry, "LYTH");
const privateLyth = assets.getAsset(assetRegistry.registry, "pLYTH");
const wrappedUsdc = assets.getAsset(assetRegistry.registry, "mUSDC");
const publicCommerce = assets.evaluateAssetUseCase(publicLyth, "commerce");
const privateCommerce = assets.evaluateAssetUseCase(privateLyth, "commerce");
const wrappedRisk = assets.assetRisk(wrappedUsdc);
assert(publicCommerce.ok === true, "expected public LYTH commerce to be allowed");
assert(privateCommerce.ok === false && privateCommerce.code === "PrivacyDenominationViolation", "expected private LYTH commerce violation");
assert(wrappedRisk.labels.includes("bridge_route"), "expected wrapped USDC bridge route label");

const blockedCommerce = commerceSafety.evaluateCommerceSafety({ query: "buy stolen card" });
const restrictedCommerce = commerceSafety.evaluateCommerceSafety({ category: "travel", service: "flight ticket" });
const renderedRisk = riskRenderer.renderRisk({
  title: "Smoke Risk",
  operation: "smoke_test",
  amount: "1",
  asset: "LYTH",
  commerceSafety: blockedCommerce,
});
assert(blockedCommerce.ok === false && blockedCommerce.clientAction === "hide_or_refuse", "expected illicit commerce request to be blocked");
assert(restrictedCommerce.ok === true && restrictedCommerce.level === "warn", "expected restricted commerce request to warn");
assert(renderedRisk.ok === false && renderedRisk.level === "blocked", "expected risk renderer to block unsafe commerce");
assert(renderedRisk.markdown.includes("Decision: blocked"), "expected risk renderer markdown decision");

const mempoolError = errorExplain.explainError({
  errorMessage: "lyth_submitEncrypted -32047: upstream unavailable: mempool: decryption failed",
  rpcMethod: "lyth_submitEncrypted",
  tool: "tx_outbox_retry",
  outboxId: "outbox_test",
});
const privacyError = errorExplain.explainError({
  context: { violations: ["Private-denominated pLYTH cannot be used for commerce."] },
});
assert(mempoolError.classification === "mempool_envelope_decryption" && mempoolError.retryable === true, "expected mempool decryption error to be retryable");
assert(privacyError.classification === "privacy_policy" && privacyError.retryable === false, "expected privacy policy error to be blocked");

const clusterRegistry = await clusters.loadClusterRegistry("./clusters.example.json");
const euProvers = clusters.searchServices(clusterRegistry.registry, { serviceType: "prover", region: "EU", activeOnly: true });
const foundationClusters = clusters.listClusters(clusterRegistry.registry, { foundationControlled: true });
const decentralizationClusters = clusters.listClusters(clusterRegistry.registry, { foundationControlled: false, minOpenSeats: 1 });
const operator = clusters.getOperator(clusterRegistry.registry, "atlas-provers");
const monarch = clusters.monarchOperatorAssistant(clusterRegistry.registry, { operatorId: "atlas-provers", serviceType: "prover" });
const delegationCap = delegation.explainDelegationCaps({
  phase: "growth",
  totalDelegatedStake: "1000",
  currentClusterStake: "140",
  intendedAdditionalStake: "40",
  selectedClusterCount: 5,
  overCapEpochs: 3,
});
const stakeStatus = delegation.stakeStatus(clusterRegistry.registry, {
  phase: "growth",
  positions: [
    { clusterId: "mono-eu-1", amount: "180" },
    { clusterId: "mono-nl-community-1", amount: "300" },
    { clusterId: "mono-us-west-1", amount: "120" },
  ],
});
const delegateDraft = delegation.delegateDraft(clusterRegistry.registry, {
  clusterId: "mono-nl-community-1",
  amount: "50",
  mode: "max_decentralization",
  positions: stakeStatus.positions.map((entry) => entry.position),
});
const rebalanceDraft = delegation.rebalanceDraft(clusterRegistry.registry, {
  mode: "max_decentralization",
  positions: stakeStatus.positions.map((entry) => entry.position),
  targetClusterCount: 3,
});
const undelegateDraft = delegation.undelegateDraft(clusterRegistry.registry, {
  clusterId: "mono-eu-1",
  amount: "40",
  positions: stakeStatus.positions.map((entry) => entry.position),
});
const autovote = delegation.autovoteSimulate(clusterRegistry.registry, {
  mode: "max_decentralization",
  positions: stakeStatus.positions.map((entry) => entry.position),
  candidateLimit: 3,
});
const nodeRegistry = await nodes.loadNodeRegistry("./nodes.example.json");
const proverNode = nodes.getNode(nodeRegistry.registry, "nl1-prover-01");
const rpcNode = nodes.getNode(nodeRegistry.registry, "nl1-rpc-01");
const attestation = nodes.nodeAttestation(proverNode);
const rpcAttestation = nodes.nodeAttestation(rpcNode);
const pcr = nodes.explainPcr(rpcNode, "7");
const diversity = nodes.nodeDiversityScore(nodeRegistry.registry, { clusterId: "mono-nl-community-1" });
const hosting = nodes.nodeHostingClass(proverNode);
assert(euProvers.some((entry) => entry.clusterId === "mono-nl-community-1"), "expected EU prover service search to include NL community cluster");
assert(foundationClusters.some((cluster) => cluster.id === "mono-eu-1"), "expected foundation cluster flag search");
assert(decentralizationClusters[0].id === "mono-nl-community-1", "expected NL community cluster to lead decentralization candidates");
assert(clusters.operatorStatus(clusterRegistry.registry, operator).openSeats > 0, "expected atlas-provers to have open-seat exposure");
assert(monarch.clusters.some((entry) => entry.quorum.configured === "7-of-10"), "expected monarch assistant quorum explanation");
assert(monarch.guardrails.some((entry) => entry.includes("node/operator")), "expected monarch assistant node-ops guardrail");
assert(delegationCap.taper.overCap === true && delegationCap.taper.rewardTaperPercent > 0, "expected delegation cap taper for over-cap cluster");
assert(delegationCap.diversification.ok === false, "expected delegation diversification warning");
assert(stakeStatus.totalDelegatedStake === "600", "expected local stake status total");
assert(delegateDraft.operation === "delegate" && delegateDraft.unsigned === true, "expected unsigned delegate draft");
assert(rebalanceDraft.operations.length === 3, "expected rebalance target operations");
assert(undelegateDraft.operation === "undelegate", "expected undelegate draft");
assert(autovote.rankedCandidates.length === 3, "expected autovote candidate ranking");
assert(attestation.ok === true && attestation.status === "verified", "expected prover node attestation to verify against local profile");
assert(rpcAttestation.ok === false && rpcAttestation.mismatches.some((item) => item.pcr === "7"), "expected RPC node PCR mismatch");
assert(pcr.entries[0].meaning.includes("Secure Boot"), "expected PCR 7 explanation");
assert(diversity.score > 50, "expected NL cluster node diversity score");
assert(hosting.risk === "low", "expected community baremetal hosting to be low risk");

const runbookList = await runbooks.listCanonicalRunbooks("./runbooks");
assert(runbookList.length >= 9, "expected bundled canonical runbooks");

const walletFixture = {
  name: "pizza-agent",
  address: "0x71550000000000000000000000000000000029bd",
  publicKey: "0xabc",
  algorithm: "PQM1-MLDSA65",
  keyProtection: "local_machine_key",
  createdAt: new Date().toISOString(),
  lowValue: {
    enabled: true,
    asset: "LYTH",
    maxAmount: "10",
    dailyLimit: "50",
    accounting: {
      remainingToday: "48",
      reserved: "0.2",
      submitted: "0",
    },
    configuredAt: new Date().toISOString(),
  },
  agent: {
    purpose: "Small food-ordering demos on testnet",
    network: "testnet-69420",
    allowedCategories: ["food"],
    fallbackApproval: "wallet_handoff",
    paused: false,
    updatedAt: new Date().toISOString(),
  },
};
const safetyProfile = walletSafety.accountSafetyProfiles({
  wallets: [walletFixture],
  outboxEntries: [],
  receipts: [],
});
const allowedHotSpend = walletSafety.simulateHotWalletPolicy({
  wallet: walletFixture,
  amount: "5",
  category: "food",
});
const blockedHotSpend = walletSafety.simulateHotWalletPolicy({
  wallet: walletFixture,
  amount: "12",
  category: "food",
});
const threshold = walletSafety.explainWalletThresholds({
  amount: "5",
  lowValueCap: "10",
  passkeyCap: "100",
  walletHasLowValuePolicy: true,
});
assert(safetyProfile.highestRisk === "medium", "expected local hot wallet profile to be medium risk");
assert(allowedHotSpend.ok === true, "expected hot-wallet policy to allow 5 LYTH food spend");
assert(blockedHotSpend.ok === false, "expected hot-wallet policy to block amount above cap");
assert(threshold.selectedTier === "agent_hot_wallet", "expected threshold explanation to select agent hot wallet");

const securityContext = {
  network: "testnet-69420",
  chainId: 69420,
  submitEnabled: false,
  rpcHealth: {
    selectedRead: "http://127.0.0.1:8545",
    selectedWrite: null,
    endpoints: [{ endpoint: "http://127.0.0.1:8545", ok: true, score: 60, writeReady: false }],
  },
  bridgeRegistry: bridgeRegistry.registry,
  clusterRegistry: clusterRegistry.registry,
  nodeRegistry: nodeRegistry.registry,
  wallets: [walletFixture],
  outboxEntries: [],
  receipts: [],
  runbookCount: runbookList.length,
};
const securityDashboard = security.securityStatus(securityContext);
const emergencyWatch = security.emergencyStateWatch(securityContext);
const blastRadius = security.bridgeBlastRadiusMonitor(securityContext);
const recovery = security.recoveryStatus(securityContext, "pizza-agent");
const recoveryDraft = security.recoveryRunbookDraft({ kind: "pause_agent", walletName: "pizza-agent" });
const auditGates = security.auditResearchGateDashboard(securityContext);
assert(securityDashboard.components.some((component) => component.id === "mempool_rpc"), "expected mempool security component");
assert(emergencyWatch.events.some((event) => event.code === "BridgeRoutePaused"), "expected emergency bridge pause event");
assert(blastRadius.severity === "critical", "expected critical bridge blast radius from paused trusted route");
assert(recovery.wallets[0].availableRunbooks.length >= 4, "expected recovery runbooks");
assert(recoveryDraft.requiredTool === "agent_wallet_pause", "expected pause recovery runbook draft");
assert(auditGates.gates.some((gate) => gate.id === "riscv_vm"), "expected RISC-V audit gate");

const readinessDashboard = readiness.readinessCheck({
  toolNames: [
    "contract_path_guidance",
    "asset_registry_info",
    "asset_search",
    "asset_risk_label",
    "vendor_search",
    "order_create",
    "booking_request_create",
    "funding_request_create",
    "provider_onboarding_draft",
    "bridge_routes",
    "bridge_quote",
    "bridge_circuit_breaker_watch",
    "liquidity_onboarding",
    "agent_wallet_create",
    "wallet_preflight_transfer",
    "wallet_build_transfer",
    "wallet_safety_profile",
    "hot_wallet_policy_simulate",
    "runbook_list",
    "runbook_get",
    "validate_runbook",
    "prepare_wallet_request",
    "security_status",
    "emergency_state_watch",
    "bridge_blast_radius",
    "recovery_status",
  ],
  runbookCount: runbookList.length,
  vendorCount: 5,
  bridgeRouteCount: bridgeRegistry.registry.routes.length,
  activeBridgeRouteCount: bridgeRegistry.registry.routes.filter((route) => route.status === "active").length,
  assetCount: assetRegistry.registry.assets.length,
  walletCount: 1,
  docsUpdated: true,
  testsUpdated: true,
});
assert(readinessDashboard.gates.length === 10, "expected all readiness gates");
const externalGate = readinessDashboard.gates.find((g) => g.id === "external_commerce");
assert(externalGate, "external_commerce readiness gate must be present");
assert(readiness.readinessCheck({
  toolNames: [],
  runbookCount: 0,
  vendorCount: 0,
  bridgeRouteCount: 0,
  activeBridgeRouteCount: 0,
  assetCount: 0,
  walletCount: 0,
}, "bridge").gates[0].id === "bridge", "expected bridge readiness gate filter");

const connectorTemplates = demoConnectors.listDemoConnectorTemplates();
const coinsbeeTemplate = demoConnectors.getDemoConnectorTemplate("coinsbee-giftcards-demo");
const foodDraft = demoConnectors.demoConnectorDraft({ templateId: "food-delivery-demo", vendorId: "pizza-demo" });
assert(connectorTemplates.length >= 7, "expected demo connector templates");
assert(coinsbeeTemplate.status === "todo_demo_stub", "expected Coinsbee template to be marked TODO/demo");
assert(foodDraft.connectorSetDraft.enabled === false, "expected demo connector draft to be disabled by default");

const failureCases = JSON.parse(await readFile(new URL("../fixtures/failure_cases.json", import.meta.url), "utf8"));
for (const failureCase of failureCases) {
  const explained = errorExplain.explainError(failureCase.input);
  assert(explained.classification === failureCase.expected.classification, `expected failure classification for ${failureCase.name}`);
  assert(explained.retryable === failureCase.expected.retryable, `expected retryable flag for ${failureCase.name}`);
}

const mockRpc = await startMockRpc();
try {
  const failedSubmit = await mockRpc.call("lyth_submitEncrypted", ["0xdeadbeef"]);
  assert(failedSubmit.error?.code === -32047, "expected mocked encrypted submit failure");
  const explained = errorExplain.explainError({
    errorMessage: `${failedSubmit.error.message}`,
    code: failedSubmit.error.code,
    rpcMethod: "lyth_submitEncrypted",
  });
  assert(explained.classification === "mempool_envelope_decryption", "expected mocked RPC failure to classify as mempool decryption");
} finally {
  await mockRpc.close();
}

// ---------------------------------------------------------------------------
// P14 — EVM hot wallet, ERC-20 builders, x402 client, NOWPayments IPN.
// ---------------------------------------------------------------------------
process.env.LYTH_MCP_EVM_WALLET_STORE = join(temp, "evm_wallets.json");
process.env.LYTH_MCP_EVM_HOT_KEY = join(temp, "evm_hot.key");
process.env.LYTH_MCP_EVM_LOCAL_KEY = join(temp, "evm_local.key");
process.env.LYTH_MCP_X402_STORE = join(temp, "x402_policies.json");
process.env.LYTH_MCP_NOWPAYMENTS_CONFIG = join(temp, "nowpayments.json");
process.env.LYTH_MCP_NOWPAYMENTS_KEY = join(temp, "nowpayments.key");

const evmWallet = await import("../dist/evm_wallet.js");
const evmTx = await import("../dist/evm_tx.js");
const x402 = await import("../dist/x402.js");
const x402Store = await import("../dist/x402_store.js");
const nowpayments = await import("../dist/nowpayments.js");
const crypto = await import("node:crypto");

// EVM wallet: create + cap check + delete
const evmCreated = await evmWallet.createEvmWallet({
  name: "smoke-evm",
  allowLocalKey: true,
  allowedChainIds: [8453],
  allowedAssets: ["USDC"],
  agent: { purpose: "smoke", paused: false },
  lowValue: { enabled: true, caps: [{ chainId: 8453, asset: "USDC", maxPerTx: "25", dailyLimit: "50" }] },
});
assert(/^0x[0-9a-fA-F]{40}$/.test(evmCreated.address), "evm wallet must produce a checksummed address");
const decisionOk = evmWallet.checkEvmCap(evmCreated.lowValue, 8453, "USDC", "10");
assert(decisionOk.ok, "10 USDC must pass 25 USDC per-tx cap");
const decisionFail = evmWallet.checkEvmCap(evmCreated.lowValue, 8453, "USDC", "60");
assert(!decisionFail.ok && /per-tx cap/.test(decisionFail.reason), "60 USDC must fail per-tx cap");

// ERC-20 calldata encoding
const calldata = evmTx.encodeErc20Transfer("0x000000000000000000000000000000000000dEaD", 1_000_000n);
assert(calldata.startsWith("0xa9059cbb"), "ERC-20 transfer selector must be 0xa9059cbb");
assert(calldata.length === 138, "ERC-20 transfer calldata must be 138 hex chars");

// EIP-1559 sign + EIP-712 sign sanity (no RPC required)
const privBytes = evmWallet.hexToBytes("4646464646464646464646464646464646464646464646464646464646464646");
const signedTx = evmTx.signEip1559(
  { chainId: 1, nonce: 0n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 20_000_000_000n, gasLimit: 21000n, to: "0x3535353535353535353535353535353535353535", value: 1_000_000_000_000_000_000n, data: "0x" },
  privBytes,
);
assert(signedTx.rawTxHex.startsWith("0x02"), "EIP-1559 envelope must start with 0x02");
assert(signedTx.from === "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F", "EIP-1559 sign must recover the known address");

// x402 end-to-end against a mock server (success + failure paths)
const x402Server = createServer((req, res) => {
  const xp = req.headers["x-payment"];
  if (!xp) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({
      x402Version: 1,
      error: "payment required",
      accepts: [{
        scheme: "exact",
        network: "base",
        maxAmountRequired: "100000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x000000000000000000000000000000000000bEEF",
        resource: "http://localhost/test",
        description: "smoke",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      }],
    }));
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "base", payer: "smoke" })).toString("base64"),
  });
  res.end(JSON.stringify({ data: "premium" }));
});
await new Promise((r) => x402Server.listen(0, "127.0.0.1", r));
const x402Port = x402Server.address().port;
try {
  const policy = {
    vendorId: "smoke-vendor",
    walletName: "smoke-evm",
    originAllowlist: [`http://127.0.0.1:${x402Port}`],
    allowedAssets: ["USDC"],
    maxPaymentPerRequest: { "8453:USDC": "200000" },
  };
  const ok = await x402.x402Pay({ url: `http://127.0.0.1:${x402Port}/`, wallet: await evmWallet.getEvmWallet("smoke-evm"), policy });
  assert(ok.ok && ok.status === 200 && ok.retried, "x402 success path must retry and return 200");
  assert(ok.settlement?.success === true, "x402 settlement header must decode");
  // Origin not in allowlist → fail closed
  const badPolicy = { ...policy, originAllowlist: ["http://other.example.com"] };
  const bad = await x402.x402Pay({ url: `http://127.0.0.1:${x402Port}/`, wallet: await evmWallet.getEvmWallet("smoke-evm"), policy: badPolicy });
  assert(!bad.ok && /allowlist/.test(bad.error ?? ""), "x402 must fail closed when origin not in allowlist");
  // Cap exceeded → fail closed
  const cappedPolicy = { ...policy, maxPaymentPerRequest: { "8453:USDC": "1" } };
  const capped = await x402.x402Pay({ url: `http://127.0.0.1:${x402Port}/`, wallet: await evmWallet.getEvmWallet("smoke-evm"), policy: cappedPolicy });
  assert(!capped.ok && /exceeds vendor cap/.test(capped.error ?? ""), "x402 must fail closed when amount exceeds vendor cap");
} finally {
  await new Promise((r) => x402Server.close(() => r()));
}
await x402Store.upsertX402Policy({
  vendorId: "smoke-store",
  walletName: "smoke-evm",
  originAllowlist: ["http://127.0.0.1:1"],
  allowedAssets: ["USDC"],
  maxPaymentPerRequest: { "8453:USDC": "100" },
});
const policies = await x402Store.listX402Policies();
assert(policies.find((p) => p.vendorId === "smoke-store"), "x402 policy store must persist policies");

// NOWPayments IPN signature verification
await nowpayments.configureNowpayments({ environment: "sandbox", apiKey: "smoke-key-1234567890", ipnSecret: "smoke-ipn-secret-12345" });
const ipnBody = { actually_paid: 5, pay_amount: 5, pay_currency: "usdc", payment_id: 1, payment_status: "finished" };
const canonical = nowpayments.canonicalizeForIpn(ipnBody);
const goodSig = crypto.createHmac("sha512", "smoke-ipn-secret-12345").update(canonical).digest("hex");
const goodVerify = await nowpayments.verifyNowpaymentsIpn({ rawBody: JSON.stringify(ipnBody), sigHeader: goodSig });
assert(goodVerify.valid === true, "valid NOWPayments IPN must pass HMAC verification");
const badVerify = await nowpayments.verifyNowpaymentsIpn({ rawBody: JSON.stringify(ipnBody), sigHeader: "0".repeat(128) });
assert(badVerify.valid === false && /mismatch/.test(badVerify.reason), "bad NOWPayments IPN signature must fail");

await evmWallet.deleteEvmWallet("smoke-evm", "smoke-evm");

// ---------------------------------------------------------------------------
// P15 — Secure traveler profiles. Encryption, redaction, reveal round-trip.
// ---------------------------------------------------------------------------
process.env.LYTH_MCP_PROFILE_STORE = join(temp, "profiles.json");
process.env.LYTH_MCP_PROFILE_KEY = join(temp, "profiles.key");
const profiles = await import("../dist/profiles.js");

const profileInput = {
  legalFirstName: "Smoke",
  legalLastName: "Tester",
  dateOfBirth: "1990-01-15",
  nationality: "CA",
  contact: { email: "smoke@example.com", phone: "+15555550101" },
  ticketDeliveryEmail: "tickets@example.com",
  passports: [{ number: "AB1234567", countryOfIssue: "CA", expiresOn: "2030-06-01" }],
  frequentFlyerNumbers: [{ airline: "AC", number: "AC123" }],
};
const profileSummary = await profiles.createProfile({
  id: "smoke-profile",
  displayName: "Smoke Traveler",
  profile: profileInput,
  allowLocalKey: true,
});
assert(profileSummary.redacted.legalName.startsWith("Smoke T"), "redacted legal name must mask the last name");
assert(profileSummary.redacted.contact.email.includes("•"), "redacted email must be masked");
assert(profileSummary.redacted.passports?.[0]?.last4 === "4567", "passport last4 must be exposed in redacted preview");
assert(!JSON.stringify(profileSummary).includes("AB1234567"), "redacted profile must never contain raw passport number");

const revealed = await profiles.revealProfile("smoke-profile");
assert(revealed.passports?.[0]?.number === "AB1234567", "reveal must return the raw passport number");
assert(revealed.ticketDeliveryEmail === "tickets@example.com", "reveal must preserve ticketDeliveryEmail");

const customer = profiles.customerFieldsFromProfile(revealed);
assert(customer.firstName === "Smoke" && customer.lastName === "Tester", "customer mapping must use legal name when preferredName is absent");
assert(customer.email === "tickets@example.com", "customer email must prefer ticketDeliveryEmail over contact.email");

const patched = await profiles.updateProfile({
  id: "smoke-profile",
  patch: { preferredName: "Smokey" },
});
const revealedPatched = await profiles.revealProfile("smoke-profile");
assert(revealedPatched.preferredName === "Smokey", "update must persist preferredName");
assert(revealedPatched.passports?.[0]?.number === "AB1234567", "update must preserve untouched fields");

const customer2 = profiles.customerFieldsFromProfile(revealedPatched);
assert(customer2.firstName === "Smokey", "customer firstName must prefer preferredName when present");

// Duffel passenger mapping (offline; doesn't hit the Duffel API)
const duffel = await import("../dist/duffel.js");
const duffelPassenger = duffel.duffelPassengerFromProfile({
  profile: revealedPatched,
  passengerId: "pas_smoke_0001",
});
assert(duffelPassenger.id === "pas_smoke_0001", "passenger id passes through");
assert(duffelPassenger.given_name === "Smokey", "given_name uses preferredName");
assert(duffelPassenger.family_name === "Tester", "family_name uses legalLastName");
assert(duffelPassenger.email === "tickets@example.com", "email prefers ticketDeliveryEmail");
assert(duffelPassenger.born_on === "1990-01-15", "born_on uses dateOfBirth");
assert(duffelPassenger.identity_documents?.[0]?.unique_identifier === "AB1234567", "passport pass-through");
assert(duffelPassenger.identity_documents?.[0]?.issuing_country_code === "CA", "passport country uppercased");
assert(duffelPassenger.loyalty_programme_accounts?.[0]?.airline_iata_code === "AC", "FF airline pass-through");

// Multi-passport: prefer matching country, then latest expiry
const multiProfile = {
  ...revealedPatched,
  passports: [
    { number: "OLDOLDOLD", countryOfIssue: "CA", expiresOn: "2025-01-01" },
    { number: "NEWNEWNEW", countryOfIssue: "CA", expiresOn: "2032-01-01" },
    { number: "USAUSAUSA", countryOfIssue: "US", expiresOn: "2031-01-01" },
  ],
};
const pickLatestCa = duffel.duffelPassengerFromProfile({ profile: multiProfile, passengerId: "p1", preferredPassportCountry: "CA" });
assert(pickLatestCa.identity_documents?.[0]?.unique_identifier === "NEWNEWNEW", "should pick latest-expiring matching-country passport");
const pickUs = duffel.duffelPassengerFromProfile({ profile: multiProfile, passengerId: "p1", preferredPassportCountry: "US" });
assert(pickUs.identity_documents?.[0]?.unique_identifier === "USAUSAUSA", "should pick US passport when preferred");
const skipPassport = duffel.duffelPassengerFromProfile({ profile: multiProfile, passengerId: "p1", includePassport: false });
assert(skipPassport.identity_documents === undefined, "includePassport:false must omit passport");

// KTN + redress mapping (Duffel allows ONE identity document per passenger)
const ktnProfile = {
  ...revealedPatched,
  nationality: "US",
  knownTravelerNumbers: { globalEntry: "GE111222333", tsaPrecheck: "TT444555666" },
  redressNumber: "RR9876543",
};
const ktnPicked = duffel.duffelPassengerFromProfile({
  profile: ktnProfile,
  passengerId: "p1",
  identityDocumentPreference: "known_traveler_number",
});
assert(ktnPicked.identity_documents?.length === 1, "ktn preference must emit exactly one identity document");
assert(ktnPicked.identity_documents?.[0]?.type === "known_traveler_number", "ktn doc type must be known_traveler_number");
assert(ktnPicked.identity_documents?.[0]?.unique_identifier === "GE111222333", "ktn must prefer globalEntry over tsaPrecheck");
assert(ktnPicked.identity_documents?.[0]?.issuing_country_code === "US", "ktn issuing country defaults to profile nationality");

const ktnTsaOnly = duffel.duffelPassengerFromProfile({
  profile: { ...ktnProfile, knownTravelerNumbers: { tsaPrecheck: "TT444555666" } },
  passengerId: "p1",
  identityDocumentPreference: "known_traveler_number",
});
assert(ktnTsaOnly.identity_documents?.[0]?.unique_identifier === "TT444555666", "ktn falls back to tsaPrecheck when no globalEntry");

const redressPicked = duffel.duffelPassengerFromProfile({
  profile: ktnProfile,
  passengerId: "p1",
  identityDocumentPreference: "passenger_redress_number",
});
assert(redressPicked.identity_documents?.[0]?.type === "passenger_redress_number", "redress type must pass through");
assert(redressPicked.identity_documents?.[0]?.unique_identifier === "RR9876543", "redress number must pass through");

const noneId = duffel.duffelPassengerFromProfile({
  profile: ktnProfile,
  passengerId: "p1",
  identityDocumentPreference: "none",
});
assert(noneId.identity_documents === undefined, "preference=none must omit identity_documents");

const ktnNoData = duffel.duffelPassengerFromProfile({
  profile: { ...revealedPatched, knownTravelerNumbers: undefined },
  passengerId: "p1",
  identityDocumentPreference: "known_traveler_number",
});
assert(ktnNoData.identity_documents === undefined, "ktn preference with no KTN in profile must omit identity_documents");

// Gated live Duffel sandbox check. Off by default. Set LYTH_MCP_LIVE_DUFFEL_TEST=1
// and either DUFFEL_ACCESS_TOKEN or LYTH_MCP_DUFFEL_TEST_TOKEN to a test-mode
// access token (https://duffel.com → Settings → Access Tokens → Test mode).
// Does only read-only searches; never creates an order.
let liveDuffelOk = "skipped";
if (process.env.LYTH_MCP_LIVE_DUFFEL_TEST === "1") {
  const token = process.env.LYTH_MCP_DUFFEL_TEST_TOKEN || process.env.DUFFEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error("LYTH_MCP_LIVE_DUFFEL_TEST=1 requires LYTH_MCP_DUFFEL_TEST_TOKEN or DUFFEL_ACCESS_TOKEN");
  }
  process.env.LYTH_MCP_DUFFEL_CONFIG = join(temp, "duffel.json");
  process.env.LYTH_MCP_DUFFEL_KEY = join(temp, "duffel.key");
  await duffel.configureDuffel({ declaredEnvironment: "test", accessToken: token });

  // Far-future date so airlines actually return offers.
  const future = new Date();
  future.setDate(future.getDate() + 90);
  const departureDate = future.toISOString().slice(0, 10);

  const request = await duffel.duffelCreateOfferRequest({
    slices: [{ origin: "LHR", destination: "JFK", departure_date: departureDate }],
    passengers: [{ type: "adult" }],
    cabinClass: "economy",
  });
  assert(typeof request.id === "string" && request.id.startsWith("orq_"), "offer_request id must look like orq_*");
  assert(request.live_mode === false, "test-mode token must produce live_mode=false");

  const offers = await duffel.duffelListOffers({ offerRequestId: request.id, sort: "total_amount", limit: 5 });
  if (offers.length > 0) {
    const firstOffer = await duffel.duffelGetOffer(offers[0].id);
    assert(firstOffer.id === offers[0].id, "duffelGetOffer must return the requested offer");
    liveDuffelOk = `searched LHR→JFK ${departureDate}: ${offers.length} offers, top ${offers[0].total_amount} ${offers[0].total_currency}`;
  } else {
    liveDuffelOk = `searched LHR→JFK ${departureDate}: 0 offers returned (sandbox may be quiet)`;
  }
}

await profiles.deleteProfile("smoke-profile", "smoke-profile");
const after = await profiles.listProfiles();
assert(after.find((p) => p.id === "smoke-profile") === undefined, "delete must remove the profile");

console.log(JSON.stringify({
  ok: true,
  temp,
  connector: connector.id,
  order: order.id,
  booking: booking.id,
  invoice: invoice.id,
  bridgeRoute: bridgeRoute.id,
  bridgeAlerts: bridgeAlerts.length,
  assets: assetRegistry.registry.assets.length,
  blockedCommerce: blockedCommerce.level,
  explainedError: mempoolError.classification,
  clusters: clusterRegistry.registry.clusters.length,
  euProvers: euProvers.length,
  monarchClusters: monarch.clusters.length,
  delegationTaper: delegationCap.taper.rewardTaperPercent,
  autovoteCandidates: autovote.rankedCandidates.length,
  nodes: nodeRegistry.registry.nodes.length,
  nodeDiversity: diversity.score,
  security: securityDashboard.severity,
  readiness: readinessDashboard.completionPercent,
  demoConnectorTemplates: connectorTemplates.length,
  runbooks: runbookList.length,
  evmWalletAddress: evmCreated.address,
  evmTxSigningOk: signedTx.from === "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F",
  x402PolicyCount: policies.length,
  nowpaymentsIpnVerifyOk: goodVerify.valid === true,
  nowpaymentsIpnRejectOk: badVerify.valid === false,
  profileRedactionOk: profileSummary.redacted.passports?.[0]?.last4 === "4567",
  profileCustomerMappingOk: customer2.firstName === "Smokey" && customer2.email === "tickets@example.com",
  duffelPassengerMappingOk:
    duffelPassenger.email === "tickets@example.com" &&
    duffelPassenger.identity_documents?.[0]?.unique_identifier === "AB1234567" &&
    pickLatestCa.identity_documents?.[0]?.unique_identifier === "NEWNEWNEW" &&
    pickUs.identity_documents?.[0]?.unique_identifier === "USAUSAUSA",
  duffelKtnRedressMappingOk:
    ktnPicked.identity_documents?.[0]?.unique_identifier === "GE111222333" &&
    ktnTsaOnly.identity_documents?.[0]?.unique_identifier === "TT444555666" &&
    redressPicked.identity_documents?.[0]?.unique_identifier === "RR9876543" &&
    noneId.identity_documents === undefined,
  liveDuffel: liveDuffelOk,
}, null, 2));

async function startMockRpc() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      const response = request.method === "lyth_submitEncrypted"
        ? {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32047,
              message: "upstream unavailable: mempool: decryption failed",
            },
          }
        : {
            jsonrpc: "2.0",
            id: request.id,
            result: "0x10f2c",
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    async call(method, params = []) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return res.json();
    },
    close() {
      return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}
