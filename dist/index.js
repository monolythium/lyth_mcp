#!/usr/bin/env node
/**
 * lyth-mcp — Monolythium MCP server.
 *
 * The server is intentionally wallet-safe:
 * - reads live Monolythium RPC/API data;
 * - drafts and validates AI runbooks;
 * - prepares wallet approval payloads;
 * - stores local MCP wallets only as encrypted PQM-1 mnemonics;
 * - never broadcasts unless LYTH_MCP_ENABLE_SUBMIT=1 is explicitly set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { addressbookInfo, listAddressbookContacts, removeAddressbookContact, resolveAddressbookContact, upsertAddressbookContact, } from "./addressbook.js";
import { addOutboxEntry, forgetOutboxEntry, getOutboxEntry, listOutboxEntries, outboxInfo, recordOutboxAttempt, updateOutboxStatus, } from "./outbox.js";
import { addReceipt, getReceipt, listReceipts, receiptInfo, } from "./receipts.js";
import { buildConnectorHeaders, connectorPayloadHash, connectorStoreInfo, getConnector, listConnectors, redactConnector, removeConnector, resolveConnector, upsertConnector, } from "./connectors.js";
import { demoConnectorDraft, getDemoConnectorTemplate, listDemoConnectorTemplates, } from "./demo_connectors.js";
import { bridgeCircuitBreakerAlerts, bridgeCooldownMatrix, bridgeRegistrySummary, bridgeStatusSummary, getBridgeRoute, listBridgeRoutes, loadBridgeRegistry, quoteBridgeRoute, selectBridgeRoute, } from "./bridges.js";
import { assetRegistrySummary, assetRisk, evaluateAssetUseCase, getAsset, listAssets, loadAssetRegistry, privateDenominationWarning, } from "./assets.js";
import { commerceSafetySummary } from "./commerce_safety.js";
import { createOrder, getOrder, listOrders, orderStoreInfo, updateOrder, } from "./orders.js";
import { bookingStoreInfo, createBooking, getBooking, listBookings, updateBooking, } from "./bookings.js";
import { createInvoice, getInvoice, invoiceStoreInfo, listInvoices, updateInvoice, } from "./invoices.js";
import { explainError } from "./error_explain.js";
import { clusterFoundationFlag, clusterRegistrySummary, clusterReputation, clusterSunsetStatus, getCluster, getOperator, listClusters, listOperators, loadClusterRegistry, monarchOperatorAssistant, operatorStatus, searchServices, } from "./clusters.js";
import { autovoteSimulate, delegateDraft, delegationPhaseConfig, explainDelegationCaps, rebalanceDraft, stakeStatus, undelegateDraft, } from "./delegation.js";
import { explainPcr, getNode, listNodes, loadNodeRegistry, nodeAttestation, nodeDiversityScore, nodeHostingClass, nodeRegistrySummary, } from "./nodes.js";
import { readinessCheck, } from "./readiness.js";
import { auditResearchGateDashboard, bridgeBlastRadiusMonitor, emergencyStateWatch, recoveryRunbookDraft, recoveryStatus, securityStatus, } from "./security.js";
import { evaluateMerchantPolicy, getMerchantPolicy, listMerchantPolicies, merchantPolicyStoreInfo, removeMerchantPolicy, upsertMerchantPolicy, } from "./merchant_policy.js";
import { diffRunbookContent, getCanonicalRunbook, listCanonicalRunbooks, } from "./runbooks.js";
import { renderRisk } from "./risk_renderer.js";
import { getVendor, loadVendorRegistry, quoteVendorOrder, searchVendors, vendorRegistrySummary, } from "./vendors.js";
import { buildTransfer, configureLowValuePolicy, createWallet, deleteWallet, encryptionKeyFromRpc, exportMnemonic, importWallet, listWallets, moveLowValueAccounting, unitsToDecimal, updateAgentWalletMetadata, walletStoreInfo, } from "./wallet.js";
import { accountSafetyProfiles, explainWalletThresholds, simulateHotWalletPolicy, } from "./wallet_safety.js";
import { createProfile, deleteProfile, getProfile, listProfiles, profileStoreInfo, revealProfile, updateProfile, } from "./profiles.js";
import { travalaBookStatus, travalaListTools, travalaMcpUrl, travalaProxyCall, } from "./travala.js";
import { configureDuffel, duffelCancelOrder, duffelConfigRedacted, duffelConfirmCancellation, duffelCreateOfferRequest, duffelCreateOrder, duffelGetOffer, duffelGetOrder, duffelGetSeatMaps, duffelListOffers, duffelListOrders, duffelPassengerFromProfile, duffelPayOrder, summarizeOffer, summarizeOrder, } from "./duffel.js";
import { configureNowpayments, nowpaymentsCreateInvoice, nowpaymentsCreatePayment, nowpaymentsCurrencies, nowpaymentsEstimate, nowpaymentsGetPayment, nowpaymentsListPayments, nowpaymentsMerchantCoins, nowpaymentsRedactedConfig, nowpaymentsRefundDraft, nowpaymentsStatus, verifyNowpaymentsIpn, } from "./nowpayments.js";
import { configureChangenow, changenowStatus, changenowCurrencies, changenowMinAmount, changenowEstimate, changenowCreateSwap, changenowSwapStatus, changenowSwapList, changenowFiatEstimate, changenowFiatSellDraft, changenowRedactedConfig, } from "./changenow.js";
const DEFAULT_CHAIN_ID = 69420;
const DEFAULT_NETWORK = "testnet-69420";
const DEFAULT_RPCS = [
    "http://178.105.15.216:8545",
    "http://178.104.233.182:8545",
    "http://65.108.94.1:8545",
    "http://95.216.154.155:8545",
    "http://87.99.145.48:8545",
    "http://5.223.85.76:8545",
];
const RPCS = (process.env.LYTH_RPC_URLS ?? process.env.LYTH_RPC_URL ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const CONFIGURED_RPCS = RPCS.length > 0 ? RPCS : DEFAULT_RPCS;
const NETWORK = process.env.LYTH_NETWORK ?? DEFAULT_NETWORK;
const CHAIN_ID = Number(process.env.LYTH_CHAIN_ID ?? DEFAULT_CHAIN_ID);
const REQUEST_TIMEOUT_MS = Number(process.env.LYTH_MCP_TIMEOUT_MS ?? 10_000);
const MAX_OUTPUT = Number(process.env.LYTH_MCP_MAX_OUTPUT ?? 16_000);
const SUBMIT_ENABLED = process.env.LYTH_MCP_ENABLE_SUBMIT === "1";
const DEFAULT_LOW_VALUE_MAX = process.env.LYTH_MCP_DEFAULT_LOW_VALUE_MAX ?? "10";
const DEFAULT_LOW_VALUE_DAILY_LIMIT = process.env.LYTH_MCP_DEFAULT_LOW_VALUE_DAILY_LIMIT ?? "50";
const DEFAULT_OUTBOX_EXPIRY_HOURS = Number(process.env.LYTH_MCP_OUTBOX_EXPIRY_HOURS ?? 24);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VENDOR_REGISTRY_PATH = resolve(PACKAGE_ROOT, "vendors.example.json");
const VENDOR_REGISTRY_PATH = process.env.LYTH_MCP_VENDOR_REGISTRY || DEFAULT_VENDOR_REGISTRY_PATH;
const DEFAULT_ASSET_REGISTRY_PATH = resolve(PACKAGE_ROOT, "asset_registry.example.json");
const ASSET_REGISTRY_PATH = process.env.LYTH_MCP_ASSET_REGISTRY || DEFAULT_ASSET_REGISTRY_PATH;
const DEFAULT_BRIDGE_ROUTE_REGISTRY_PATH = resolve(PACKAGE_ROOT, "bridge_routes.example.json");
const BRIDGE_ROUTE_REGISTRY_PATH = process.env.LYTH_MCP_BRIDGE_ROUTE_REGISTRY || DEFAULT_BRIDGE_ROUTE_REGISTRY_PATH;
const DEFAULT_CLUSTER_REGISTRY_PATH = resolve(PACKAGE_ROOT, "clusters.example.json");
const CLUSTER_REGISTRY_PATH = process.env.LYTH_MCP_CLUSTER_REGISTRY || DEFAULT_CLUSTER_REGISTRY_PATH;
const DEFAULT_NODE_REGISTRY_PATH = resolve(PACKAGE_ROOT, "nodes.example.json");
const NODE_REGISTRY_PATH = process.env.LYTH_MCP_NODE_REGISTRY || DEFAULT_NODE_REGISTRY_PATH;
const RUNBOOK_REGISTRY_PATH = process.env.LYTH_MCP_RUNBOOK_REGISTRY || resolve(PACKAGE_ROOT, "runbooks");
function truncate(value, max = MAX_OUTPUT) {
    const text = typeof value === "string" ? value : safeStringify(value);
    return text.length > max ? `${text.slice(0, max)}\n... (truncated)` : text;
}
function safeStringify(value) {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
function text(value) {
    return { content: [{ type: "text", text: truncate(value) }] };
}
function compactWallet(wallet) {
    return {
        name: wallet.name,
        address: wallet.address,
        algorithm: wallet.algorithm,
        keyProtection: wallet.keyProtection,
        createdAt: wallet.createdAt,
        lowValue: wallet.lowValue,
        agent: wallet.agent,
    };
}
function errorText(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
function errorJson(value) {
    return { content: [{ type: "text", text: truncate(value) }], isError: true };
}
function isHex(value) {
    return /^0x[0-9a-fA-F]*$/.test(value);
}
function isAddress(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(value) || /^mono1[0-9a-z]+$/.test(value);
}
function isWireAddress(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(value);
}
async function resolveRecipient(value) {
    const input = value.trim();
    if (isWireAddress(input)) {
        return {
            input,
            address: input,
            source: "literal",
        };
    }
    const contact = await resolveAddressbookContact(input);
    if (!contact) {
        return null;
    }
    return {
        input,
        address: contact.address,
        source: "addressbook",
        contact: {
            name: contact.name,
            note: contact.note,
            tags: contact.tags,
        },
    };
}
function toQuantity(value) {
    return `0x${value.toString(16)}`;
}
function parseQuantity(value) {
    if (typeof value !== "string") {
        throw new Error(`expected hex quantity string, got ${typeof value}`);
    }
    if (!/^0x[0-9a-fA-F]+$/.test(value)) {
        throw new Error(`invalid hex quantity: ${value}`);
    }
    return BigInt(value);
}
function parseFlexibleBigint(value) {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
        return BigInt(trimmed);
    }
    if (/^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
    }
    throw new Error(`invalid integer: ${value}`);
}
function decimalToUnits(input, decimals = 18) {
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
function compareDecimal(a, b, decimals = 18) {
    const aa = decimalToUnits(a, decimals);
    const bb = decimalToUnits(b, decimals);
    return aa === bb ? 0 : aa > bb ? 1 : -1;
}
function apiBaseFromRpc(endpoint) {
    const url = new URL(endpoint);
    url.pathname = "/api/v1/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
async function withTimeout(fn, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fn(controller.signal);
    }
    finally {
        clearTimeout(timeout);
    }
}
async function rpcCall(endpoint, method, params = []) {
    return withTimeout(async (signal) => {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": "lyth-mcp/0.1.0",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method,
                params,
            }),
            signal,
        });
        const body = (await res.json());
        if (body.error) {
            throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
        }
        if (!("result" in body)) {
            throw new Error(`${method} returned no result; HTTP ${res.status}`);
        }
        return body.result;
    });
}
async function apiGet(endpoint, path, query = {}) {
    const url = new URL(`${apiBaseFromRpc(endpoint)}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    }
    return withTimeout(async (signal) => {
        const res = await fetch(url, {
            headers: { "user-agent": "lyth-mcp/0.1.0" },
            signal,
        });
        const body = await res.json();
        if (!res.ok) {
            throw new Error(`API ${res.status}: ${safeStringify(body)}`);
        }
        return body;
    });
}
async function sendConnectorJson(connector, payload) {
    if (!connector.enabled) {
        throw new Error(`connector '${connector.id}' is disabled`);
    }
    const body = safeStringify(payload);
    const headers = await buildConnectorHeaders(connector, body);
    return withTimeout(async (signal) => {
        const res = await fetch(connector.endpoint, {
            method: connector.method,
            headers,
            body,
            signal,
        });
        const responseText = await res.text();
        let responseBody = responseText;
        try {
            responseBody = responseText ? JSON.parse(responseText) : null;
        }
        catch {
            responseBody = responseText;
        }
        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            endpoint: connector.endpoint,
            method: connector.method,
            payloadHash: connectorPayloadHash(body),
            responseHash: connectorPayloadHash(responseText),
            responseBody,
        };
    });
}
function connectorResponseReference(responseBody, fallback) {
    if (responseBody && typeof responseBody === "object") {
        const body = responseBody;
        for (const key of ["confirmation", "reference", "receiptId", "orderId", "bookingId", "id"]) {
            if (typeof body[key] === "string" && body[key]) {
                return body[key];
            }
        }
    }
    return fallback;
}
async function probeEndpoint(endpoint) {
    const started = Date.now();
    try {
        const chainId = parseQuantity(await rpcCall(endpoint, "eth_chainId"));
        const height = parseQuantity(await rpcCall(endpoint, "eth_blockNumber"));
        return {
            endpoint,
            ok: chainId === BigInt(CHAIN_ID),
            chainId: chainId.toString(),
            height: height.toString(),
            latencyMs: Date.now() - started,
        };
    }
    catch (err) {
        return {
            endpoint,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - started,
        };
    }
}
async function scoreEndpoint(endpoint) {
    const probe = await probeEndpoint(endpoint);
    const checks = {};
    const warnings = [];
    let score = probe.ok ? 100 : 0;
    if (!probe.ok) {
        warnings.push("chain id/block probe failed");
    }
    if (probe.latencyMs > 2_000) {
        score -= 10;
        warnings.push("high latency");
    }
    const [gasPrice, mempool, sync, encryptionKey] = await Promise.allSettled([
        probe.ok ? rpcCall(endpoint, "eth_gasPrice", []) : Promise.reject(new Error("probe failed")),
        probe.ok ? rpcCall(endpoint, "lyth_mempoolStatus", []) : Promise.reject(new Error("probe failed")),
        probe.ok ? rpcCall(endpoint, "lyth_syncStatus", []) : Promise.reject(new Error("probe failed")),
        probe.ok ? rpcCall(endpoint, "lyth_getEncryptionKey", []) : Promise.reject(new Error("probe failed")),
    ]);
    if (gasPrice.status === "fulfilled") {
        checks.gasPrice = gasPrice.value;
    }
    else {
        score -= 10;
        checks.gasPrice = { error: gasPrice.reason?.message ?? String(gasPrice.reason) };
        warnings.push("gas price unavailable");
    }
    if (mempool.status === "fulfilled") {
        checks.mempool = mempool.value;
    }
    else {
        score -= 25;
        checks.mempool = { error: mempool.reason?.message ?? String(mempool.reason) };
        warnings.push("mempool status unavailable");
    }
    if (sync.status === "fulfilled") {
        checks.sync = sync.value;
    }
    else {
        score -= 15;
        checks.sync = { error: sync.reason?.message ?? String(sync.reason) };
        warnings.push("sync status unavailable");
    }
    if (encryptionKey.status === "fulfilled") {
        checks.encryptionKey = encryptionKey.value;
    }
    else {
        score -= 25;
        checks.encryptionKey = { error: encryptionKey.reason?.message ?? String(encryptionKey.reason) };
        warnings.push("encryption key unavailable");
    }
    const normalizedScore = Math.max(0, Math.min(100, score));
    return {
        ...probe,
        score: normalizedScore,
        writeReady: probe.ok && normalizedScore >= 70 && encryptionKey.status === "fulfilled",
        quarantined: !probe.ok || normalizedScore < 50,
        warnings,
        checks,
    };
}
async function rpcHealth() {
    const endpoints = await Promise.all(CONFIGURED_RPCS.map(scoreEndpoint));
    const sorted = [...endpoints].sort((a, b) => {
        const heightA = "height" in a && typeof a.height === "string" ? BigInt(a.height) : 0n;
        const heightB = "height" in b && typeof b.height === "string" ? BigInt(b.height) : 0n;
        return b.score - a.score || Number(heightB - heightA) || a.latencyMs - b.latencyMs;
    });
    return {
        checkedAt: new Date().toISOString(),
        selectedRead: sorted.find((endpoint) => endpoint.ok)?.endpoint ?? null,
        selectedWrite: sorted.find((endpoint) => endpoint.writeReady)?.endpoint ?? null,
        endpoints: sorted,
    };
}
async function firstReachableEndpoint() {
    const probes = await Promise.all(CONFIGURED_RPCS.map(probeEndpoint));
    const selected = probes
        .filter((p) => p.ok === true)
        .sort((a, b) => Number(BigInt(b.height) - BigInt(a.height)) || a.latencyMs - b.latencyMs)[0];
    if (!selected) {
        throw new Error(`no reachable Monolythium RPC for chain ${CHAIN_ID}: ${safeStringify(probes)}`);
    }
    return selected.endpoint;
}
async function firstWritableEndpoint() {
    const health = await rpcHealth();
    if (!health.selectedWrite) {
        throw new Error(`no writable Monolythium RPC for chain ${CHAIN_ID}: ${safeStringify(health.endpoints)}`);
    }
    return health.selectedWrite;
}
function runbookCatalogue() {
    return [
        {
            name: "request_funds",
            status: "draft_only",
            purpose: "Ask the principal to fund an agent wallet for a bounded task.",
            requiredFields: ["agentAddress", "amount", "asset", "purpose"],
        },
        {
            name: "pay_vendor",
            status: "live_preparable",
            purpose: "Prepare a wallet-approved native LYTH payment to a vendor or service.",
            requiredFields: ["recipient", "amount", "asset"],
            liveLimit: "Native LYTH transfers can be prepared today. Token payments need MRC/bridge support once live.",
        },
        {
            name: "book_service",
            status: "draft_only",
            purpose: "Express an agent workflow for booking an external service under a spending policy.",
            requiredFields: ["vendorId", "service", "amount", "asset"],
        },
        {
            name: "open_escrow",
            status: "draft_only",
            purpose: "Draft an escrow workflow. Broadcast support waits for the escrow module/contract surface.",
            requiredFields: ["counterparty", "amount", "asset", "deliverable"],
        },
        {
            name: "place_trade",
            status: "draft_only",
            purpose: "Draft a spot-market order intent for wallet or trading-interface approval.",
            requiredFields: ["marketId", "side", "amount", "limitPrice"],
        },
        {
            name: "set_spending_policy",
            status: "draft_only",
            purpose: "Draft an agent spending policy update for wallet approval.",
            requiredFields: ["agentAddress", "policy"],
        },
        {
            name: "revoke_agent_permission",
            status: "draft_only",
            purpose: "Draft revocation of an agent permission or spending policy.",
            requiredFields: ["agentAddress", "permissionId"],
        },
        {
            name: "verify_receipt",
            status: "live_read",
            purpose: "Read and verify a transaction receipt on the live chain.",
            requiredFields: ["txHash"],
        },
        {
            name: "rate_vendor",
            status: "draft_only",
            purpose: "Draft a vendor reputation update after completion.",
            requiredFields: ["vendorId", "rating", "receipt"],
        },
    ];
}
async function canonicalRunbookFor(name) {
    try {
        return await getCanonicalRunbook(RUNBOOK_REGISTRY_PATH, name);
    }
    catch {
        return null;
    }
}
function canonicalRunbookReference(runbook, fields) {
    const requiredFields = stringArrayField(runbook.content, "requiredFields");
    const optionalFields = stringArrayField(runbook.content, "optionalFields");
    return {
        id: runbook.id,
        name: runbook.name,
        version: runbook.version,
        contentHash: runbook.contentHash,
        hashAlgorithm: runbook.hashAlgorithm,
        requiredFields,
        optionalFields,
        missingRequiredFields: requiredFields.filter((field) => isMissingRunbookField(fields, field)),
        verifiedAt: new Date().toISOString(),
    };
}
function stringArrayField(value, field) {
    if (!value || typeof value !== "object") {
        return [];
    }
    const raw = value[field];
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [];
}
function isMissingRunbookField(fields, field) {
    const value = fields[field];
    return value === undefined || value === null || value === "";
}
function buildRunbookDraft(args) {
    const fields = args.fields ?? {};
    const policy = args.policy ?? {};
    const amount = String(fields.amount ?? "");
    const asset = String(fields.asset ?? "LYTH").toUpperCase();
    const vendor = String(fields.vendorId ?? fields.vendor ?? fields.recipient ?? "");
    const category = String(fields.category ?? fields.serviceCategory ?? "");
    const approvalPrompt = approvalPromptFor(args.runbook, fields);
    const id = `rb_${args.runbook}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const walletRequests = [];
    const risks = [
        "The MCP server does not hold keys and cannot approve spending by itself.",
        "The user must inspect the wallet approval before signing.",
    ];
    const notes = [
        "This runbook is a typed intent. It is not a signed transaction.",
        "Use prepare_wallet_request for wallet-compatible approval payloads where supported.",
    ];
    const canonicalRunbook = args.canonicalRunbook ? canonicalRunbookReference(args.canonicalRunbook, fields) : undefined;
    if (canonicalRunbook) {
        notes.push(`Canonical runbook ${canonicalRunbook.id} verified with ${canonicalRunbook.contentHash}.`);
    }
    else {
        notes.push("No bundled canonical runbook definition is available for this runbook yet.");
    }
    let title = args.runbook;
    let status = "draft_only";
    let liveExecution = {
        supported: false,
        mode: "not_live",
        reason: "This runbook needs a future module, external service connector, or wallet integration.",
    };
    let steps = [
        { id: "check_policy", title: "Check spending policy", detail: "Validate asset, amount, vendor, category, expiry, and approval requirement." },
        { id: "request_approval", title: "Request approval", detail: "Show the user the exact action before execution." },
    ];
    if (args.runbook === "request_funds") {
        title = "Request agent wallet funding";
        steps = [
            ...steps,
            { id: "show_address", title: "Show agent wallet address", detail: "Ask the principal to fund the agent wallet or set a bounded allowance." },
            { id: "verify_funds", title: "Verify funds", detail: "Check the live chain for the incoming payment before work starts." },
        ];
    }
    if (args.runbook === "pay_vendor") {
        title = "Pay vendor";
        status = asset === "LYTH" ? "live_preparable" : "draft_only";
        liveExecution = asset === "LYTH"
            ? {
                supported: true,
                mode: "wallet_approval",
                reason: "Native LYTH transfer can be prepared as an eth_sendTransaction wallet request.",
            }
            : {
                supported: false,
                mode: "not_live",
                reason: `${asset} token payment needs token/MRC/bridge module support before this MCP can prepare a live payload.`,
            };
        steps = [
            ...steps,
            { id: "resolve_vendor", title: "Resolve vendor", detail: "Confirm the vendor address, display name, and route risk." },
            { id: "submit_payment", title: "Submit payment", detail: "Send the approved payment through the user's wallet." },
            { id: "record_receipt", title: "Record receipt", detail: "Track the resulting transaction hash and receipt." },
        ];
        if (asset !== "LYTH") {
            risks.push("Non-native assets require token-route metadata and are not live-preparable in this MVP.");
        }
        if (typeof fields.recipient === "string" && !isWireAddress(fields.recipient)) {
            notes.push("Wallet payload preparation needs a 0x wire address. mono1 display addresses should be resolved by the wallet or SDK first.");
        }
    }
    if (args.runbook === "book_service") {
        title = "Book service";
        steps = [
            ...steps,
            { id: "discover_vendor", title: "Discover vendor", detail: "Find a vendor through the local registry or an external connector." },
            { id: "confirm_terms", title: "Confirm terms", detail: "Confirm service, price, delivery window, refund path, and tip policy." },
            { id: "pay_or_escrow", title: "Pay or escrow", detail: "Use pay_vendor for simple payment or open_escrow for deliverable-based work." },
        ];
    }
    if (args.runbook === "open_escrow") {
        title = "Open escrow";
        risks.push("Escrow broadcast support waits for the escrow module or deployed contract surface.");
        steps = [
            ...steps,
            { id: "define_deliverable", title: "Define deliverable", detail: "Record deliverable, acceptance criteria, deadline, and arbiter." },
            { id: "lock_funds", title: "Lock funds", detail: "Lock funds after wallet approval once the live escrow surface is available." },
        ];
    }
    if (args.runbook === "place_trade") {
        title = "Place spot-market order";
        risks.push("Market orders can move price. Always show market, side, limit price, slippage, and max spend.");
        steps = [
            ...steps,
            { id: "load_market", title: "Load market", detail: "Read the live order book/trades for the selected market." },
            { id: "check_slippage", title: "Check slippage", detail: "Confirm limit price, max spend, and cancellation policy." },
            { id: "submit_order", title: "Submit order", detail: "Submit through a wallet or trading interface once live order payload support is wired." },
        ];
    }
    if (args.runbook === "set_spending_policy") {
        title = "Set spending policy";
        steps = [
            ...steps,
            { id: "render_policy", title: "Render policy", detail: "Show the budget, allowed assets, vendors, categories, expiry, and revocation path." },
            { id: "apply_policy", title: "Apply policy", detail: "Submit the policy update through the wallet when the policy transaction builder is wired." },
        ];
    }
    if (args.runbook === "revoke_agent_permission") {
        title = "Revoke agent permission";
        risks.push("Revocation should be prioritized when a key, device, vendor, or agent is suspected compromised.");
        steps = [
            ...steps,
            { id: "select_permission", title: "Select permission", detail: "Identify the agent permission, allowance, or session to revoke." },
            { id: "submit_revoke", title: "Submit revocation", detail: "Submit revocation through the wallet and verify receipt." },
        ];
    }
    if (args.runbook === "verify_receipt") {
        title = "Verify receipt";
        status = "live_preparable";
        liveExecution = {
            supported: true,
            mode: "wallet_approval",
            reason: "Receipt verification is read-only and can run against the live chain.",
        };
        steps = [
            { id: "fetch_receipt", title: "Fetch receipt", detail: "Read transaction status and receipt from the live chain." },
            { id: "match_expectation", title: "Match expectation", detail: "Compare sender, recipient, amount, status, and block height against the runbook." },
        ];
    }
    if (args.runbook === "rate_vendor") {
        title = "Rate vendor";
        steps = [
            ...steps,
            { id: "verify_receipt", title: "Verify receipt", detail: "Confirm the referenced payment or escrow release happened." },
            { id: "submit_rating", title: "Submit rating", detail: "Record rating through the vendor registry once the live reputation surface is available." },
        ];
    }
    if (amount && policy.maxAmount && compareDecimal(amount, policy.maxAmount) > 0) {
        risks.push(`Requested amount ${amount} exceeds policy maxAmount ${policy.maxAmount}.`);
    }
    if (policy.assetAllowlist && !policy.assetAllowlist.map((a) => a.toUpperCase()).includes(asset)) {
        risks.push(`Asset ${asset} is not in the policy asset allowlist.`);
    }
    if (policy.vendorAllowlist && vendor && !policy.vendorAllowlist.includes(vendor)) {
        risks.push(`Vendor/counterparty ${vendor} is not in the policy vendor allowlist.`);
    }
    if (policy.categoryAllowlist && category && !policy.categoryAllowlist.includes(category)) {
        risks.push(`Category ${category} is not in the policy category allowlist.`);
    }
    if (policy.expiresAt && Date.parse(policy.expiresAt) < Date.now()) {
        risks.push(`Policy expired at ${policy.expiresAt}.`);
    }
    return {
        schemaVersion: 1,
        id,
        network: NETWORK,
        chainId: CHAIN_ID,
        runbook: args.runbook,
        title,
        status,
        createdAt: new Date().toISOString(),
        agent: args.agent ?? {},
        principal: args.principal ?? {},
        fields,
        policy,
        approval: {
            required: true,
            reason: "Agent economic actions require explicit user approval before signing or broadcasting.",
            prompt: approvalPrompt,
        },
        liveExecution,
        steps,
        walletRequests,
        canonicalRunbook,
        risks,
        notes,
    };
}
async function buildVerifiedRunbookDraft(args) {
    return buildRunbookDraft({
        ...args,
        canonicalRunbook: await canonicalRunbookFor(args.runbook),
    });
}
function approvalPromptFor(runbook, fields) {
    const amount = fields.amount ? `${fields.amount} ${String(fields.asset ?? "LYTH").toUpperCase()}` : "the requested amount";
    switch (runbook) {
        case "pay_vendor":
            return `Approve payment of ${amount} to ${String(fields.recipient ?? fields.vendorId ?? "the vendor")}?`;
        case "request_funds":
            return `Fund agent wallet ${String(fields.agentAddress ?? "(missing address)")} with ${amount}?`;
        case "book_service":
            return `Approve booking ${String(fields.service ?? "the service")} for up to ${amount}?`;
        case "open_escrow":
            return `Approve escrow of ${amount} for ${String(fields.deliverable ?? "the deliverable")}?`;
        case "place_trade":
            return `Approve ${String(fields.side ?? "order")} on ${String(fields.marketId ?? "the market")} with max amount ${amount}?`;
        case "set_spending_policy":
            return `Approve new spending policy for ${String(fields.agentAddress ?? "the agent")}?`;
        case "revoke_agent_permission":
            return `Revoke permission ${String(fields.permissionId ?? "")} for ${String(fields.agentAddress ?? "the agent")}?`;
        case "verify_receipt":
            return `Verify receipt ${String(fields.txHash ?? "")}?`;
        case "rate_vendor":
            return `Record vendor rating for ${String(fields.vendorId ?? "the vendor")}?`;
    }
}
function validateRunbook(draft) {
    const violations = [];
    const warnings = [];
    const fields = draft.fields ?? {};
    const policy = draft.policy ?? {};
    const amount = typeof fields.amount === "string" ? fields.amount : undefined;
    const asset = String(fields.asset ?? "LYTH").toUpperCase();
    const recipient = typeof fields.recipient === "string" ? fields.recipient : undefined;
    const vendor = String(fields.vendorId ?? fields.vendor ?? fields.recipient ?? "");
    const category = String(fields.category ?? fields.serviceCategory ?? "");
    if (!draft.approval?.required) {
        violations.push("approval.required must be true for economic runbooks.");
    }
    for (const field of draft.canonicalRunbook?.missingRequiredFields ?? []) {
        violations.push(`missing required runbook field: ${field}`);
    }
    if (!draft.canonicalRunbook) {
        warnings.push("No canonical runbook definition was attached to this draft.");
    }
    if (amount) {
        try {
            decimalToUnits(amount);
        }
        catch (err) {
            violations.push(err instanceof Error ? err.message : String(err));
        }
    }
    if (amount && policy.maxAmount) {
        try {
            if (compareDecimal(amount, policy.maxAmount) > 0) {
                violations.push(`amount ${amount} exceeds maxAmount ${policy.maxAmount}`);
            }
        }
        catch (err) {
            violations.push(err instanceof Error ? err.message : String(err));
        }
    }
    if (policy.assetAllowlist && !policy.assetAllowlist.map((a) => a.toUpperCase()).includes(asset)) {
        violations.push(`asset ${asset} is not allow-listed`);
    }
    if (policy.vendorAllowlist && vendor && !policy.vendorAllowlist.includes(vendor)) {
        violations.push(`vendor/counterparty ${vendor} is not allow-listed`);
    }
    if (policy.categoryAllowlist && category && !policy.categoryAllowlist.includes(category)) {
        violations.push(`category ${category} is not allow-listed`);
    }
    if (policy.expiresAt && Date.parse(policy.expiresAt) < Date.now()) {
        violations.push(`policy expired at ${policy.expiresAt}`);
    }
    if (recipient && !isAddress(recipient)) {
        violations.push(`recipient is not a recognized Mono address: ${recipient}`);
    }
    if (draft.runbook === "pay_vendor" && asset !== "LYTH") {
        warnings.push("MVP can only prepare native LYTH transfer payloads; token payments remain draft-only.");
    }
    if (draft.runbook === "pay_vendor" && recipient && !isWireAddress(recipient)) {
        warnings.push("prepare_wallet_request needs a 0x wire address; resolve mono1 before wallet approval.");
    }
    if (policy.requireHumanApproval === false) {
        violations.push("requireHumanApproval=false is not allowed for MCP economic actions.");
    }
    return {
        ok: violations.length === 0,
        violations,
        warnings,
        checkedAt: new Date().toISOString(),
    };
}
function prepareWalletRequest(draft, from) {
    const validation = validateRunbook(draft);
    if (!validation.ok) {
        return { prepared: false, validation };
    }
    if (draft.runbook !== "pay_vendor") {
        return {
            prepared: false,
            validation,
            reason: `${draft.runbook} does not have a live wallet payload builder in this MVP.`,
        };
    }
    const recipient = String(draft.fields.recipient ?? "");
    const amount = String(draft.fields.amount ?? "");
    const asset = String(draft.fields.asset ?? "LYTH").toUpperCase();
    if (asset !== "LYTH") {
        return {
            prepared: false,
            validation,
            reason: "Only native LYTH transfer payloads are live-preparable in this MVP.",
        };
    }
    if (!from || !isWireAddress(from)) {
        return {
            prepared: false,
            validation,
            reason: "A 0x sender address is required to prepare eth_sendTransaction.",
        };
    }
    if (!isWireAddress(recipient)) {
        return {
            prepared: false,
            validation,
            reason: "A 0x recipient address is required. Resolve mono1 display addresses in the wallet/SDK first.",
        };
    }
    const value = toQuantity(decimalToUnits(amount));
    const request = {
        method: "eth_sendTransaction",
        params: [
            {
                from,
                to: recipient,
                value,
                data: "0x",
                chainId: toQuantity(BigInt(CHAIN_ID)),
            },
        ],
    };
    return {
        prepared: true,
        validation,
        approvalRequired: true,
        walletRequest: request,
        deeplink: `monolythium://send?to=${encodeURIComponent(recipient)}&amount=${encodeURIComponent(amount)}&asset=LYTH&chainId=${CHAIN_ID}`,
        reminder: "The wallet must render and approve this request. prepare_wallet_request only drafts; it does not sign.",
    };
}
async function loadVendors() {
    return loadVendorRegistry(VENDOR_REGISTRY_PATH);
}
async function loadAssets() {
    // TODO(mainnet): replace bundled example data with signed/on-chain asset registry reads once core/indexer exposes them.
    return loadAssetRegistry(ASSET_REGISTRY_PATH);
}
async function loadBridgeRoutes() {
    return loadBridgeRegistry(BRIDGE_ROUTE_REGISTRY_PATH);
}
async function loadClusters() {
    // TODO(mainnet): replace bundled planning data with signed/indexer cluster registry reads once core exposes them.
    return loadClusterRegistry(CLUSTER_REGISTRY_PATH);
}
async function loadNodes() {
    // TODO(mainnet): replace bundled planning data with signed node registry and TPM quote verification.
    return loadNodeRegistry(NODE_REGISTRY_PATH);
}
async function buildSecurityContext(args = {}) {
    const [bridgeRoutes, clusters, nodes, wallets, outboxEntries, receipts, runbooks, health] = await Promise.all([
        loadBridgeRoutes(),
        loadClusters(),
        loadNodes(),
        listWallets(),
        listOutboxEntries({ limit: 250 }),
        listReceipts({ limit: 250 }),
        listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH),
        args.includeRpc === false ? Promise.resolve(undefined) : rpcHealth(),
    ]);
    return {
        network: NETWORK,
        chainId: CHAIN_ID,
        submitEnabled: SUBMIT_ENABLED,
        rpcHealth: health,
        bridgeRegistry: bridgeRoutes.registry,
        clusterRegistry: clusters.registry,
        nodeRegistry: nodes.registry,
        wallets,
        outboxEntries,
        receipts,
        runbookCount: runbooks.length,
    };
}
async function quoteOrder(args) {
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, args.vendorId);
    return {
        registry,
        vendor,
        quote: quoteVendorOrder({
            registryHash: registry.payloadHash,
            vendor,
            itemId: args.itemId,
            quantity: args.quantity,
            asset: args.asset,
            fulfillmentFields: args.fulfillmentFields,
        }),
    };
}
async function evaluateVendorRisk(vendor, quote) {
    const policy = await getMerchantPolicy(vendor.id);
    return evaluateMerchantPolicy({ vendor, quote, policy });
}
async function evaluateAssetPolicy(symbol, useCase) {
    const registry = await loadAssets();
    const asset = getAsset(registry.registry, symbol);
    return {
        registry,
        policy: evaluateAssetUseCase(asset, useCase),
    };
}
function commerceSafetyForVendor(args) {
    const vendor = args.vendor;
    const description = typeof args.description === "string"
        ? args.description
        : args.description === undefined
            ? undefined
            : safeStringify(args.description);
    return commerceSafetySummary({
        query: args.query,
        vendorId: args.vendorId ?? vendor?.id,
        category: args.category ?? vendor?.category,
        service: args.service ?? args.quote?.itemName ?? args.quote?.itemId ?? vendor?.displayName ?? vendor?.serviceTags?.join(" "),
        description,
    });
}
function outboxMethod(_kind) {
    return "lyth_submitEncrypted";
}
async function submitPayload(endpoint, kind, payloadHex) {
    return rpcCall(endpoint, outboxMethod(kind), [payloadHex]);
}
function mdTable(headers, rows) {
    const escape = (value) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
    return [
        `| ${headers.map(escape).join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.map((value) => escape(value)).join(" | ")} |`),
    ].join("\n");
}
function short(value, left = 6, right = 4) {
    if (!value) {
        return "";
    }
    return value.length <= left + right + 3 ? value : `${value.slice(0, left)}...${value.slice(-right)}`;
}
function extractTxHash(input) {
    return input.match(/\b0x[0-9a-fA-F]{64}\b/)?.[0] ?? null;
}
function extractAddress(input) {
    return input.match(/\b0x[0-9a-fA-F]{40}\b/)?.[0] ?? input.match(/\bmono1[0-9a-z]+\b/)?.[0] ?? null;
}
function extractDecimal(input) {
    return input.match(/\b\d+(?:\.\d+)?\b/)?.[0];
}
function inferSymbol(input, symbols) {
    const lower = input.toLowerCase();
    return symbols.find((symbol) => new RegExp(`\\b${escapeRegex(symbol.toLowerCase())}\\b`, "i").test(lower));
}
function escapeRegex(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function askChainText(payload) {
    const sources = Array.isArray(payload.sources)
        ? payload.sources.map((source) => `- ${safeStringify(source).replace(/\n/g, " ")}`).join("\n")
        : "- None";
    return [
        "# Ask Chain",
        "",
        `Intent: ${String(payload.intent ?? "unknown")}`,
        `Typed tool: ${String(payload.typedTool ?? "none")}`,
        "",
        "## Sources",
        sources,
        "",
        "## Result",
        "```json",
        safeStringify(payload.result ?? payload),
        "```",
    ].join("\n");
}
function defaultOutboxExpiresAt() {
    return new Date(Date.now() + DEFAULT_OUTBOX_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
}
function isPast(value) {
    return Boolean(value && Date.parse(value) <= Date.now());
}
async function releaseLowValueReservation(args) {
    const entry = await getOutboxEntry(args.outboxId);
    if (!entry.lowValueReserved) {
        return {
            entry,
            released: false,
            reason: "Outbox entry did not reserve low-value allowance.",
        };
    }
    if (!entry.walletName || !entry.amount) {
        return {
            entry,
            released: false,
            reason: "Outbox entry is missing walletName or amount.",
        };
    }
    if (entry.status !== "signed") {
        return {
            entry,
            released: false,
            reason: `Only signed/not-submitted entries can be released safely; current status is ${entry.status}.`,
        };
    }
    const accounting = await moveLowValueAccounting({
        walletName: entry.walletName,
        amount: entry.amount,
        from: "reserved",
        to: args.to,
    });
    const updated = await updateOutboxStatus(args.outboxId, args.to === "expired" ? "expired" : "failed");
    const receipt = await addReceipt({
        kind: "low_value_reservation_release",
        status: args.to === "expired" ? "confirmed" : "failed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Released low-value reservation ${args.outboxId}`,
        summary: `${entry.walletName} ${entry.amount} ${entry.asset ?? "LYTH"} moved from reserved to ${args.to}`,
        walletName: entry.walletName,
        from: entry.from,
        to: entry.to,
        amount: entry.amount,
        asset: entry.asset,
        outboxId: args.outboxId,
        payloadHash: entry.payloadHash,
        result: { accounting, updated },
    });
    return {
        entry: updated,
        released: true,
        accounting,
        receipt,
        warning: "This releases the local MCP allowance reservation only. It cannot invalidate a signed payload copied elsewhere.",
    };
}
function approvalSummary(args) {
    const target = args.recipientLabel ? `${args.recipientLabel} (${args.to})` : args.to;
    return {
        title: `Send ${args.amount} ${args.asset} from ${args.walletName} to ${target}`,
        lines: [
            `Action: send ${args.amount} ${args.asset}`,
            `From: ${args.walletName} (${args.from})`,
            `To: ${target}`,
            args.feeCeiling ? `Fee ceiling: ${args.feeCeiling} ${args.asset}` : null,
            args.remainingAfterCeiling ? `Balance after fee ceiling: ${args.remainingAfterCeiling} ${args.asset}` : null,
            args.lowValueRemaining ? `Low-value cap remaining after reservation: ${args.lowValueRemaining} ${args.asset}` : null,
            `Preflight: ${args.preflightOk ? "pass" : "fail"}`,
            args.violations.length ? `Violations: ${args.violations.join("; ")}` : null,
            args.warnings.length ? `Warnings: ${args.warnings.join("; ")}` : null,
        ].filter((line) => line !== null),
        approvalRequired: true,
        risk: "Review recipient, amount, fee ceiling, and cap impact before signing. Low-value mode is a capped hot-wallet mode.",
    };
}
async function txStatusSummary(args) {
    const outbox = args.outboxId ? await getOutboxEntry(args.outboxId) : null;
    const txHash = args.txHash ?? outbox?.txHash;
    if (!txHash) {
        return {
            outbox,
            status: outbox?.status ?? "not_found",
            reason: "No tx hash is available yet. The payload may be signed but not submitted.",
        };
    }
    const endpoint = await firstReachableEndpoint();
    const [status, receipt, tx] = await Promise.allSettled([
        rpcCall(endpoint, "lyth_txStatus", [txHash]),
        rpcCall(endpoint, "eth_getTransactionReceipt", [txHash]),
        rpcCall(endpoint, "eth_getTransactionByHash", [txHash]),
    ]);
    let derived = "submitted";
    let lowValueAccounting = null;
    if (receipt.status === "fulfilled" && receipt.value) {
        const receiptObject = receipt.value;
        derived = receiptObject?.status === "0x0" ? "failed" : "confirmed";
        if (outbox) {
            await updateOutboxStatus(outbox.id, derived, txHash);
            if (outbox.lowValueReserved && outbox.walletName && outbox.amount && outbox.status === "submitted") {
                lowValueAccounting = await moveLowValueAccounting({
                    walletName: outbox.walletName,
                    amount: outbox.amount,
                    from: "submitted",
                    to: derived === "confirmed" ? "confirmed" : "failed",
                });
            }
        }
    }
    else if (tx.status === "fulfilled" && tx.value === null) {
        derived = "not_found";
    }
    return {
        endpoint,
        txHash,
        outbox,
        derived,
        lowValueAccounting,
        status: status.status === "fulfilled" ? status.value : { error: status.reason?.message ?? String(status.reason) },
        receipt: receipt.status === "fulfilled" ? receipt.value : { error: receipt.reason?.message ?? String(receipt.reason) },
        transaction: tx.status === "fulfilled" ? tx.value : { error: tx.reason?.message ?? String(tx.reason) },
    };
}
async function preflightTransfer(args) {
    const violations = [];
    const warnings = [];
    const checks = {};
    const endpointHealth = await scoreEndpoint(args.endpoint);
    checks.endpoint = endpointHealth;
    if (!endpointHealth.ok) {
        violations.push(`RPC endpoint is not healthy for chain ${CHAIN_ID}`);
    }
    if (args.sign && !endpointHealth.writeReady) {
        violations.push("RPC endpoint is not write-ready for encrypted signing/submission");
    }
    if (!isWireAddress(args.to)) {
        violations.push("recipient must be a 0x wire address");
    }
    const [chainIdResult, balanceResult, nonceResult, encryptionResult] = await Promise.allSettled([
        rpcCall(args.endpoint, "eth_chainId", []),
        rpcCall(args.endpoint, "eth_getBalance", [args.from, "latest"]),
        rpcCall(args.endpoint, "eth_getTransactionCount", [args.from, "latest"]),
        args.sign ? rpcCall(args.endpoint, "lyth_getEncryptionKey", []) : Promise.resolve(null),
    ]);
    if (chainIdResult.status === "fulfilled") {
        const liveChainId = parseQuantity(chainIdResult.value);
        checks.chainId = liveChainId.toString();
        if (liveChainId !== BigInt(CHAIN_ID)) {
            violations.push(`chain id mismatch: expected ${CHAIN_ID}, got ${liveChainId.toString()}`);
        }
    }
    else {
        violations.push(`chain id check failed: ${chainIdResult.reason?.message ?? String(chainIdResult.reason)}`);
    }
    if (balanceResult.status === "fulfilled") {
        const balance = parseQuantity(balanceResult.value);
        const feeCeiling = args.gasLimit * args.maxFeePerGas;
        const required = args.amountUnits + feeCeiling;
        checks.balance = {
            balance: unitsToDecimal(balance),
            amount: args.amount,
            estimatedFeeCeiling: unitsToDecimal(feeCeiling),
            required: unitsToDecimal(required),
            remainingAfterCeiling: balance >= required ? unitsToDecimal(balance - required) : "0",
        };
        if (balance < required) {
            violations.push(`balance ${unitsToDecimal(balance)} LYTH is below amount + fee ceiling ${unitsToDecimal(required)} LYTH`);
        }
    }
    else {
        violations.push(`balance check failed: ${balanceResult.reason?.message ?? String(balanceResult.reason)}`);
    }
    if (nonceResult.status === "fulfilled") {
        const liveNonce = parseQuantity(nonceResult.value);
        checks.nonce = {
            live: liveNonce.toString(),
            requested: args.nonce?.toString() ?? liveNonce.toString(),
        };
        if (args.nonce !== undefined && args.nonce < liveNonce) {
            violations.push(`nonce ${args.nonce.toString()} is lower than live nonce ${liveNonce.toString()}`);
        }
        if (args.nonce !== undefined && args.nonce > liveNonce) {
            warnings.push(`nonce ${args.nonce.toString()} is higher than live nonce ${liveNonce.toString()}; transaction may wait for earlier nonce`);
        }
    }
    else {
        violations.push(`nonce check failed: ${nonceResult.reason?.message ?? String(nonceResult.reason)}`);
    }
    if (args.sign && encryptionResult.status !== "fulfilled") {
        violations.push(`encryption key check failed: ${encryptionResult.reason?.message ?? String(encryptionResult.reason)}`);
    }
    const wallet = (await listWallets()).find((item) => item.name === args.walletName);
    if (!wallet) {
        violations.push(`wallet '${args.walletName}' not found`);
    }
    else {
        checks.wallet = compactWallet(wallet);
        const agent = wallet.agent;
        if (agent?.paused && !args.allowPausedAgent) {
            violations.push(`agent wallet '${args.walletName}' is paused`);
        }
        if (agent?.expiresAt && Date.parse(agent.expiresAt) < Date.now()) {
            violations.push(`agent wallet '${args.walletName}' expired at ${agent.expiresAt}`);
        }
        if (agent?.maxBalance && balanceResult.status === "fulfilled") {
            const balance = parseQuantity(balanceResult.value);
            if (balance > decimalToUnits(agent.maxBalance)) {
                warnings.push(`wallet balance exceeds configured maxBalance ${agent.maxBalance} LYTH`);
            }
        }
        if (args.sign && !args.passphrase && args.allowLowValueSigning) {
            const low = wallet.lowValue;
            if (!low?.enabled) {
                warnings.push("low-value signing is not enabled; signing will require passphrase/local-key permission");
            }
            else {
                if (low.maxAmount && args.amountUnits > decimalToUnits(low.maxAmount)) {
                    violations.push(`amount exceeds low-value maxAmount ${low.maxAmount} LYTH`);
                }
                if (low.accounting?.remainingToday && args.amountUnits > decimalToUnits(low.accounting.remainingToday)) {
                    violations.push(`amount exceeds low-value remaining daily allowance ${low.accounting.remainingToday} LYTH`);
                }
            }
        }
    }
    return {
        ok: violations.length === 0,
        network: NETWORK,
        chainId: CHAIN_ID,
        endpoint: args.endpoint,
        walletName: args.walletName,
        from: args.from,
        to: args.to,
        amount: args.amount,
        gasLimit: args.gasLimit.toString(),
        maxFeePerGas: args.maxFeePerGas.toString(),
        checkedAt: new Date().toISOString(),
        violations,
        warnings,
        checks,
    };
}
const runbookEnum = z.enum([
    "request_funds",
    "pay_vendor",
    "book_service",
    "open_escrow",
    "place_trade",
    "set_spending_policy",
    "revoke_agent_permission",
    "verify_receipt",
    "rate_vendor",
]);
const outboxStatusEnum = z.enum(["signed", "submitted", "confirmed", "failed", "expired"]);
const receiptStatusEnum = z.enum(["drafted", "signed", "submitted", "confirmed", "failed"]);
const orderStatusEnum = z.enum(["created", "payment_prepared", "paid", "fulfillment_requested", "fulfilled_demo", "fulfilled_manual", "cancelled"]);
const bookingStatusEnum = z.enum(["requested", "provider_requested", "accepted_demo", "escrow_prepared", "paid", "completed_demo", "cancelled", "disputed_demo"]);
const invoiceStatusEnum = z.enum(["open", "paid", "cancelled", "expired"]);
const bridgeStatusEnum = z.enum(["active", "draft", "degraded", "paused"]);
const bridgeRouteTypeEnum = z.enum(["chainlink_ccip"]);
const clusterStatusEnum = z.enum(["active", "draft", "degraded", "sunsetting", "retired"]);
const clusterServiceTypeEnum = z.enum(["rpc", "archive", "prover", "oracle", "indexer", "validator"]);
const delegationPhaseEnum = z.enum(["bootstrap", "growth", "mature"]);
const delegationModeEnum = z.enum(["max_yield", "max_diversity", "max_decentralization", "custom"]);
const nodeRoleEnum = z.enum(["validator", "rpc", "archive", "prover", "oracle", "indexer"]);
const nodeStatusEnum = z.enum(["active", "draft", "degraded", "paused", "retired"]);
const nodeHostingClassEnum = z.enum(["community_baremetal", "cloud_dedicated", "cloud_shared", "cloud_gpu", "planned_mixed"]);
const attestationStatusEnum = z.enum(["verified", "draft", "missing", "expired", "mismatch"]);
const readinessGateEnum = z.enum(["no_evm", "mrc", "agent_commerce", "bridge", "wallet", "runbook", "security", "docs", "tests", "all"]);
const recoveryRunbookKindEnum = z.enum(["pause_agent", "drain_agent", "delete_local_wallet", "release_stale_outbox", "rotate_emergency_key"]);
const demoConnectorKindEnum = z.enum(["stripe", "coinsbee", "travel", "food", "service_provider", "agent_commerce_protocol", "universal_commerce_protocol"]);
const assetKindEnum = z.enum(["native", "private_native", "wrapped", "issuer_native", "mrc20", "nft", "vault"]);
const assetStatusEnum = z.enum(["active", "draft", "deprecated", "blocked"]);
const assetDenominationEnum = z.enum(["public", "private", "external"]);
const assetUseCaseEnum = z.enum([
    "transfer",
    "commerce",
    "service_payment",
    "escrow",
    "bridge",
    "staking",
    "contract",
    "market",
    "discovery",
    "issuer_registration",
    "private_transfer",
    "private_burn",
    "cross_to_private",
    "view",
]);
const recordSchema = z.record(z.unknown()).optional();
const delegationPositionsSchema = z.array(z.object({
    clusterId: z.string().min(1),
    amount: z.string().min(1),
})).optional();
const policySchema = z.object({
    maxAmount: z.string().optional(),
    assetAllowlist: z.array(z.string()).optional(),
    vendorAllowlist: z.array(z.string()).optional(),
    categoryAllowlist: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    requireHumanApproval: z.boolean().optional(),
}).optional();
const server = new McpServer({
    name: "lyth-mcp",
    version: "0.1.0",
});
const MCP_TOOL_NAMES = [
    "chain_status",
    "rpc_health",
    "mcp_self_check",
    "account_overview",
    "recent_transactions",
    "tx_lookup",
    "tx_error_explain",
    "ask_chain",
    "tx_status_summary",
    "tx_watch",
    "search_chain",
    "markets",
    "mcp_dashboard",
    "list_runbooks",
    "runbook_list",
    "runbook_get",
    "runbook_verify",
    "runbook_diff_versions",
    "draft_runbook",
    "validate_runbook",
    "prepare_wallet_request",
    "wallet_funding_address",
    "wallet_setup",
    "wallet_import",
    "wallet_list",
    "wallet_preflight_transfer",
    "wallet_approval_summary",
    "wallet_build_transfer",
    "wallet_safety_profile",
    "hot_wallet_policy_simulate",
    "wallet_threshold_explain",
    "agent_wallet_create",
    "agent_wallet_fund_request",
    "agent_wallet_limits",
    "agent_wallet_pause",
    "agent_wallet_drain",
    "agent_wallet_delete",
    "nowpayments_configure",
    "nowpayments_status",
    "nowpayments_currencies",
    "nowpayments_merchant_coins",
    "nowpayments_estimate",
    "nowpayments_payment_create",
    "nowpayments_invoice_create",
    "nowpayments_payment_status",
    "nowpayments_payment_list",
    "nowpayments_refund_draft",
    "nowpayments_ipn_verify",
    "nowpayments_config_redacted",
    "changenow_configure",
    "changenow_status",
    "changenow_currencies",
    "changenow_min_amount",
    "changenow_estimate",
    "changenow_swap_create",
    "changenow_swap_status",
    "changenow_swap_list",
    "changenow_fiat_estimate",
    "changenow_fiat_sell_draft",
    "changenow_config_redacted",
    "travala_info",
    "travala_proxy_call",
    "travala_book_recover",
    "coinsbee_guide",
    "coinsbee_via_nowpayments_track",
    "profile_create",
    "profile_update",
    "profile_list",
    "profile_get",
    "profile_reveal",
    "profile_delete",
    "profile_store_info",
    "duffel_configure",
    "duffel_config_redacted",
    "flight_search",
    "flight_offer_get",
    "flight_seat_maps",
    "flight_order_create_hold",
    "flight_order_create_instant",
    "flight_order_get",
    "flight_order_list",
    "flight_order_pay",
    "flight_order_cancel",
    "flight_order_cancel_confirm",
    "flight_ota_nowpayments_track",
    "travala_flight_capability_probe",
    "vendor_search",
    "provider_onboarding_draft",
    "order_create",
    "booking_request_create",
    "invoice_create",
    "funding_request_create",
    "connector_set",
    "merchant_risk_check",
    "asset_registry_info",
    "asset_search",
    "asset_risk_label",
    "privacy_policy_check",
    "contract_path_guidance",
    "bridge_routes",
    "bridge_route_get",
    "bridge_quote",
    "bridge_cooldown_matrix",
    "bridge_status_summary",
    "bridge_circuit_breaker_watch",
    "liquidity_onboarding",
    "security_status",
    "emergency_state_watch",
    "bridge_blast_radius",
    "recovery_status",
    "recovery_runbook_draft",
    "audit_gate_dashboard",
    "readiness_check",
    "demo_connector_templates",
    "demo_connector_get",
    "demo_connector_draft",
];
server.tool("chain_status", "Probe Monolythium live RPC endpoints and return chain/indexer/mempool status.", {}, async () => {
    const probes = await Promise.all(CONFIGURED_RPCS.map(probeEndpoint));
    const endpoint = await firstReachableEndpoint();
    const [stats, round, mempool, indexer, sync] = await Promise.allSettled([
        rpcCall(endpoint, "lyth_chainStats"),
        rpcCall(endpoint, "lyth_currentRound"),
        rpcCall(endpoint, "lyth_mempoolStatus"),
        rpcCall(endpoint, "lyth_indexerStatus"),
        rpcCall(endpoint, "lyth_syncStatus"),
    ]);
    return text({
        network: NETWORK,
        chainId: CHAIN_ID,
        selectedEndpoint: endpoint,
        apiBase: apiBaseFromRpc(endpoint),
        submitEnabled: SUBMIT_ENABLED,
        probes,
        stats: stats.status === "fulfilled" ? stats.value : { error: stats.reason?.message ?? String(stats.reason) },
        round: round.status === "fulfilled" ? round.value : { error: round.reason?.message ?? String(round.reason) },
        mempool: mempool.status === "fulfilled" ? mempool.value : { error: mempool.reason?.message ?? String(mempool.reason) },
        indexer: indexer.status === "fulfilled" ? indexer.value : { error: indexer.reason?.message ?? String(indexer.reason) },
        sync: sync.status === "fulfilled" ? sync.value : { error: sync.reason?.message ?? String(sync.reason) },
    });
});
server.tool("rpc_health", "Score configured Monolythium RPC endpoints for read/write readiness.", {}, async () => {
    return text(await rpcHealth());
});
server.tool("mcp_self_check", "Check MCP install, config, stores, and RPC reachability.", {}, async () => {
    const health = await rpcHealth();
    return text({
        ok: Boolean(health.selectedRead),
        checkedAt: new Date().toISOString(),
        package: {
            name: "lyth-mcp",
            version: "0.1.0",
            root: PACKAGE_ROOT,
        },
        network: NETWORK,
        chainId: CHAIN_ID,
        submitEnabled: SUBMIT_ENABLED,
        rpc: {
            configured: CONFIGURED_RPCS,
            selectedRead: health.selectedRead,
            selectedWrite: health.selectedWrite,
            endpoints: health.endpoints,
        },
        stores: {
            wallet: await walletStoreInfo(),
            addressbook: await addressbookInfo(),
            outbox: await outboxInfo(),
            receipts: await receiptInfo(),
            connectors: await connectorStoreInfo(),
            orders: await orderStoreInfo(),
            bookings: await bookingStoreInfo(),
            invoices: await invoiceStoreInfo(),
            merchantPolicies: await merchantPolicyStoreInfo(),
            vendorRegistry: VENDOR_REGISTRY_PATH,
            assetRegistry: ASSET_REGISTRY_PATH,
            bridgeRouteRegistry: BRIDGE_ROUTE_REGISTRY_PATH,
            runbookRegistry: RUNBOOK_REGISTRY_PATH,
        },
        guidance: [
            SUBMIT_ENABLED
                ? "Broadcasting is enabled; signed payloads can be submitted."
                : "Broadcasting is disabled; signed payloads are stored in the outbox and can be retried after LYTH_MCP_ENABLE_SUBMIT=1.",
            "Use explicit agent wallets only for capped operating budgets.",
            "Use wallet handoff/passphrase approval for high-value funds.",
        ],
    });
});
server.tool("security_status", "Render the MCP-local security dashboard: RPC/mempool posture, Ferveo TODO, Chainlink CCIP bridge posture, oracle metadata, RISC-V VM gate, wallet hot mode, and outbox pressure.", {
    includeRpc: z.boolean().optional().describe("Probe live RPC health. Default true."),
}, async ({ includeRpc }) => text(securityStatus(await buildSecurityContext({ includeRpc: includeRpc !== false }))));
server.tool("emergency_state_watch", "Watch local emergency signals: RPC write readiness, bridge circuit breakers, stale signed payloads, broadcast-failure spikes, and TODO(mainnet) G3 emergency-state gap.", {
    includeRpc: z.boolean().optional().describe("Probe live RPC health. Default true."),
}, async ({ includeRpc }) => {
    const result = emergencyStateWatch(await buildSecurityContext({ includeRpc: includeRpc !== false }));
    return result.severity === "critical" ? errorJson(result) : text(result);
});
server.tool("bridge_blast_radius", "Summarize affected bridge routes, local in-flight bridge/swap receipts, signed bridge payloads, and freeze recommendations.", {
    asset: z.string().optional(),
    includeDraftRoutes: z.boolean().optional().describe("Include draft/degraded/paused routes. Default true."),
}, async ({ asset, includeDraftRoutes }) => {
    const result = bridgeBlastRadiusMonitor(await buildSecurityContext({ includeRpc: false }), { asset, includeDraftRoutes });
    return result.severity === "critical" ? errorJson(result) : text(result);
});
server.tool("recovery_status", "Show local account recovery posture and available recovery runbooks for agent wallets.", {
    walletName: z.string().optional(),
}, async ({ walletName }) => text(recoveryStatus(await buildSecurityContext({ includeRpc: false }), walletName)));
server.tool("recovery_runbook_draft", "Draft a local recovery runbook for pausing, draining, deleting a wallet, releasing stale outbox allowance, or future emergency-key rotation.", {
    kind: recoveryRunbookKindEnum,
    walletName: z.string().optional(),
    outboxId: z.string().optional(),
    reason: z.string().optional(),
}, async (args) => text(recoveryRunbookDraft(args)));
server.tool("audit_gate_dashboard", "Show local audit/research gate status for zkML verifier, Rust/RISC-V VM, MRC standards, EVM retirement, Chainlink CCIP, Ferveo, oracle, and DAG sync.", {}, async () => text(auditResearchGateDashboard(await buildSecurityContext({ includeRpc: false }))));
server.tool("readiness_check", "Show MCP mainnet-readiness gates: no-EVM, MRC, agent-commerce, bridge, wallet, runbook, security, docs, and tests.", {
    gate: readinessGateEnum.optional(),
}, async ({ gate }) => {
    const [vendors, assets, bridges, runbooks, wallets] = await Promise.all([
        loadVendors(),
        loadAssets(),
        loadBridgeRoutes(),
        listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH),
        listWallets(),
    ]);
    return text(readinessCheck({
        toolNames: MCP_TOOL_NAMES,
        runbookCount: runbooks.length,
        vendorCount: vendors.registry.vendors.length,
        bridgeRouteCount: bridges.registry.routes.length,
        activeBridgeRouteCount: bridges.registry.routes.filter((route) => route.status === "active").length,
        assetCount: assets.registry.assets.length,
        walletCount: wallets.length,
        docsUpdated: true,
        testsUpdated: true,
    }, gate));
});
server.tool("wallet_safety_profile", "Show account safety profile: key protection, hot-wallet caps, agent metadata, pending signed payloads, recovery path, and missing production wallet/core signals.", {
    walletName: z.string().optional(),
}, async ({ walletName }) => text(accountSafetyProfiles({
    wallets: await listWallets(),
    outboxEntries: await listOutboxEntries({ walletName, limit: 250 }),
    receipts: await listReceipts({ walletName, limit: 250 }),
    walletName,
})));
server.tool("hot_wallet_policy_simulate", "Simulate whether a proposed small spend would pass the local agent hot-wallet policy right now.", {
    walletName: z.string().min(1),
    amount: z.string().min(1),
    asset: z.string().optional(),
    counterparty: z.string().optional().describe("Optional exact 0x address, contact name, or vendor id to compare with wallet allowlist."),
    category: z.string().optional(),
}, async ({ walletName, amount, asset, counterparty, category }) => {
    const wallet = (await listWallets()).find((item) => item.name === walletName);
    if (!wallet) {
        return errorText(`wallet '${walletName}' not found`);
    }
    const result = simulateHotWalletPolicy({ wallet, amount, asset, counterparty, category });
    return result.ok ? text(result) : errorJson(result);
});
server.tool("wallet_threshold_explain", "Explain when an agent hot wallet, passkey/wallet handoff, or full-key/hardware approval should be used for a spend.", {
    amount: z.string().optional(),
    asset: z.string().optional(),
    lowValueCap: z.string().optional(),
    passkeyCap: z.string().optional(),
    hardwareCap: z.string().optional(),
    walletHasLowValuePolicy: z.boolean().optional(),
    passkeyAvailable: z.boolean().optional(),
    hardwareWalletAvailable: z.boolean().optional(),
}, async (args) => text(explainWalletThresholds(args)));
server.tool("demo_connector_templates", "List clearly marked TODO/demo connector templates for Stripe, Coinsbee, travel, food, service providers, ACP, and UCP.", {
    kind: demoConnectorKindEnum.optional(),
    category: z.string().optional(),
}, async ({ kind, category }) => text({
    warning: "These are TODO/demo stubs only. They do not authorize real external commerce integrations.",
    templates: listDemoConnectorTemplates({ kind: kind, category }),
}));
server.tool("demo_connector_get", "Get one TODO/demo connector template with payload shape, required fields, safety notes, and implementation todos.", {
    templateId: z.string().min(1),
}, async ({ templateId }) => text(getDemoConnectorTemplate(templateId)));
server.tool("demo_connector_draft", "Draft a disabled connector_set payload from a TODO/demo connector template.", {
    templateId: z.string().min(1),
    vendorId: z.string().optional(),
    endpoint: z.string().url().optional(),
    authMode: z.enum(["bearer", "header", "hmac_sha256"]).optional(),
}, async (args) => text(demoConnectorDraft(args)));
server.tool("wallet_funding_address", "Create or return a local testnet agent wallet address for funding. If missing, creates a local-machine encrypted wallet with capped low-value signing.", {
    name: z.string().min(1).optional().describe("Local wallet name. Default agent-main."),
    createIfMissing: z.boolean().optional().describe("Create the wallet if it does not exist. Default true."),
    lowValueMaxAmount: z.string().optional().describe(`Max LYTH per no-passphrase transaction. Default ${DEFAULT_LOW_VALUE_MAX}.`),
    lowValueDailyLimit: z.string().optional().describe(`Daily LYTH cap for no-passphrase signing. Default ${DEFAULT_LOW_VALUE_DAILY_LIMIT}.`),
}, async ({ name, createIfMissing, lowValueMaxAmount, lowValueDailyLimit }) => {
    const walletName = name ?? "agent-main";
    const existing = (await listWallets()).find((wallet) => wallet.name === walletName);
    if (existing) {
        return text({
            created: false,
            wallet: compactWallet(existing),
            fundingAddress: existing.address,
            network: NETWORK,
            chainId: CHAIN_ID,
            warning: "This is a local MCP wallet address. Fund it only with testnet or capped agent funds.",
        });
    }
    if (createIfMissing === false) {
        return errorText(`wallet '${walletName}' not found`);
    }
    const wallet = await createWallet({
        name: walletName,
        allowLocalKey: true,
        lowValue: {
            enabled: true,
            maxAmount: lowValueMaxAmount ?? DEFAULT_LOW_VALUE_MAX,
            dailyLimit: lowValueDailyLimit ?? DEFAULT_LOW_VALUE_DAILY_LIMIT,
        },
    });
    return text({
        created: true,
        wallet: compactWallet(wallet),
        fundingAddress: wallet.address,
        network: NETWORK,
        chainId: CHAIN_ID,
        warning: "Created a local-machine encrypted agent wallet. It can sign only within the configured low-value cap without a passphrase.",
    });
});
server.tool("wallet_setup", "Create and store a local encrypted agent wallet. With no passphrase, creates a local-machine protected low-value wallet for testnet agent funding.", {
    name: z.string().min(1).describe("Local wallet name, e.g. agent-main."),
    passphrase: z.string().min(12).optional().describe("Encryption passphrase. If omitted, a local machine key is used and low-value mode defaults on."),
    revealMnemonic: z.boolean().optional().describe("Return the generated 24-word PQM-1 mnemonic once. Default false."),
    overwrite: z.boolean().optional().describe("Replace an existing wallet with the same name."),
    lowValueNoPassphrase: z.boolean().optional().describe("Enable local hot mode for capped low-value spends. Defaults true when passphrase is omitted."),
    lowValueMaxAmount: z.string().optional().describe(`Max LYTH per transaction for no-passphrase signing. Default ${DEFAULT_LOW_VALUE_MAX} in local-key mode.`),
    lowValueDailyLimit: z.string().optional().describe(`Optional daily LYTH cap for no-passphrase signing. Default ${DEFAULT_LOW_VALUE_DAILY_LIMIT} in local-key mode.`),
}, async ({ name, passphrase, revealMnemonic, overwrite, lowValueNoPassphrase, lowValueMaxAmount, lowValueDailyLimit }) => {
    const hasPassphrase = Boolean(passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE);
    const useLocalKey = !hasPassphrase && lowValueNoPassphrase !== false;
    const enableLowValue = lowValueNoPassphrase ?? useLocalKey;
    const wallet = await createWallet({
        name,
        passphrase,
        revealMnemonic,
        overwrite,
        allowLocalKey: useLocalKey,
        lowValue: enableLowValue
            ? {
                enabled: true,
                maxAmount: lowValueMaxAmount ?? DEFAULT_LOW_VALUE_MAX,
                dailyLimit: lowValueDailyLimit ?? (useLocalKey ? DEFAULT_LOW_VALUE_DAILY_LIMIT : undefined),
            }
            : undefined,
    });
    return text({
        wallet: compactWallet(wallet),
        fundingAddress: wallet.address,
        warning: enableLowValue
            ? "Low-value mode is a local hot-wallet mode. Keep only capped funds in this agent wallet."
            : "Wallet is encrypted. Signing requires passphrase or later low-value setup.",
    });
});
server.tool("wallet_import", "Import an existing PQM-1 mnemonic into the local encrypted wallet store.", {
    name: z.string().min(1),
    mnemonic: z.string().describe("24-word PQM-1 mnemonic."),
    passphrase: z.string().min(12).optional(),
    overwrite: z.boolean().optional(),
    lowValueNoPassphrase: z.boolean().optional(),
    lowValueMaxAmount: z.string().optional(),
    lowValueDailyLimit: z.string().optional(),
}, async ({ name, mnemonic, passphrase, overwrite, lowValueNoPassphrase, lowValueMaxAmount, lowValueDailyLimit }) => {
    const hasPassphrase = Boolean(passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE);
    const useLocalKey = !hasPassphrase && lowValueNoPassphrase === true;
    return text(await importWallet({
        name,
        mnemonic,
        passphrase,
        overwrite,
        allowLocalKey: useLocalKey,
        lowValue: lowValueNoPassphrase
            ? {
                enabled: true,
                maxAmount: lowValueMaxAmount ?? DEFAULT_LOW_VALUE_MAX,
                dailyLimit: lowValueDailyLimit,
            }
            : undefined,
    }));
});
server.tool("wallet_list", "List local MCP wallets and low-value signing policy status.", {}, async () => {
    return text({
        store: await walletStoreInfo(),
        wallets: await listWallets(),
    });
});
server.tool("wallet_low_value_accounting", "Show per-wallet low-value allowance buckets: reserved, submitted, confirmed, failed, and expired.", {
    name: z.string().optional().describe("Wallet name. Omit to list all low-value wallets."),
}, async ({ name }) => {
    const wallets = await listWallets();
    const filtered = name ? wallets.filter((wallet) => wallet.name === name) : wallets;
    if (name && filtered.length === 0) {
        return errorText(`wallet '${name}' not found`);
    }
    return text({
        wallets: filtered.map((wallet) => ({
            name: wallet.name,
            address: wallet.address,
            lowValue: wallet.lowValue ?? null,
        })),
        note: "reserved means signed but not yet submitted; submitted means broadcast accepted; confirmed/failed update after tx_status_summary or tx_watch observes a receipt.",
    });
});
server.tool("wallet_preflight_transfer", "Run transfer safety checks before signing: chain id, balance, nonce, RPC write health, encryption key, and local policy.", {
    walletName: z.string().min(1),
    to: z.string().describe("0x recipient address or exact addressbook contact name."),
    amount: z.string().describe("LYTH amount, e.g. 1.5."),
    passphrase: z.string().min(12).optional(),
    sign: z.boolean().optional().describe("Whether the caller intends to sign. Default true."),
    allowLowValueSigning: z.boolean().optional().describe("Whether low-value signing may be used. Default true."),
    gasLimit: z.string().optional().describe("Hex or decimal gas limit. Default 21000."),
    maxFeePerGas: z.string().optional().describe("Hex or decimal fee. Defaults to eth_gasPrice or 1 gwei fallback."),
    nonce: z.string().optional().describe("Hex or decimal nonce. Defaults to live eth_getTransactionCount."),
}, async ({ walletName, to, amount, passphrase, sign, allowLowValueSigning, gasLimit, maxFeePerGas, nonce }) => {
    const recipient = await resolveRecipient(to);
    if (!recipient) {
        return errorJson({ ok: false, violations: ["to must be a 0x wire address or exact addressbook contact name"] });
    }
    const shouldSign = sign ?? true;
    const endpoint = shouldSign ? await firstWritableEndpoint() : await firstReachableEndpoint();
    const wallet = (await listWallets()).find((item) => item.name === walletName);
    if (!wallet) {
        return errorJson({ ok: false, violations: [`wallet '${walletName}' not found`] });
    }
    let fee = maxFeePerGas ? parseFlexibleBigint(maxFeePerGas) : 1000000000n;
    if (!maxFeePerGas) {
        try {
            fee = parseQuantity(await rpcCall(endpoint, "eth_gasPrice", []));
        }
        catch {
            fee = 1000000000n;
        }
    }
    const resolvedNonce = nonce
        ? parseFlexibleBigint(nonce)
        : parseQuantity(await rpcCall(endpoint, "eth_getTransactionCount", [wallet.address, "latest"]));
    const preflight = await preflightTransfer({
        endpoint,
        walletName,
        from: wallet.address,
        to: recipient.address,
        amount,
        amountUnits: decimalToUnits(amount),
        gasLimit: gasLimit ? parseFlexibleBigint(gasLimit) : 21000n,
        maxFeePerGas: fee,
        nonce: resolvedNonce,
        sign: shouldSign,
        allowLowValueSigning: shouldSign ? allowLowValueSigning ?? true : false,
        passphrase,
    });
    const balance = preflight.checks.balance;
    const lowValue = preflight.checks.wallet?.lowValue;
    const summary = approvalSummary({
        walletName,
        from: wallet.address,
        to: recipient.address,
        recipientLabel: recipient.contact?.name,
        amount,
        asset: "LYTH",
        feeCeiling: balance?.estimatedFeeCeiling,
        remainingAfterCeiling: balance?.remainingAfterCeiling,
        lowValueRemaining: lowValue?.accounting?.remainingToday,
        preflightOk: preflight.ok,
        violations: preflight.violations,
        warnings: preflight.warnings,
    });
    return preflight.ok ? text({ recipient, summary, preflight }) : errorJson({ recipient, summary, preflight });
});
server.tool("wallet_approval_summary", "Render a human-readable approval summary for a planned LYTH transfer without signing.", {
    walletName: z.string().min(1),
    to: z.string().describe("0x recipient address or exact addressbook contact name."),
    amount: z.string().describe("LYTH amount, e.g. 1.5."),
    gasLimit: z.string().optional().describe("Hex or decimal gas limit. Default 21000."),
    maxFeePerGas: z.string().optional().describe("Hex or decimal fee. Defaults to eth_gasPrice or 1 gwei fallback."),
}, async ({ walletName, to, amount, gasLimit, maxFeePerGas }) => {
    const recipient = await resolveRecipient(to);
    if (!recipient) {
        return errorJson({ ok: false, violations: ["to must be a 0x wire address or exact addressbook contact name"] });
    }
    const endpoint = await firstReachableEndpoint();
    const wallet = (await listWallets()).find((item) => item.name === walletName);
    if (!wallet) {
        return errorJson({ ok: false, violations: [`wallet '${walletName}' not found`] });
    }
    let fee = maxFeePerGas ? parseFlexibleBigint(maxFeePerGas) : 1000000000n;
    if (!maxFeePerGas) {
        try {
            fee = parseQuantity(await rpcCall(endpoint, "eth_gasPrice", []));
        }
        catch {
            fee = 1000000000n;
        }
    }
    const preflight = await preflightTransfer({
        endpoint,
        walletName,
        from: wallet.address,
        to: recipient.address,
        amount,
        amountUnits: decimalToUnits(amount),
        gasLimit: gasLimit ? parseFlexibleBigint(gasLimit) : 21000n,
        maxFeePerGas: fee,
        sign: false,
        allowLowValueSigning: false,
    });
    const balance = preflight.checks.balance;
    const lowValue = preflight.checks.wallet?.lowValue;
    return text({
        recipient,
        summary: approvalSummary({
            walletName,
            from: wallet.address,
            to: recipient.address,
            recipientLabel: recipient.contact?.name,
            amount,
            asset: "LYTH",
            feeCeiling: balance?.estimatedFeeCeiling,
            remainingAfterCeiling: balance?.remainingAfterCeiling,
            lowValueRemaining: lowValue?.accounting?.remainingToday,
            preflightOk: preflight.ok,
            violations: preflight.violations,
            warnings: preflight.warnings,
        }),
        preflight,
    });
});
server.tool("agent_wallet_create", "Create an explicit low-value agent operating wallet with user-approved purpose and caps.", {
    name: z.string().min(1).describe("Local agent wallet name, e.g. pizza-agent."),
    purpose: z.string().min(1).describe("What the agent wallet is allowed to be used for."),
    confirm: z.literal("CREATE_AGENT_WALLET").describe("Required explicit confirmation."),
    maxBalance: z.string().optional().describe("Recommended max balance to keep in the wallet."),
    lowValueMaxAmount: z.string().optional().describe(`Max LYTH per local no-passphrase transaction. Default ${DEFAULT_LOW_VALUE_MAX}.`),
    lowValueDailyLimit: z.string().optional().describe(`Daily LYTH cap. Default ${DEFAULT_LOW_VALUE_DAILY_LIMIT}.`),
    allowedCounterparties: z.array(z.string()).optional().describe("Optional contact names or 0x addresses this wallet should prefer."),
    allowedCategories: z.array(z.string()).optional().describe("Optional categories such as food, travel, legal."),
    expiresAt: z.string().optional().describe("Optional ISO expiry for this operating wallet."),
    fallbackApproval: z.enum(["passphrase", "wallet_handoff", "deny"]).optional().describe("What to do when a request exceeds limits."),
    revealMnemonic: z.boolean().optional().describe("Return the generated mnemonic once. Default false."),
    overwrite: z.boolean().optional(),
}, async ({ name, purpose, maxBalance, lowValueMaxAmount, lowValueDailyLimit, allowedCounterparties, allowedCategories, expiresAt, fallbackApproval, revealMnemonic, overwrite }) => {
    const wallet = await createWallet({
        name,
        revealMnemonic,
        overwrite,
        allowLocalKey: true,
        lowValue: {
            enabled: true,
            maxAmount: lowValueMaxAmount ?? DEFAULT_LOW_VALUE_MAX,
            dailyLimit: lowValueDailyLimit ?? DEFAULT_LOW_VALUE_DAILY_LIMIT,
        },
        agent: {
            purpose,
            network: NETWORK,
            maxBalance,
            allowedCounterparties,
            allowedCategories,
            expiresAt,
            fallbackApproval: fallbackApproval ?? "wallet_handoff",
            paused: false,
        },
    });
    const receipt = await addReceipt({
        kind: "agent_wallet_create",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Created agent wallet ${name}`,
        summary: `${name} (${wallet.address}) for ${purpose}`,
        walletName: name,
        from: wallet.address,
        result: compactWallet(wallet),
    });
    return text({
        wallet: compactWallet(wallet),
        fundingAddress: wallet.address,
        receipt,
        warning: "This is an explicitly authorized low-value agent hot wallet. Fund it only with the operating budget approved for this purpose.",
    });
});
server.tool("agent_wallet_fund_request", "Draft a human-readable request to fund an agent wallet for a bounded task.", {
    name: z.string().min(1),
    amount: z.string().describe("Requested amount."),
    asset: z.string().optional().describe("Asset symbol. Default LYTH."),
    purpose: z.string().min(1),
    expiresAt: z.string().optional(),
}, async ({ name, amount, asset, purpose, expiresAt }) => {
    const wallet = (await listWallets()).find((item) => item.name === name);
    if (!wallet) {
        return errorText(`wallet '${name}' not found`);
    }
    const draft = buildRunbookDraft({
        runbook: "request_funds",
        fields: {
            agentAddress: wallet.address,
            amount,
            asset: asset ?? "LYTH",
            purpose,
            expiresAt,
        },
        policy: {
            maxAmount: amount,
            assetAllowlist: [asset ?? "LYTH"],
            expiresAt,
            requireHumanApproval: true,
        },
        agent: {
            name,
            address: wallet.address,
            purpose: wallet.agent && typeof wallet.agent === "object" ? wallet.agent.purpose : undefined,
        },
    });
    const receipt = await addReceipt({
        kind: "agent_wallet_fund_request",
        status: "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Funding request for ${name}`,
        summary: `Request ${amount} ${asset ?? "LYTH"} for ${purpose}`,
        walletName: name,
        to: wallet.address,
        amount,
        asset: asset ?? "LYTH",
        result: draft,
    });
    return text({
        wallet: compactWallet(wallet),
        fundingAddress: wallet.address,
        draft,
        receipt,
        message: `Send up to ${amount} ${asset ?? "LYTH"} to ${wallet.address} for: ${purpose}`,
    });
});
server.tool("agent_wallet_limits", "Update explicit limits and metadata for an agent operating wallet.", {
    name: z.string().min(1),
    confirm: z.literal("UPDATE_AGENT_WALLET_LIMITS"),
    lowValueMaxAmount: z.string().optional(),
    lowValueDailyLimit: z.string().optional(),
    maxBalance: z.string().optional(),
    allowedCounterparties: z.array(z.string()).optional(),
    allowedCategories: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    fallbackApproval: z.enum(["passphrase", "wallet_handoff", "deny"]).optional(),
}, async ({ name, lowValueMaxAmount, lowValueDailyLimit, maxBalance, allowedCounterparties, allowedCategories, expiresAt, fallbackApproval }) => {
    let wallet = (await listWallets()).find((item) => item.name === name);
    if (!wallet) {
        return errorText(`wallet '${name}' not found`);
    }
    if (lowValueMaxAmount || lowValueDailyLimit) {
        wallet = await configureLowValuePolicy({
            name,
            enabled: true,
            maxAmount: lowValueMaxAmount ?? String(wallet.lowValue && typeof wallet.lowValue === "object" ? wallet.lowValue.maxAmount ?? DEFAULT_LOW_VALUE_MAX : DEFAULT_LOW_VALUE_MAX),
            dailyLimit: lowValueDailyLimit ?? (wallet.lowValue && typeof wallet.lowValue === "object" ? wallet.lowValue.dailyLimit : undefined),
        });
    }
    wallet = await updateAgentWalletMetadata({
        name,
        patch: {
            maxBalance,
            allowedCounterparties,
            allowedCategories,
            expiresAt,
            fallbackApproval,
            paused: false,
        },
    });
    const receipt = await addReceipt({
        kind: "agent_wallet_limits",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Updated agent wallet limits for ${name}`,
        summary: `${name} limits updated`,
        walletName: name,
        result: compactWallet(wallet),
    });
    return text({ wallet: compactWallet(wallet), receipt });
});
server.tool("agent_wallet_pause", "Pause an agent wallet by disabling low-value local signing and marking the wallet paused.", {
    name: z.string().min(1),
    confirm: z.literal("PAUSE_AGENT_WALLET"),
}, async ({ name }) => {
    await configureLowValuePolicy({ name, enabled: false });
    const wallet = await updateAgentWalletMetadata({ name, patch: { paused: true, fallbackApproval: "deny" } });
    const receipt = await addReceipt({
        kind: "agent_wallet_pause",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Paused agent wallet ${name}`,
        summary: `${name} can no longer sign through low-value mode`,
        walletName: name,
        result: compactWallet(wallet),
    });
    return text({
        wallet: compactWallet(wallet),
        receipt,
        warning: "Low-value signing is disabled. Existing signed payloads in the outbox are not automatically invalidated.",
    });
});
server.tool("agent_wallet_drain", "Prepare and optionally sign a transfer that drains an agent wallet back to a principal or recovery address.", {
    name: z.string().min(1),
    to: z.string().describe("0x recipient address or exact addressbook contact name."),
    amount: z.string().optional().describe("LYTH amount. Omit to drain balance minus estimated fee."),
    passphrase: z.string().min(12).optional(),
    sign: z.boolean().optional().describe("Sign encrypted envelope. Default true."),
    broadcast: z.boolean().optional().describe("Broadcast signed envelope. Requires LYTH_MCP_ENABLE_SUBMIT=1."),
    confirm: z.literal("DRAIN_AGENT_WALLET"),
}, async ({ name, to, amount, passphrase, sign, broadcast }) => {
    const recipient = await resolveRecipient(to);
    if (!recipient) {
        return errorText("to must be a 0x wire address or exact addressbook contact name");
    }
    const shouldSign = sign ?? true;
    const endpoint = shouldSign ? await firstWritableEndpoint() : await firstReachableEndpoint();
    const wallet = (await listWallets()).find((item) => item.name === name);
    if (!wallet) {
        return errorText(`wallet '${name}' not found`);
    }
    const gasLimit = 21000n;
    let fee = 1000000000n;
    try {
        fee = parseQuantity(await rpcCall(endpoint, "eth_gasPrice", []));
    }
    catch {
        fee = 1000000000n;
    }
    const amountUnits = amount
        ? decimalToUnits(amount)
        : parseQuantity(await rpcCall(endpoint, "eth_getBalance", [wallet.address, "latest"])) - gasLimit * fee;
    if (amountUnits <= 0n) {
        return errorText("wallet balance is too low to drain after estimated fee");
    }
    const resolvedNonce = parseQuantity(await rpcCall(endpoint, "eth_getTransactionCount", [wallet.address, "latest"]));
    const amountDecimal = unitsToDecimal(amountUnits);
    const preflight = await preflightTransfer({
        endpoint,
        walletName: name,
        from: wallet.address,
        to: recipient.address,
        amount: amountDecimal,
        amountUnits,
        gasLimit,
        maxFeePerGas: fee,
        nonce: resolvedNonce,
        sign: shouldSign,
        allowLowValueSigning: false,
        allowPausedAgent: true,
        passphrase,
    });
    if (!preflight.ok) {
        return errorJson({ recipient, preflight });
    }
    const balance = preflight.checks.balance;
    const summary = approvalSummary({
        walletName: name,
        from: wallet.address,
        to: recipient.address,
        recipientLabel: recipient.contact?.name,
        amount: amountDecimal,
        asset: "LYTH",
        feeCeiling: balance?.estimatedFeeCeiling,
        remainingAfterCeiling: balance?.remainingAfterCeiling,
        preflightOk: preflight.ok,
        violations: preflight.violations,
        warnings: preflight.warnings,
    });
    const encryptionKey = shouldSign
        ? encryptionKeyFromRpc(await rpcCall(endpoint, "lyth_getEncryptionKey", []))
        : undefined;
    const built = await buildTransfer({
        walletName: name,
        to: recipient.address,
        amountUnits,
        chainId: CHAIN_ID,
        nonce: resolvedNonce,
        gasLimit,
        maxFeePerGas: fee,
        maxPriorityFeePerGas: fee,
        passphrase,
        encryptionKey,
        sign: shouldSign,
        allowLowValueSigning: false,
        allowLocalKeySigning: true,
    });
    if (shouldSign && !built.signed) {
        return errorText("drain signing requires a passphrase; low-value signing is disabled for drains");
    }
    const outboxEntry = built.signed
        ? await addOutboxEntry({
            network: NETWORK,
            chainId: CHAIN_ID,
            kind: "lyth_encrypted",
            method: "lyth_submitEncrypted",
            payloadHex: built.signed.encryptedEnvelopeHex,
            walletName: name,
            from: wallet.address,
            to: recipient.address,
            amount: amountDecimal,
            asset: "LYTH",
            nonce: toQuantity(resolvedNonce),
            expiresAt: defaultOutboxExpiresAt(),
            note: "Created by agent_wallet_drain.",
        })
        : null;
    let submitted = null;
    let broadcastError = null;
    if (broadcast && built.signed) {
        if (!SUBMIT_ENABLED) {
            broadcastError = { endpoint, method: "lyth_submitEncrypted", message: "Broadcast disabled. Set LYTH_MCP_ENABLE_SUBMIT=1." };
        }
        else {
            try {
                const txHash = await submitPayload(endpoint, "lyth_encrypted", built.signed.encryptedEnvelopeHex);
                submitted = { endpoint, method: "lyth_submitEncrypted", txHash };
                if (outboxEntry) {
                    await recordOutboxAttempt(outboxEntry.id, { at: new Date().toISOString(), endpoint, method: "lyth_submitEncrypted", ok: true, txHash });
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                broadcastError = { endpoint, method: "lyth_submitEncrypted", message };
                if (outboxEntry) {
                    await recordOutboxAttempt(outboxEntry.id, { at: new Date().toISOString(), endpoint, method: "lyth_submitEncrypted", ok: false, error: message });
                }
            }
        }
    }
    if (built.signed) {
        await configureLowValuePolicy({ name, enabled: false });
    }
    const paused = await updateAgentWalletMetadata({ name, patch: { paused: true, fallbackApproval: "deny" } });
    const errorExplanation = broadcastError
        ? explainError({
            errorMessage: String(broadcastError.message ?? ""),
            rpcMethod: "lyth_submitEncrypted",
            tool: "agent_wallet_drain",
            outboxId: outboxEntry?.id,
            context: { broadcastError, preflight },
        })
        : null;
    const receipt = await addReceipt({
        kind: "agent_wallet_drain",
        status: submitted ? "submitted" : broadcastError ? "failed" : built.signed ? "signed" : "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Drain agent wallet ${name}`,
        summary: `${name} -> ${recipient.address} (${amountDecimal} LYTH)`,
        walletName: name,
        from: wallet.address,
        to: recipient.address,
        amount: amountDecimal,
        asset: "LYTH",
        outboxId: outboxEntry?.id,
        txHash: typeof submitted?.txHash === "string" ? submitted.txHash : undefined,
        payloadHash: outboxEntry?.payloadHash,
        endpoint,
        result: { submitted, wallet: compactWallet(paused), preflight, summary },
        error: broadcastError?.message,
    });
    return text({
        endpoint,
        recipient,
        summary,
        preflight,
        wallet: compactWallet(paused),
        built,
        outbox: outboxEntry,
        submitted,
        broadcastError,
        errorExplanation,
        receipt,
        warning: "Drain disables low-value signing and marks the wallet paused. Existing signed payloads in the outbox may still be valid.",
    });
});
server.tool("agent_wallet_delete", "Delete a local agent wallet record after explicit confirmation.", {
    name: z.string().min(1),
    confirmName: z.string().min(1).describe("Must exactly equal name."),
    confirm: z.literal("DELETE_AGENT_WALLET"),
}, async ({ name, confirmName }) => {
    const result = await deleteWallet(name, confirmName);
    const receipt = await addReceipt({
        kind: "agent_wallet_delete",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Deleted agent wallet ${name}`,
        summary: `${name} removed from local MCP wallet store`,
        walletName: name,
        result,
    });
    return text({ ...result, receipt });
});
// ---------------------------------------------------------------------------
// NOWPayments connector (P14.4) — sandbox first; production requires explicit
// environment switch in nowpayments_configure.
// ---------------------------------------------------------------------------
server.tool("nowpayments_configure", "Configure the NOWPayments connector. Sandbox is the default; production requires an explicit environment switch.", {
    environment: z.enum(["sandbox", "production"]).default("sandbox"),
    apiKey: z.string().min(8),
    ipnSecret: z.string().min(8).optional(),
    ipnCallbackUrl: z.string().url().optional(),
    confirm: z.literal("CONFIGURE_NOWPAYMENTS"),
}, async ({ environment, apiKey, ipnSecret, ipnCallbackUrl }) => {
    const config = await configureNowpayments({ environment, apiKey, ipnSecret, ipnCallbackUrl });
    return text({
        configured: true,
        environment: config.environment,
        baseUrl: config.baseUrl,
        ipnCallbackUrl: config.ipnCallbackUrl,
        apiKeyConfigured: true,
        ipnSecretConfigured: !!config.encryptedIpnSecret,
        warning: environment === "production"
            ? "Production NOWPayments configured. Real funds will move. Use sandbox unless this is intentional."
            : undefined,
    });
});
server.tool("nowpayments_status", "Probe the NOWPayments API health endpoint with the configured key + environment.", {}, async () => text(await nowpaymentsStatus()));
server.tool("nowpayments_currencies", "List all currencies known to NOWPayments.", {}, async () => text(await nowpaymentsCurrencies()));
server.tool("nowpayments_merchant_coins", "List the coins the configured merchant account has enabled.", {}, async () => text(await nowpaymentsMerchantCoins()));
server.tool("nowpayments_estimate", "Estimate how much of pay_currency is needed to satisfy price_amount of price_currency.", {
    amount: z.number().positive(),
    currencyFrom: z.string().min(2),
    currencyTo: z.string().min(2),
}, async ({ amount, currencyFrom, currencyTo }) => text(await nowpaymentsEstimate({ amount, currencyFrom, currencyTo })));
server.tool("nowpayments_payment_create", "Create a NOWPayments payment (deposit-address flow). Writes a local outbox entry + receipt.", {
    priceAmount: z.number().positive(),
    priceCurrency: z.string().min(2),
    payCurrency: z.string().min(2),
    orderId: z.string().optional(),
    orderDescription: z.string().optional(),
    ipnCallbackUrl: z.string().url().optional(),
    payAmount: z.number().positive().optional(),
    payinExtraId: z.string().optional(),
}, async (args) => {
    const payment = await nowpaymentsCreatePayment({
        priceAmount: args.priceAmount,
        priceCurrency: args.priceCurrency,
        payCurrency: args.payCurrency,
        orderId: args.orderId,
        orderDescription: args.orderDescription,
        ipnCallbackUrl: args.ipnCallbackUrl,
        payAmount: args.payAmount,
        payinExtraId: args.payinExtraId,
    });
    const receipt = await addReceipt({
        kind: "nowpayments_payment_create",
        status: "submitted",
        network: "nowpayments",
        chainId: CHAIN_ID,
        title: `NOWPayments payment ${payment.payment_id}`,
        summary: `${payment.price_amount} ${payment.price_currency} → ${payment.pay_amount} ${payment.pay_currency} @ ${payment.pay_address}`,
        result: payment,
    });
    return text({ payment, receipt });
});
server.tool("nowpayments_invoice_create", "Create a NOWPayments hosted invoice page.", {
    priceAmount: z.number().positive(),
    priceCurrency: z.string().min(2),
    payCurrency: z.string().min(2).optional(),
    orderId: z.string().optional(),
    orderDescription: z.string().optional(),
    ipnCallbackUrl: z.string().url().optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
}, async (args) => {
    const invoice = await nowpaymentsCreateInvoice({
        priceAmount: args.priceAmount,
        priceCurrency: args.priceCurrency,
        payCurrency: args.payCurrency,
        orderId: args.orderId,
        orderDescription: args.orderDescription,
        ipnCallbackUrl: args.ipnCallbackUrl,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
    });
    const receipt = await addReceipt({
        kind: "nowpayments_invoice_create",
        status: "submitted",
        network: "nowpayments",
        chainId: CHAIN_ID,
        title: `NOWPayments invoice ${invoice.id}`,
        summary: `${invoice.price_amount} ${invoice.price_currency} @ ${invoice.invoice_url}`,
        result: invoice,
    });
    return text({ invoice, receipt });
});
server.tool("nowpayments_payment_status", "Get the current status of a NOWPayments payment by id.", { paymentId: z.string().min(1) }, async ({ paymentId }) => text(await nowpaymentsGetPayment(paymentId)));
server.tool("nowpayments_payment_list", "List recent NOWPayments payments for the configured merchant.", {
    limit: z.number().int().positive().max(500).optional(),
    page: z.number().int().min(0).optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
}, async (args) => text(await nowpaymentsListPayments(args)));
server.tool("nowpayments_refund_draft", "Draft a manual refund request for a NOWPayments payment. NOWPayments refunds are support-mediated; this just produces the request shape.", {
    paymentId: z.string().min(1),
    reason: z.string().min(1),
    recipientAddress: z.string().optional(),
}, async ({ paymentId, reason, recipientAddress }) => text(nowpaymentsRefundDraft({ paymentId, reason, recipientAddress })));
server.tool("nowpayments_ipn_verify", "Verify a NOWPayments IPN webhook body against an x-nowpayments-sig HMAC-SHA512 (sorted-keys JSON).", {
    rawBody: z.string().min(1).describe("Raw webhook body as a string."),
    sigHeader: z.string().min(1).describe("Value of the x-nowpayments-sig header."),
}, async ({ rawBody, sigHeader }) => text(await verifyNowpaymentsIpn({ rawBody, sigHeader })));
server.tool("nowpayments_config_redacted", "Inspect the NOWPayments connector config (no secrets revealed).", {}, async () => text({ config: await nowpaymentsRedactedConfig() }));
// ---------------------------------------------------------------------------
// ChangeNow — non-custodial swap (crypto <-> crypto) + fiat off-ramp.
// Pattern mirrors NowPayments above. API key + partner code stored
// encrypted (AES-256-GCM + scrypt) at ~/.lyth_mcp/changenow.json.
// Partner code drives the revenue-share program (see ChangeNow partner
// program docs); pass `partner` on swap_create to override per-swap.
// ---------------------------------------------------------------------------
server.tool("changenow_configure", "Configure ChangeNow API access. Stores the public api key, optional private api key, and optional partner code encrypted at ~/.lyth_mcp/changenow.json (AES-256-GCM + scrypt). The private key is only required for swap_list (the /exchanges endpoint). Required before any other changenow_* tool.", {
    apiKey: z.string().min(8).describe("ChangeNow public api key (creates swaps, runs estimates)."),
    privateApiKey: z.string().min(8).optional().describe("ChangeNow private api key (only required for swap_list). Separate from the public key in the partner dashboard."),
    partnerCode: z.string().min(1).optional().describe("Partner code for revenue share. Optional but recommended."),
    defaultRefundAddress: z.string().min(8).optional().describe("Refund address used when a swap fails."),
}, async ({ apiKey, privateApiKey, partnerCode, defaultRefundAddress }) => {
    const config = await configureChangenow({ apiKey, privateApiKey, partnerCode, defaultRefundAddress });
    return text({
        configured: true,
        baseUrl: config.baseUrl,
        privateApiKeyConfigured: !!config.encryptedPrivateApiKey,
        partnerConfigured: !!config.encryptedPartnerCode,
        defaultRefundAddress: config.defaultRefundAddress,
        warning: "ChangeNow swaps move real funds. Inspect each swap_create payload before broadcasting deposits.",
    });
});
server.tool("changenow_status", "Probe ChangeNow API reachability with the configured key.", {}, async () => text(await changenowStatus()));
server.tool("changenow_currencies", "List ChangeNow currencies (filterable by active / flow / buy / sell).", {
    active: z.boolean().optional(),
    flow: z.enum(["standard", "fixed-rate"]).optional(),
    buy: z.boolean().optional(),
    sell: z.boolean().optional(),
}, async (args) => text(await changenowCurrencies(args)));
server.tool("changenow_min_amount", "Get the minimum swappable amount for a pair.", {
    fromCurrency: z.string().min(2),
    toCurrency: z.string().min(2),
    fromNetwork: z.string().optional(),
    toNetwork: z.string().optional(),
    flow: z.enum(["standard", "fixed-rate"]).optional(),
}, async (args) => text(await changenowMinAmount(args)));
server.tool("changenow_estimate", "Quote a swap. Pass `fromAmount` for direct, or `toAmount` for reverse. `flow: 'fixed-rate'` returns a rateId valid for ~20 minutes that you pass back into changenow_swap_create.", {
    fromCurrency: z.string().min(2),
    toCurrency: z.string().min(2),
    fromAmount: z.number().positive().optional(),
    toAmount: z.number().positive().optional(),
    fromNetwork: z.string().optional(),
    toNetwork: z.string().optional(),
    flow: z.enum(["standard", "fixed-rate"]).optional(),
    type: z.enum(["direct", "reverse"]).optional(),
}, async (args) => text(await changenowEstimate(args)));
server.tool("changenow_swap_create", "Create a swap. Returns the deposit address (payinAddress) — send fromCurrency to that address and ChangeNow forwards toCurrency to payoutAddress. Fixed-rate swaps require the rateId returned by changenow_estimate.", {
    fromCurrency: z.string().min(2),
    toCurrency: z.string().min(2),
    fromAmount: z.union([z.number().positive(), z.string()]).optional(),
    toAmount: z.union([z.number().positive(), z.string()]).optional(),
    payoutAddress: z.string().min(8),
    payoutExtraId: z.string().optional(),
    refundAddress: z.string().optional(),
    refundExtraId: z.string().optional(),
    fromNetwork: z.string().optional(),
    toNetwork: z.string().optional(),
    flow: z.enum(["standard", "fixed-rate"]).optional(),
    type: z.enum(["direct", "reverse"]).optional(),
    rateId: z.string().optional(),
    partner: z.string().optional(),
}, async (args) => text(await changenowCreateSwap(args)));
server.tool("changenow_swap_status", "Poll the status of a swap by ChangeNow swap id.", { id: z.string().min(4) }, async ({ id }) => text(await changenowSwapStatus(id)));
server.tool("changenow_swap_list", "List historic swaps (paginated).", {
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    status: z.string().optional(),
}, async (args) => text(await changenowSwapList(args)));
server.tool("changenow_fiat_estimate", "Quote a crypto → fiat (or fiat → crypto) sale. Off-ramp; KYC will be required at sell time.", {
    fromCurrency: z.string().min(2),
    toCurrency: z.string().min(2),
    fromAmount: z.number().positive().optional(),
    toAmount: z.number().positive().optional(),
}, async (args) => text(await changenowFiatEstimate(args)));
server.tool("changenow_fiat_sell_draft", "Draft a crypto-to-fiat sell payload. DOES NOT submit — fiat off-ramp requires KYC and irreversible bank transfers. Review the returned `draft.body` and submit manually after KYC clears.", {
    fromCurrency: z.string().min(2),
    toCurrency: z.string().min(2),
    fromAmount: z.number().positive(),
    payoutDetails: z.record(z.unknown()),
    refundAddress: z.string().optional(),
}, async (args) => text(await changenowFiatSellDraft(args)));
server.tool("changenow_config_redacted", "Inspect the ChangeNow connector config (no secrets revealed).", {}, async () => text({ config: await changenowRedactedConfig() }));
// ---------------------------------------------------------------------------
// Secure traveler profiles (P15) — encrypted PII storage. Profiles supply
// firstName / lastName / email / phone to vendor bookings without the agent
// re-typing them, and surface passport / frequent-flyer data only on explicit
// reveal. Same encryption model as wallets (AES-256-GCM + scrypt).
// ---------------------------------------------------------------------------
const ProfilePassportSchema = z.object({
    number: z.string().min(3),
    countryOfIssue: z.string().min(2),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    fullNameOnPassport: z.string().optional(),
});
const ProfileFrequentFlyerSchema = z.object({
    airline: z.string().min(1),
    number: z.string().min(1),
});
const ProfilePlaintextSchema = z.object({
    legalFirstName: z.string().min(1),
    legalMiddleName: z.string().optional(),
    legalLastName: z.string().min(1),
    preferredName: z.string().optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    nationality: z.string().optional(),
    gender: z.string().optional(),
    passports: z.array(ProfilePassportSchema).optional(),
    knownTravelerNumbers: z.object({
        tsaPrecheck: z.string().optional(),
        globalEntry: z.string().optional(),
        nexus: z.string().optional(),
        other: z.record(z.string(), z.string()).optional(),
    }).optional(),
    redressNumber: z.string().optional().describe("DHS-issued redress number (TRIP), if applicable."),
    frequentFlyerNumbers: z.array(ProfileFrequentFlyerSchema).optional(),
    contact: z.object({
        email: z.string().email(),
        phone: z.string().min(3),
        alternateEmail: z.string().email().optional(),
    }),
    ticketDeliveryEmail: z.string().email().optional(),
    mailingAddress: z.object({
        street: z.string().min(1),
        city: z.string().min(1),
        region: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().min(1),
    }).optional(),
    emergencyContact: z.object({
        name: z.string().min(1),
        phone: z.string().min(3),
        relationship: z.string().optional(),
        email: z.string().email().optional(),
    }).optional(),
    dietaryPreferences: z.string().optional(),
    accessibilityNeeds: z.string().optional(),
    notes: z.string().optional(),
});
server.tool("profile_create", "Create an encrypted traveler profile (legal name, DOB, passport, contact, ticket delivery email, frequent-flyer numbers). PII is encrypted at rest with AES-256-GCM + scrypt; only a redacted preview is visible to list/get.", {
    id: z.string().min(1).describe("Slug, e.g. 'nayiem' or 'family-travel'."),
    displayName: z.string().min(1).describe("Friendly label shown without revealing PII."),
    profile: ProfilePlaintextSchema,
    passphrase: z.string().optional(),
    allowLocalKey: z.boolean().optional().describe("Allow local-machine-key protection (no passphrase). Default false; passphrase is recommended."),
    overwrite: z.boolean().optional(),
    confirm: z.literal("CREATE_TRAVELER_PROFILE"),
}, async ({ id, displayName, profile, passphrase, allowLocalKey, overwrite }) => {
    const summary = await createProfile({
        id,
        displayName,
        profile: profile,
        passphrase,
        allowLocalKey,
        overwrite,
    });
    return text({
        profile: summary,
        warning: "Profile contains PII (passport, DOB, contact). Reveal requires explicit confirmation. Treat the passphrase as a secret.",
    });
});
server.tool("profile_update", "Patch an existing traveler profile. Only the fields you supply are changed; the rest are preserved.", {
    id: z.string().min(1),
    displayName: z.string().optional(),
    patch: ProfilePlaintextSchema.partial(),
    passphrase: z.string().optional(),
    confirm: z.literal("UPDATE_TRAVELER_PROFILE"),
}, async ({ id, displayName, patch, passphrase }) => {
    const summary = await updateProfile({
        id,
        displayName,
        patch: patch,
        passphrase,
    });
    return text({ profile: summary });
});
server.tool("profile_list", "List saved traveler profiles. Returns redacted previews only (no plaintext PII).", {}, async () => text({ profiles: await listProfiles() }));
server.tool("profile_get", "Get one traveler profile by id. Returns redacted preview only — call profile_reveal for plaintext.", { id: z.string().min(1) }, async ({ id }) => text({ profile: await getProfile(id) }));
server.tool("profile_reveal", "Reveal the full plaintext of an encrypted traveler profile. Requires explicit confirmation; do not paste output into shared contexts.", {
    id: z.string().min(1),
    confirm: z.literal("REVEAL_TRAVELER_PROFILE"),
    passphrase: z.string().optional(),
}, async ({ id, passphrase }) => {
    const profile = await revealProfile(id, passphrase);
    return text({
        profileId: id,
        profile,
        warning: "This response contains plaintext PII (passport, DOB, contact). Treat as a secret. Do not paste into chat history or commit it.",
    });
});
server.tool("profile_delete", "Delete a traveler profile after explicit confirmation.", {
    id: z.string().min(1),
    confirmId: z.string().min(1).describe("Must exactly equal id."),
    confirm: z.literal("DELETE_TRAVELER_PROFILE"),
}, async ({ id, confirmId }) => text(await deleteProfile(id, confirmId)));
server.tool("profile_store_info", "Show profile store path, count, and file mode for diagnostics.", {}, async () => text(await profileStoreInfo()));
// ---------------------------------------------------------------------------
// Flight connectors (P16)
// - Duffel: real flight catalog + booking API. Test mode is free (signup at
//   duffel.com); production needs balance funding. Payment is fiat-only at
//   the API level; orders can be created on hold for the user to pay
//   separately, or paid via Duffel balance with duffel_pay.
// - flight_ota_nowpayments_track: same Coinsbee-style interim path for
//   crypto-accepting OTA web checkouts that issue a NOWPayments invoice.
// - travala_flight_capability_probe: surfaces flight tools the moment they
//   ship on Travala's hosted MCP. Hotels-only today.
// ---------------------------------------------------------------------------
const DuffelSliceSchema = z.object({
    origin: z.string().min(3),
    destination: z.string().min(3),
    departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    departureTime: z.object({ from: z.string(), to: z.string() }).optional(),
});
const DuffelSearchPassengerSchema = z.object({
    type: z.enum(["adult", "child", "infant_without_seat"]),
    age: z.number().int().min(0).max(120).optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
});
server.tool("duffel_configure", "Configure the Duffel flight connector. Test mode uses a Duffel test access token; production uses a live token and real balance. Token type (not a separate URL) determines live vs. simulated bookings.", {
    declaredEnvironment: z.enum(["test", "live"]).default("test"),
    accessToken: z.string().min(16),
    defaultCurrency: z.string().min(3).optional(),
    confirm: z.literal("CONFIGURE_DUFFEL"),
}, async ({ declaredEnvironment, accessToken, defaultCurrency }) => {
    const config = await configureDuffel({ declaredEnvironment, accessToken, defaultCurrency });
    return text({
        configured: true,
        declaredEnvironment: config.declaredEnvironment,
        apiVersion: "v2",
        defaultCurrency: config.defaultCurrency,
        warning: declaredEnvironment === "live"
            ? "Live Duffel configured. Booked orders are real bookings against real airline inventory. Confirm balance before flight_order_create_instant."
            : undefined,
    });
});
server.tool("duffel_config_redacted", "Inspect the Duffel config (no token revealed).", {}, async () => text({ config: await duffelConfigRedacted() }));
server.tool("flight_search", "Search flights through Duffel. Returns a sorted offer list with summaries. Use cabin_class to filter; set maxConnections=0 for non-stop only. Pass returnOffers=false for a faster two-step flow (then call flight_offer_get).", {
    slices: z.array(DuffelSliceSchema).min(1).describe("One slice per leg. Round-trip = 2 slices."),
    passengers: z.array(DuffelSearchPassengerSchema).min(1),
    cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
    maxConnections: z.number().int().min(0).max(3).optional(),
    sort: z.enum(["total_amount", "total_duration"]).optional(),
    limit: z.number().int().positive().max(200).optional(),
}, async ({ slices, passengers, cabinClass, maxConnections, sort, limit }) => {
    const slicesForApi = slices.map((s) => ({
        origin: s.origin.toUpperCase(),
        destination: s.destination.toUpperCase(),
        departure_date: s.departureDate,
        departure_time: s.departureTime,
    }));
    const passengersForApi = passengers.map((p) => ({
        type: p.type,
        age: p.age,
        given_name: p.givenName,
        family_name: p.familyName,
    }));
    const request = await duffelCreateOfferRequest({
        slices: slicesForApi,
        passengers: passengersForApi,
        cabinClass: cabinClass,
        maxConnections,
    });
    const offers = await duffelListOffers({ offerRequestId: request.id, sort: sort ?? "total_amount", limit: limit ?? 30 });
    return text({
        offerRequestId: request.id,
        liveMode: request.live_mode,
        cabinClass: request.cabin_class,
        passengers: request.passengers,
        offerCount: offers.length,
        offers: offers.map(summarizeOffer),
    });
});
server.tool("flight_offer_get", "Fetch the full offer (segments, fare conditions, available services like seats and bags) by id.", {
    offerId: z.string().min(1),
    withServices: z.boolean().optional().describe("If true, includes seats / bags / extras. Heavier response."),
}, async ({ offerId, withServices }) => {
    const offer = await duffelGetOffer(offerId, withServices ?? false);
    return text({ offer, summary: summarizeOffer(offer) });
});
server.tool("flight_seat_maps", "Fetch the seat map for an offer.", { offerId: z.string().min(1) }, async ({ offerId }) => text({ seatMaps: await duffelGetSeatMaps(offerId) }));
const DuffelOrderPassengerSchema = z.object({
    id: z.string().min(1).describe("Passenger id from the offer_request response."),
    type: z.enum(["adult", "child", "infant_without_seat"]),
    title: z.enum(["mr", "mrs", "ms", "miss", "dr"]).optional(),
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    gender: z.enum(["m", "f"]).optional(),
    bornOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().optional(),
    // Duffel constraint: at most one of these may be set. The airline's
    // supported_passenger_identity_document_types on the offer dictates which.
    passport: z.object({
        number: z.string().min(3),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        issuingCountryCode: z.string().min(2),
    }).optional(),
    knownTravelerNumber: z.object({
        number: z.string().min(3),
        issuingCountryCode: z.string().min(2).optional().describe("Defaults to 'US'."),
    }).optional(),
    passengerRedressNumber: z.object({
        number: z.string().min(3),
        issuingCountryCode: z.string().min(2).optional().describe("Defaults to 'US'."),
    }).optional(),
    loyaltyProgrammes: z.array(z.object({ airlineIataCode: z.string().min(2), accountNumber: z.string().min(1) })).optional(),
});
function buildPassengerFromSchema(p) {
    const out = {
        id: p.id,
        type: p.type,
        given_name: p.givenName,
        family_name: p.familyName,
    };
    if (p.title)
        out.title = p.title;
    if (p.gender)
        out.gender = p.gender;
    if (p.bornOn)
        out.born_on = p.bornOn;
    if (p.email)
        out.email = p.email;
    if (p.phoneNumber)
        out.phone_number = p.phoneNumber;
    const idCount = [p.passport, p.knownTravelerNumber, p.passengerRedressNumber].filter(Boolean).length;
    if (idCount > 1) {
        throw new Error(`passenger ${p.id} has multiple identity_documents; Duffel allows only one (passport, knownTravelerNumber, or passengerRedressNumber)`);
    }
    if (p.passport) {
        out.identity_documents = [{
                unique_identifier: p.passport.number,
                expires_on: p.passport.expiresOn,
                issuing_country_code: p.passport.issuingCountryCode.toUpperCase(),
                type: "passport",
            }];
    }
    else if (p.knownTravelerNumber) {
        out.identity_documents = [{
                unique_identifier: p.knownTravelerNumber.number,
                expires_on: "2099-12-31",
                issuing_country_code: (p.knownTravelerNumber.issuingCountryCode ?? "US").toUpperCase(),
                type: "known_traveler_number",
            }];
    }
    else if (p.passengerRedressNumber) {
        out.identity_documents = [{
                unique_identifier: p.passengerRedressNumber.number,
                expires_on: "2099-12-31",
                issuing_country_code: (p.passengerRedressNumber.issuingCountryCode ?? "US").toUpperCase(),
                type: "passenger_redress_number",
            }];
    }
    if (p.loyaltyProgrammes) {
        out.loyalty_programme_accounts = p.loyaltyProgrammes.map((lp) => ({
            airline_iata_code: lp.airlineIataCode.toUpperCase(),
            account_number: lp.accountNumber,
        }));
    }
    return out;
}
const PassengerProfileBindingSchema = z.object({
    passengerId: z.string().min(1).describe("Passenger id from the offer (e.g. 'pas_00009...')."),
    profileId: z.string().min(1),
    type: z.enum(["adult", "child", "infant_without_seat"]).optional(),
    preferredPassportCountry: z.string().optional(),
    identityDocumentPreference: z.enum(["passport", "known_traveler_number", "passenger_redress_number", "none"]).optional()
        .describe("Duffel allows exactly ONE identity document per passenger. Pick the type the offer's airline supports (see supported_passenger_identity_document_types). Default: 'passport'."),
    includePassport: z.boolean().optional().describe("Legacy: set false to omit identity_documents. Equivalent to identityDocumentPreference='none'."),
    includeLoyalty: z.boolean().optional(),
    ktnIssuingCountry: z.string().optional().describe("Country code for the KTN (defaults to profile nationality, then 'US')."),
    redressIssuingCountry: z.string().optional(),
    profilePassphrase: z.string().optional(),
});
async function buildPassengersFromBindings(bindings) {
    const out = [];
    for (const b of bindings) {
        const profile = await revealProfile(b.profileId, b.profilePassphrase);
        out.push(duffelPassengerFromProfile({
            profile,
            passengerId: b.passengerId,
            type: b.type,
            preferredPassportCountry: b.preferredPassportCountry,
            identityDocumentPreference: b.identityDocumentPreference,
            includePassport: b.includePassport,
            includeLoyalty: b.includeLoyalty,
            ktnIssuingCountry: b.ktnIssuingCountry,
            redressIssuingCountry: b.redressIssuingCountry,
        }));
    }
    return out;
}
server.tool("flight_order_create_hold", "Create a Duffel order on hold (no immediate payment). The order is held until payment_required_by. Pay later with flight_order_pay, or direct the user to a separate crypto-accepting checkout. Passengers can be supplied explicitly OR via profile bindings (passport + DOB + FF numbers pulled from encrypted profiles).", {
    offerId: z.string().min(1),
    passengers: z.array(DuffelOrderPassengerSchema).optional(),
    passengerProfiles: z.array(PassengerProfileBindingSchema).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    confirm: z.literal("CREATE_FLIGHT_HOLD"),
}, async ({ offerId, passengers, passengerProfiles, metadata }) => {
    const explicit = (passengers ?? []).map(buildPassengerFromSchema);
    const fromProfiles = passengerProfiles ? await buildPassengersFromBindings(passengerProfiles) : [];
    const allPassengers = [...explicit, ...fromProfiles];
    if (allPassengers.length === 0) {
        return errorText("at least one passenger (explicit or profile-bound) is required");
    }
    const order = await duffelCreateOrder({
        type: "hold",
        selected_offers: [offerId],
        passengers: allPassengers,
        metadata,
    });
    const receipt = await addReceipt({
        kind: "flight_order_create_hold",
        status: order.payment_status?.awaiting_payment ? "submitted" : "confirmed",
        network: "duffel",
        chainId: CHAIN_ID,
        title: `Flight hold ${order.booking_reference ?? order.id}`,
        summary: `${order.total_amount} ${order.total_currency} — ${order.passengers.map((p) => `${p.given_name} ${p.family_name}`).join(", ")}; payment_required_by ${order.payment_status?.payment_required_by ?? "n/a"}`,
        result: order,
    });
    return text({ order: summarizeOrder(order), receipt, raw: order, warning: order.live_mode ? undefined : "live_mode=false: this is a test order against Duffel's simulated airlines." });
});
server.tool("flight_order_create_instant", "Create a Duffel order with immediate Duffel-balance payment (live mode requires a funded Duffel account). For crypto payment, use flight_order_create_hold + the user-side crypto checkout, or use flight_ota_nowpayments_track against a crypto-accepting OTA.", {
    offerId: z.string().min(1),
    amount: z.string().min(1),
    currency: z.string().min(3),
    passengers: z.array(DuffelOrderPassengerSchema).optional(),
    passengerProfiles: z.array(PassengerProfileBindingSchema).optional(),
    paymentType: z.enum(["balance", "arc_bsp_cash"]).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    confirm: z.literal("CREATE_FLIGHT_INSTANT"),
}, async ({ offerId, amount, currency, passengers, passengerProfiles, paymentType, metadata }) => {
    const explicit = (passengers ?? []).map(buildPassengerFromSchema);
    const fromProfiles = passengerProfiles ? await buildPassengersFromBindings(passengerProfiles) : [];
    const allPassengers = [...explicit, ...fromProfiles];
    if (allPassengers.length === 0) {
        return errorText("at least one passenger (explicit or profile-bound) is required");
    }
    const order = await duffelCreateOrder({
        type: "instant",
        selected_offers: [offerId],
        passengers: allPassengers,
        payments: [{ type: paymentType ?? "balance", amount, currency: currency.toUpperCase() }],
        metadata,
    });
    const receipt = await addReceipt({
        kind: "flight_order_create_instant",
        status: "confirmed",
        network: "duffel",
        chainId: CHAIN_ID,
        title: `Flight booked ${order.booking_reference ?? order.id}`,
        summary: `${order.total_amount} ${order.total_currency} — ${order.passengers.map((p) => `${p.given_name} ${p.family_name}`).join(", ")}`,
        result: order,
    });
    return text({ order: summarizeOrder(order), receipt, raw: order });
});
server.tool("flight_order_get", "Get a Duffel order by id.", { orderId: z.string().min(1) }, async ({ orderId }) => {
    const order = await duffelGetOrder(orderId);
    return text({ order: summarizeOrder(order), raw: order });
});
server.tool("flight_order_list", "List Duffel orders (optionally filter to those awaiting payment).", {
    limit: z.number().int().positive().max(200).optional(),
    awaitingPayment: z.boolean().optional(),
}, async ({ limit, awaitingPayment }) => {
    const orders = await duffelListOrders({ limit, awaitingPayment });
    return text({ orders: orders.map(summarizeOrder) });
});
server.tool("flight_order_pay", "Pay a held Duffel order using Duffel balance.", {
    orderId: z.string().min(1),
    amount: z.string().min(1),
    currency: z.string().min(3),
    paymentType: z.enum(["balance", "arc_bsp_cash"]).optional(),
    confirm: z.literal("PAY_FLIGHT_ORDER"),
}, async ({ orderId, amount, currency, paymentType }) => {
    const result = await duffelPayOrder({ orderId, amount, currency: currency.toUpperCase(), type: paymentType });
    return text({ result });
});
server.tool("flight_order_cancel", "Initiate cancellation for a Duffel order. Returns a cancellation object — confirm with flight_order_cancel_confirm to actually cancel.", { orderId: z.string().min(1), confirm: z.literal("INITIATE_FLIGHT_CANCEL") }, async ({ orderId }) => text({ cancellation: await duffelCancelOrder(orderId) }));
server.tool("flight_order_cancel_confirm", "Confirm a pending Duffel order cancellation by cancellation id.", { cancellationId: z.string().min(1), confirm: z.literal("CONFIRM_FLIGHT_CANCEL") }, async ({ cancellationId }) => text({ result: await duffelConfirmCancellation(cancellationId) }));
server.tool("flight_ota_nowpayments_track", "Track a flight purchased through a crypto-accepting OTA (Travala web, Alternative Airlines, CheapAir, etc.) that is being paid via NOWPayments. Polls nowpayments_payment_status and writes a local receipt linking the booking metadata.", {
    paymentId: z.string().min(1).describe("NOWPayments payment_id from the OTA checkout."),
    ota: z.string().min(1).describe("OTA name, e.g. 'travala', 'alternative-airlines', 'cheapair'."),
    route: z.string().min(1).describe("Free-text route summary, e.g. 'YKA-LAX 2026-06-15'."),
    passenger: z.string().min(1),
    profileIdReference: z.string().optional().describe("Optional profile id used for the booking, for cross-reference only."),
    notes: z.string().optional(),
}, async ({ paymentId, ota, route, passenger, profileIdReference, notes }) => {
    const payment = await nowpaymentsGetPayment(paymentId);
    const receipt = await addReceipt({
        kind: "flight_ota_nowpayments_track",
        status: payment.payment_status === "finished" ? "confirmed" : "submitted",
        network: `${ota}+nowpayments`,
        chainId: CHAIN_ID,
        title: `Flight: ${route}`,
        summary: `${passenger} via ${ota}; NOWPayments ${paymentId} status=${payment.payment_status}`,
        result: { ota, route, passenger, profileIdReference, notes, payment },
    });
    return text({
        ota,
        route,
        passenger,
        payment,
        receipt,
        warning: "Confirmation + ticket delivery come from the OTA by email. Refunds + changes go through the OTA, not NOWPayments.",
    });
});
server.tool("travala_flight_capability_probe", "Call tools/list on Travala's hosted MCP and report whether flight tools are exposed yet (today: hotels-only).", {}, async () => {
    const tools = await travalaListTools();
    const flightTools = tools.filter((t) => /flight|airline|airfare|ticket/i.test(t.name) || /flight|airline/i.test(t.description ?? ""));
    return text({
        travalaMcpUrl: travalaMcpUrl(),
        totalTools: tools.length,
        toolNames: tools.map((t) => t.name),
        flightTools,
        flightToolsAvailable: flightTools.length > 0,
        note: flightTools.length === 0
            ? "No flight tools detected on Travala's hosted MCP. Travala still books flights on their website; combine flight_ota_nowpayments_track with a Travala web checkout to pay in crypto today."
            : `Found ${flightTools.length} flight tool(s). They can be called via travala_proxy_call.`,
    });
});
// ---------------------------------------------------------------------------
// Travala hosted MCP helpers. Booking payment stays outside this package until
// a native Monolythium payment route exists.
// ---------------------------------------------------------------------------
server.tool("travala_info", "Show how lyth_mcp talks to Travala's hosted MCP for read-only travel tooling.", {}, async () => {
    return text({
        travalaMcpUrl: travalaMcpUrl(),
        flow: [
            "Install Travala's MCP server alongside lyth_mcp (https://travel-mcp.travala.com/mcp) for travala_search_hotel / travala_search_package.",
            "Use travala_proxy_call for hosted search and booking status tools.",
            "Complete payment through a user-controlled external checkout until a native Monolythium payment path is available.",
        ],
    });
});
server.tool("travala_proxy_call", "Forward an arbitrary read-only tool call to Travala's hosted MCP.", {
    tool: z.string().min(1),
    args: z.record(z.string(), z.any()).optional(),
}, async ({ tool, args }) => {
    const result = await travalaProxyCall({ tool, args: args ?? {} });
    return text({ tool, travalaMcpUrl: travalaMcpUrl(), result });
});
// ---------------------------------------------------------------------------
// Coinsbee (P14.6) — interim NOWPayments-invoice path. Direct reseller API is
// gated on partnership/BD; no fabricated endpoints.
// ---------------------------------------------------------------------------
server.tool("coinsbee_guide", "Explain how to buy a Coinsbee gift card from the agent today (interim NOWPayments path) and what's required to unlock the direct reseller API.", {}, async () => text({
    interim: {
        path: "Coinsbee invoice paid via NOWPayments",
        steps: [
            "Open https://www.coinsbee.com and select the brand + denomination + region you want.",
            "Choose 'pay with crypto' — Coinsbee issues a payment invoice (in most regions, via NOWPayments under the hood).",
            "Copy the invoice id (or the NOWPayments payment_id if shown).",
            "Call coinsbee_via_nowpayments_track with the payment_id to register the purchase locally and watch its status.",
            "Fund the deposit address from a user-controlled external wallet.",
            "Coinsbee delivers the gift-card code by email once payment confirms; code retrieval is out-of-band today.",
        ],
        limitations: [
            "Code retrieval is email-only; the agent cannot auto-fetch the code without mailbox access.",
            "Refunds / disputes go through Coinsbee support, not NOWPayments.",
            "Brand availability is region-locked; the agent must respect Coinsbee's geographic terms.",
        ],
    },
    directApi: {
        status: "blocked-on-partnership",
        requires: [
            "Coinsbee BD contract granting reseller API access.",
            "Published catalog / order / status / code-retrieval endpoints under NDA.",
            "KYB onboarding of the reseller account.",
        ],
        note: "No coinsbee_* direct API tools are exposed by lyth_mcp until the partnership returns real specs. Do not fabricate endpoints.",
    },
}));
server.tool("coinsbee_via_nowpayments_track", "Track a Coinsbee gift-card purchase that is being paid through NOWPayments. Wraps nowpayments_payment_status and records the purchase locally for receipts.", {
    paymentId: z.string().min(1).describe("NOWPayments payment_id issued by Coinsbee's checkout."),
    brand: z.string().min(1),
    denomination: z.string().min(1),
    region: z.string().optional(),
    recipientEmail: z.string().email().optional(),
    notes: z.string().optional(),
}, async ({ paymentId, brand, denomination, region, recipientEmail, notes }) => {
    const payment = await nowpaymentsGetPayment(paymentId);
    const receipt = await addReceipt({
        kind: "coinsbee_via_nowpayments_track",
        status: payment.payment_status === "finished" ? "confirmed" : "submitted",
        network: "coinsbee+nowpayments",
        chainId: CHAIN_ID,
        title: `Coinsbee ${brand} ${denomination}`,
        summary: `Coinsbee gift card via NOWPayments payment ${paymentId}; status=${payment.payment_status}`,
        result: { brand, denomination, region, recipientEmail, notes, payment },
    });
    return text({
        brand,
        denomination,
        region,
        recipientEmail,
        payment,
        receipt,
        warning: "Code retrieval is via email from Coinsbee. Refunds + disputes go through Coinsbee support, not NOWPayments.",
    });
});
server.tool("travala_book_recover", "Look up a Travala booking that errored or timed out before retrying through Travala's hosted checkout.", {
    packageId: z.string().min(1),
    sessionId: z.string().min(1),
}, async ({ packageId, sessionId }) => {
    const result = await travalaBookStatus({ packageId, sessionId });
    return text({ travalaMcpUrl: travalaMcpUrl(), result });
});
server.tool("addressbook_add", "Add or update a local MCP addressbook contact. Use this before sending to named contacts.", {
    name: z.string().min(1),
    address: z.string().describe("0x recipient address."),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
    overwrite: z.boolean().optional().describe("Replace existing contact with the same name. Default true."),
}, async ({ name, address, note, tags, overwrite }) => {
    if (!isWireAddress(address)) {
        return errorText("address must be a 0x wire address");
    }
    return text(await upsertAddressbookContact({
        name,
        address,
        note,
        tags,
        overwrite,
    }));
});
server.tool("addressbook_lookup", "List or search local MCP addressbook contacts.", {
    query: z.string().optional().describe("Name, address, note, or tag filter. Omit to list all contacts."),
    limit: z.number().min(1).max(100).optional(),
}, async ({ query, limit }) => {
    const contacts = await listAddressbookContacts(query);
    return text({
        store: await addressbookInfo(),
        contacts: contacts.slice(0, limit ?? 25),
    });
});
server.tool("addressbook_remove", "Remove a local MCP addressbook contact by name.", {
    name: z.string().min(1),
}, async ({ name }) => text(await removeAddressbookContact(name)));
server.tool("wallet_configure_low_value", "Enable or disable no-passphrase low-value signing for a local agent wallet.", {
    name: z.string().min(1),
    enabled: z.boolean(),
    passphrase: z.string().min(12).optional().describe("Required when enabling, unless LYTH_MCP_WALLET_PASSPHRASE is set."),
    maxAmount: z.string().optional().describe("Max LYTH per no-passphrase transaction."),
    dailyLimit: z.string().optional().describe("Optional daily LYTH cap."),
}, async ({ name, enabled, passphrase, maxAmount, dailyLimit }) => {
    return text({
        wallet: await configureLowValuePolicy({ name, enabled, passphrase, maxAmount, dailyLimit }),
        warning: enabled
            ? "Low-value mode is a local hot-wallet mode. It is convenient, not cold-wallet security."
            : "Low-value mode disabled. Future signing requires passphrase.",
    });
});
server.tool("wallet_export_mnemonic", "Reveal a wallet mnemonic after passphrase decryption. Use only for backup; never paste it into chats or logs.", {
    name: z.string().min(1),
    passphrase: z.string().min(12).optional(),
    confirm: z.literal("REVEAL_MNEMONIC"),
}, async ({ name, passphrase }) => {
    return text({
        name,
        mnemonic: await exportMnemonic(name, passphrase),
        warning: "This mnemonic controls the wallet. Store it offline and do not share it.",
    });
});
server.tool("wallet_delete", "Delete a local MCP wallet from the wallet store.", {
    name: z.string().min(1),
    confirmName: z.string().min(1).describe("Must exactly equal name."),
}, async ({ name, confirmName }) => text(await deleteWallet(name, confirmName)));
server.tool("wallet_build_transfer", "Build a native LYTH transfer from a stored MCP wallet. Can sign with passphrase or low-value hot mode. Broadcast is optional and gated. If broadcast fails, retry the returned signed payload with submit_signed_transaction; do not rebuild.", {
    walletName: z.string().min(1),
    to: z.string().describe("0x recipient address or exact addressbook contact name."),
    amount: z.string().describe("LYTH amount, e.g. 1.5."),
    passphrase: z.string().min(12).optional().describe("Required above low-value cap or when low-value mode is disabled."),
    sign: z.boolean().optional().describe("Sign encrypted envelope. Default true."),
    allowLowValueSigning: z.boolean().optional().describe("Allow no-passphrase signing when within configured cap. Default true."),
    broadcast: z.boolean().optional().describe("Broadcast signed encrypted envelope. Requires LYTH_MCP_ENABLE_SUBMIT=1."),
    gasLimit: z.string().optional().describe("Hex or decimal gas limit. Default 21000."),
    maxFeePerGas: z.string().optional().describe("Hex or decimal fee. Defaults to eth_gasPrice or 1 gwei fallback."),
    maxPriorityFeePerGas: z.string().optional().describe("Hex or decimal priority fee. Defaults to maxFeePerGas."),
    nonce: z.string().optional().describe("Hex or decimal nonce. Defaults to live eth_getTransactionCount."),
}, async ({ walletName, to, amount, passphrase, sign, allowLowValueSigning, broadcast, gasLimit, maxFeePerGas, maxPriorityFeePerGas, nonce }) => {
    const recipient = await resolveRecipient(to);
    if (!recipient) {
        return errorText("to must be a 0x wire address or exact addressbook contact name");
    }
    const shouldSign = sign ?? true;
    const endpoint = shouldSign ? await firstWritableEndpoint() : await firstReachableEndpoint();
    const wallets = await listWallets();
    const wallet = wallets.find((w) => w.name === walletName);
    if (!wallet) {
        return errorText(`wallet '${walletName}' not found`);
    }
    const resolvedNonce = nonce ? parseFlexibleBigint(nonce) : parseQuantity(await rpcCall(endpoint, "eth_getTransactionCount", [wallet.address, "latest"]));
    let fee = maxFeePerGas ? parseFlexibleBigint(maxFeePerGas) : 1000000000n;
    if (!maxFeePerGas) {
        try {
            fee = parseQuantity(await rpcCall(endpoint, "eth_gasPrice", []));
        }
        catch {
            fee = 1000000000n;
        }
    }
    const priority = maxPriorityFeePerGas ? parseFlexibleBigint(maxPriorityFeePerGas) : fee;
    const amountUnits = decimalToUnits(amount);
    const resolvedGasLimit = gasLimit ? parseFlexibleBigint(gasLimit) : 21000n;
    const preflight = await preflightTransfer({
        endpoint,
        walletName,
        from: wallet.address,
        to: recipient.address,
        amount,
        amountUnits,
        gasLimit: resolvedGasLimit,
        maxFeePerGas: fee,
        nonce: resolvedNonce,
        sign: shouldSign,
        allowLowValueSigning: shouldSign ? allowLowValueSigning ?? true : false,
        passphrase,
    });
    if (!preflight.ok) {
        return errorJson({ recipient, preflight });
    }
    const balance = preflight.checks.balance;
    const encryptionKey = shouldSign
        ? encryptionKeyFromRpc(await rpcCall(endpoint, "lyth_getEncryptionKey", []))
        : undefined;
    const built = await buildTransfer({
        walletName,
        to: recipient.address,
        amountUnits,
        chainId: CHAIN_ID,
        nonce: resolvedNonce,
        gasLimit: resolvedGasLimit,
        maxFeePerGas: fee,
        maxPriorityFeePerGas: priority,
        passphrase,
        encryptionKey,
        sign: shouldSign,
        allowLowValueSigning: shouldSign ? allowLowValueSigning ?? true : false,
    });
    if (shouldSign && !built.signed) {
        return errorText("sign=true but no passphrase was supplied and low-value signing is not configured for this wallet");
    }
    const summary = approvalSummary({
        walletName,
        from: wallet.address,
        to: recipient.address,
        recipientLabel: recipient.contact?.name,
        amount,
        asset: "LYTH",
        feeCeiling: balance?.estimatedFeeCeiling,
        remainingAfterCeiling: balance?.remainingAfterCeiling,
        lowValueRemaining: built.lowValuePolicy?.remainingToday,
        preflightOk: preflight.ok,
        violations: preflight.violations,
        warnings: preflight.warnings,
    });
    const outboxEntry = built.signed
        ? await addOutboxEntry({
            network: NETWORK,
            chainId: CHAIN_ID,
            kind: "lyth_encrypted",
            method: "lyth_submitEncrypted",
            payloadHex: built.signed.encryptedEnvelopeHex,
            walletName,
            from: wallet.address,
            to: recipient.address,
            amount,
            asset: "LYTH",
            nonce: toQuantity(resolvedNonce),
            expiresAt: defaultOutboxExpiresAt(),
            policySnapshot: built.lowValuePolicy ?? wallet.lowValue,
            lowValueReserved: built.lowValuePolicy?.used === true,
            note: "Created by wallet_build_transfer. Retry this payload from the outbox instead of rebuilding after transient broadcast failure.",
        })
        : null;
    let submitted = null;
    let broadcastError = null;
    if (broadcast) {
        if (!SUBMIT_ENABLED) {
            broadcastError = {
                endpoint,
                method: "lyth_submitEncrypted",
                message: "Broadcast disabled. Set LYTH_MCP_ENABLE_SUBMIT=1 to allow wallet_build_transfer broadcast.",
            };
        }
        else if (!built.signed) {
            broadcastError = {
                endpoint,
                method: "lyth_submitEncrypted",
                message: "Cannot broadcast unsigned transfer",
            };
        }
        else {
            try {
                const txHash = await submitPayload(endpoint, "lyth_encrypted", built.signed.encryptedEnvelopeHex);
                submitted = {
                    endpoint,
                    method: "lyth_submitEncrypted",
                    txHash,
                };
                if (outboxEntry) {
                    await recordOutboxAttempt(outboxEntry.id, {
                        at: new Date().toISOString(),
                        endpoint,
                        method: "lyth_submitEncrypted",
                        ok: true,
                        txHash,
                    });
                    if (outboxEntry.lowValueReserved && outboxEntry.status === "signed") {
                        await moveLowValueAccounting({ walletName, amount, from: "reserved", to: "submitted" });
                    }
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                broadcastError = {
                    endpoint,
                    method: "lyth_submitEncrypted",
                    message,
                };
                if (outboxEntry) {
                    await recordOutboxAttempt(outboxEntry.id, {
                        at: new Date().toISOString(),
                        endpoint,
                        method: "lyth_submitEncrypted",
                        ok: false,
                        error: message,
                    });
                }
            }
        }
    }
    const errorExplanation = broadcastError
        ? explainError({
            errorMessage: String(broadcastError.message ?? ""),
            rpcMethod: "lyth_submitEncrypted",
            tool: "wallet_build_transfer",
            outboxId: outboxEntry?.id,
            context: { broadcastError, preflight },
        })
        : null;
    const receipt = await addReceipt({
        kind: "wallet_transfer",
        status: submitted ? "submitted" : broadcastError ? "failed" : built.signed ? "signed" : "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Transfer ${amount} LYTH to ${recipient.contact?.name ?? short(recipient.address)}`,
        summary: `${walletName} -> ${recipient.address} (${amount} LYTH)`,
        walletName,
        from: wallet.address,
        to: recipient.address,
        amount,
        asset: "LYTH",
        outboxId: outboxEntry?.id,
        txHash: typeof submitted?.txHash === "string" ? submitted.txHash : undefined,
        payloadHash: outboxEntry?.payloadHash,
        endpoint,
        result: submitted ?? { signed: Boolean(built.signed), broadcastRequested: Boolean(broadcast), preflight, summary },
        error: broadcastError?.message,
    });
    return text({
        endpoint,
        recipient,
        summary,
        preflight,
        built,
        outbox: outboxEntry,
        receipt,
        submitted,
        broadcastError,
        errorExplanation,
        broadcastEnabled: SUBMIT_ENABLED,
        retry: built.signed
            ? {
                tool: outboxEntry ? "tx_outbox_retry" : "submit_signed_transaction",
                arguments: {
                    ...(outboxEntry
                        ? { id: outboxEntry.id }
                        : {
                            kind: "lyth_encrypted",
                            payloadHex: built.signed.encryptedEnvelopeHex,
                        }),
                },
                warning: "If broadcast failed, retry this exact signed payload. Do not call wallet_build_transfer again unless you intentionally want a new signed transfer and a new low-value allowance reservation.",
            }
            : null,
        lowValueAccounting: built.lowValuePolicy?.used
            ? "Low-value allowance is reserved when the signed payload is created, not when broadcast succeeds, because a signed payload can be submitted later."
            : "No low-value allowance was reserved for this build.",
    });
});
server.tool("account_overview", "Get live account balance, nonce, profile, and recent flow for a Monolythium address.", {
    address: z.string().describe("0x wire address or mono1 display address. Some RPC readers may require 0x."),
    flowLimit: z.number().min(1).max(250).optional().describe("Address flow sample size, default 25."),
}, async ({ address, flowLimit }) => {
    const endpoint = await firstReachableEndpoint();
    const [balance, nonce, profile, flow, label] = await Promise.allSettled([
        rpcCall(endpoint, "eth_getBalance", [address, "latest"]),
        rpcCall(endpoint, "eth_getTransactionCount", [address, "latest"]),
        rpcCall(endpoint, "lyth_addressProfile", [address]),
        rpcCall(endpoint, "lyth_addressFlow", [address, flowLimit ?? 25]),
        rpcCall(endpoint, "lyth_getAddressLabel", [address]),
    ]);
    return text({
        network: NETWORK,
        chainId: CHAIN_ID,
        endpoint,
        address,
        balance: balance.status === "fulfilled" ? balance.value : { error: balance.reason?.message ?? String(balance.reason) },
        nonce: nonce.status === "fulfilled" ? parseQuantity(nonce.value).toString() : { error: nonce.reason?.message ?? String(nonce.reason) },
        profile: profile.status === "fulfilled" ? profile.value : { error: profile.reason?.message ?? String(profile.reason) },
        flow: flow.status === "fulfilled" ? flow.value : { error: flow.reason?.message ?? String(flow.reason) },
        label: label.status === "fulfilled" ? label.value : { error: label.reason?.message ?? String(label.reason) },
    });
});
server.tool("recent_transactions", "Get recent live transactions from lyth_txFeed.", {
    limit: z.number().min(1).max(100).optional().describe("Number of transactions, default 25."),
    cursor: z.string().optional().describe("Optional feed cursor."),
}, async ({ limit, cursor }) => {
    const endpoint = await firstReachableEndpoint();
    const params = cursor ? [limit ?? 25, cursor] : [limit ?? 25];
    return text(await rpcCall(endpoint, "lyth_txFeed", params));
});
server.tool("tx_lookup", "Look up a transaction by hash, including status, receipt, decoded view, and raw transaction where available.", { txHash: z.string().describe("0x transaction hash") }, async ({ txHash }) => {
    if (!isHex(txHash)) {
        return errorText("txHash must be 0x-prefixed hex");
    }
    const endpoint = await firstReachableEndpoint();
    const [status, receipt, tx, decoded] = await Promise.allSettled([
        rpcCall(endpoint, "lyth_txStatus", [txHash]),
        rpcCall(endpoint, "eth_getTransactionReceipt", [txHash]),
        rpcCall(endpoint, "eth_getTransactionByHash", [txHash]),
        rpcCall(endpoint, "lyth_decodeTx", [txHash]),
    ]);
    return text({
        txHash,
        endpoint,
        status: status.status === "fulfilled" ? status.value : { error: status.reason?.message ?? String(status.reason) },
        receipt: receipt.status === "fulfilled" ? receipt.value : { error: receipt.reason?.message ?? String(receipt.reason) },
        transaction: tx.status === "fulfilled" ? tx.value : { error: tx.reason?.message ?? String(tx.reason) },
        decoded: decoded.status === "fulfilled" ? decoded.value : { error: decoded.reason?.message ?? String(decoded.reason) },
    });
});
server.tool("tx_error_explain", "Explain a failed send, RPC error, policy failure, bridge refusal, privacy violation, or contract revert in plain English.", {
    errorMessage: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    rpcMethod: z.string().optional(),
    tool: z.string().optional(),
    txHash: z.string().optional(),
    outboxId: z.string().optional(),
    context: recordSchema,
}, async (args) => text(explainError(args)));
server.tool("ask_chain", "Route a natural-language blockchain question to a typed MCP path and return cited data sources.", {
    question: z.string().min(1),
    format: z.enum(["json", "markdown"]).optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ question, format, limit }) => {
    const lower = question.toLowerCase();
    const asText = (payload) => format === "markdown" ? text(askChainText(payload)) : text(payload);
    const txHash = extractTxHash(question);
    if (txHash) {
        const endpoint = await firstReachableEndpoint();
        const [status, receipt, tx, decoded] = await Promise.allSettled([
            rpcCall(endpoint, "lyth_txStatus", [txHash]),
            rpcCall(endpoint, "eth_getTransactionReceipt", [txHash]),
            rpcCall(endpoint, "eth_getTransactionByHash", [txHash]),
            rpcCall(endpoint, "lyth_decodeTx", [txHash]),
        ]);
        return asText({
            question,
            intent: "transaction_lookup",
            typedTool: "tx_lookup",
            sources: [{ type: "rpc", endpoint, methods: ["lyth_txStatus", "eth_getTransactionReceipt", "eth_getTransactionByHash", "lyth_decodeTx"] }],
            result: {
                txHash,
                status: status.status === "fulfilled" ? status.value : { error: status.reason?.message ?? String(status.reason) },
                receipt: receipt.status === "fulfilled" ? receipt.value : { error: receipt.reason?.message ?? String(receipt.reason) },
                transaction: tx.status === "fulfilled" ? tx.value : { error: tx.reason?.message ?? String(tx.reason) },
                decoded: decoded.status === "fulfilled" ? decoded.value : { error: decoded.reason?.message ?? String(decoded.reason) },
            },
        });
    }
    const address = extractAddress(question);
    if (address) {
        const endpoint = await firstReachableEndpoint();
        const [balance, nonce, profile, flow, label] = await Promise.allSettled([
            rpcCall(endpoint, "eth_getBalance", [address, "latest"]),
            rpcCall(endpoint, "eth_getTransactionCount", [address, "latest"]),
            rpcCall(endpoint, "lyth_addressProfile", [address]),
            rpcCall(endpoint, "lyth_addressFlow", [address, limit ?? 25]),
            rpcCall(endpoint, "lyth_getAddressLabel", [address]),
        ]);
        return asText({
            question,
            intent: "account_overview",
            typedTool: "account_overview",
            sources: [{ type: "rpc", endpoint, methods: ["eth_getBalance", "eth_getTransactionCount", "lyth_addressProfile", "lyth_addressFlow", "lyth_getAddressLabel"] }],
            result: {
                address,
                balance: balance.status === "fulfilled" ? balance.value : { error: balance.reason?.message ?? String(balance.reason) },
                nonce: nonce.status === "fulfilled" ? parseQuantity(nonce.value).toString() : { error: nonce.reason?.message ?? String(nonce.reason) },
                profile: profile.status === "fulfilled" ? profile.value : { error: profile.reason?.message ?? String(profile.reason) },
                flow: flow.status === "fulfilled" ? flow.value : { error: flow.reason?.message ?? String(flow.reason) },
                label: label.status === "fulfilled" ? label.value : { error: label.reason?.message ?? String(label.reason) },
            },
        });
    }
    if (/(readiness|mainnet gate|mainnet readiness|production readiness|what.*left|completion)/i.test(question)) {
        const [vendors, assets, bridges, runbooks, wallets] = await Promise.all([
            loadVendors(),
            loadAssets(),
            loadBridgeRoutes(),
            listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH),
            listWallets(),
        ]);
        return asText({
            question,
            intent: "readiness_check",
            typedTool: "readiness_check",
            sources: [
                { type: "local_registry", path: VENDOR_REGISTRY_PATH, hash: vendors.payloadHash },
                { type: "local_registry", path: ASSET_REGISTRY_PATH, hash: assets.contentHash },
                { type: "local_registry", path: BRIDGE_ROUTE_REGISTRY_PATH, hash: bridges.contentHash },
                { type: "local_registry", path: RUNBOOK_REGISTRY_PATH },
            ],
            result: readinessCheck({
                toolNames: MCP_TOOL_NAMES,
                runbookCount: runbooks.length,
                vendorCount: vendors.registry.vendors.length,
                bridgeRouteCount: bridges.registry.routes.length,
                activeBridgeRouteCount: bridges.registry.routes.filter((route) => route.status === "active").length,
                assetCount: assets.registry.assets.length,
                walletCount: wallets.length,
                docsUpdated: true,
                testsUpdated: true,
            }),
        });
    }
    if (/(security|threat|emergency|recovery|blast[-\s]?radius|audit gate|research gate|g3|checkpoint)/i.test(question)) {
        const context = await buildSecurityContext({ includeRpc: !/(audit gate|research gate|recovery|blast[-\s]?radius)/i.test(question) });
        const typedTool = /recovery/i.test(question)
            ? "recovery_status"
            : /blast[-\s]?radius|bridge.*risk|bridge.*freeze/i.test(question)
                ? "bridge_blast_radius"
                : /audit gate|research gate/i.test(question)
                    ? "audit_gate_dashboard"
                    : /emergency|g3|checkpoint/i.test(question)
                        ? "emergency_state_watch"
                        : "security_status";
        const result = typedTool === "recovery_status"
            ? recoveryStatus(context)
            : typedTool === "bridge_blast_radius"
                ? bridgeBlastRadiusMonitor(context)
                : typedTool === "audit_gate_dashboard"
                    ? auditResearchGateDashboard(context)
                    : typedTool === "emergency_state_watch"
                        ? emergencyStateWatch(context)
                        : securityStatus(context);
        return asText({
            question,
            intent: typedTool,
            typedTool,
            sources: [
                { type: "local_registry", path: BRIDGE_ROUTE_REGISTRY_PATH },
                { type: "local_registry", path: CLUSTER_REGISTRY_PATH },
                { type: "local_store", path: "wallet/outbox/receipts stores" },
            ],
            result,
        });
    }
    if (/(wallet safety|account safety|hot wallet|low[-\s]?value policy|passkey|threshold|hardware wallet)/i.test(question)) {
        const wallets = await listWallets();
        const amount = extractDecimal(question);
        const firstWallet = wallets[0];
        const typedTool = /passkey|threshold|hardware wallet/i.test(question)
            ? "wallet_threshold_explain"
            : /simulate|would|can.*spend|send|pay/i.test(question) && amount && firstWallet
                ? "hot_wallet_policy_simulate"
                : "wallet_safety_profile";
        const result = typedTool === "wallet_threshold_explain"
            ? explainWalletThresholds({ amount, asset: inferSymbol(question, ["LYTH", "USDC"]) })
            : typedTool === "hot_wallet_policy_simulate" && firstWallet && amount
                ? simulateHotWalletPolicy({ wallet: firstWallet, amount, asset: inferSymbol(question, ["LYTH", "USDC"]), category: /food|pizza/i.test(question) ? "food" : undefined })
                : accountSafetyProfiles({
                    wallets,
                    outboxEntries: await listOutboxEntries({ limit: 100 }),
                    receipts: await listReceipts({ limit: 100 }),
                });
        return asText({
            question,
            intent: typedTool,
            typedTool,
            sources: [{ type: "local_store", path: "wallet/outbox/receipts stores" }],
            result,
        });
    }
    if (/(demo connector|connector template|stripe|coinsbee|agent commerce protocol|universal commerce protocol|ucp|acp)/i.test(question)) {
        const kind = /stripe/i.test(question)
            ? "stripe"
            : /coinsbee/i.test(question)
                ? "coinsbee"
                : /\bucp\b|universal commerce protocol/i.test(question)
                    ? "universal_commerce_protocol"
                    : /\bacp\b|agent commerce protocol/i.test(question)
                        ? "agent_commerce_protocol"
                        : /travel|flight/i.test(question)
                            ? "travel"
                            : /food|pizza/i.test(question)
                                ? "food"
                                : /service|plumber/i.test(question)
                                    ? "service_provider"
                                    : undefined;
        return asText({
            question,
            intent: "demo_connector_templates",
            typedTool: "demo_connector_templates",
            sources: [{ type: "local_templates", module: "demo_connectors" }],
            result: {
                warning: "TODO/demo stubs only.",
                templates: listDemoConnectorTemplates({ kind }),
            },
        });
    }
    if (/(error|failed|revert|decryption|mempool|policy|refused|rejected)/i.test(question)) {
        return asText({
            question,
            intent: "error_explanation",
            typedTool: "tx_error_explain",
            sources: [{ type: "local_classifier", module: "error_explain" }],
            result: explainError({ errorMessage: question, tool: "ask_chain" }),
        });
    }
    if (/(status|health|sync|mempool|rpc health|rpc status)/i.test(question) && !/(node|tpm|pcr|attestation|hosting|cluster|operator|validator|prover|gpu|proof|zkml|foundation|decentralization|decentralisation|stake|staking|delegation cap|stake cap|over[-\s]?cap|taper|monarch|quorum|service roi|resource pressure)/i.test(question)) {
        const endpoint = await firstReachableEndpoint();
        const [stats, round, mempool, indexer, sync] = await Promise.allSettled([
            rpcCall(endpoint, "lyth_chainStats"),
            rpcCall(endpoint, "lyth_getRound"),
            rpcCall(endpoint, "lyth_mempoolStatus"),
            rpcCall(endpoint, "lyth_indexerStatus"),
            rpcCall(endpoint, "eth_syncing"),
        ]);
        return asText({
            question,
            intent: "chain_status",
            typedTool: "chain_status",
            sources: [{ type: "rpc", endpoint, methods: ["lyth_chainStats", "lyth_getRound", "lyth_mempoolStatus", "lyth_indexerStatus", "eth_syncing"] }],
            result: {
                network: NETWORK,
                chainId: CHAIN_ID,
                stats: stats.status === "fulfilled" ? stats.value : { error: stats.reason?.message ?? String(stats.reason) },
                round: round.status === "fulfilled" ? round.value : { error: round.reason?.message ?? String(round.reason) },
                mempool: mempool.status === "fulfilled" ? mempool.value : { error: mempool.reason?.message ?? String(mempool.reason) },
                indexer: indexer.status === "fulfilled" ? indexer.value : { error: indexer.reason?.message ?? String(indexer.reason) },
                syncing: sync.status === "fulfilled" ? sync.value : { error: sync.reason?.message ?? String(sync.reason) },
            },
        });
    }
    if (/(node|tpm|pcr|attestation|hosting class|hosting risk)/i.test(question)) {
        const registry = await loadNodes();
        const node = registry.registry.nodes.find((item) => lower.includes(item.id.toLowerCase()));
        const role = /prover/i.test(question)
            ? "prover"
            : /validator/i.test(question)
                ? "validator"
                : /\brpc\b/i.test(question)
                    ? "rpc"
                    : /archive/i.test(question)
                        ? "archive"
                        : /oracle/i.test(question)
                            ? "oracle"
                            : undefined;
        const pcr = question.match(/\bpcr\s*(\d+)\b/i)?.[1];
        if (node) {
            return asText({
                question,
                intent: pcr ? "node_pcr_explain" : /hosting/i.test(question) ? "node_hosting_class" : "node_attestation_get",
                typedTool: pcr ? "node_pcr_explain" : /hosting/i.test(question) ? "node_hosting_class" : "node_attestation_get",
                sources: [{ type: "local_registry", path: NODE_REGISTRY_PATH, hash: registry.contentHash }],
                result: {
                    node,
                    attestation: nodeAttestation(node),
                    pcr: pcr ? explainPcr(node, pcr) : undefined,
                    hosting: /hosting/i.test(question) ? nodeHostingClass(node) : undefined,
                },
            });
        }
        return asText({
            question,
            intent: /diversity/i.test(question) ? "node_diversity_score" : "node_search",
            typedTool: /diversity/i.test(question) ? "node_diversity_score" : "node_search",
            sources: [{ type: "local_registry", path: NODE_REGISTRY_PATH, hash: registry.contentHash }],
            result: {
                registry: nodeRegistrySummary(registry),
                diversity: /diversity/i.test(question) ? nodeDiversityScore(registry.registry, { role }) : undefined,
                nodes: listNodes(registry.registry, {
                    query: /tpm/i.test(question) ? undefined : question,
                    role,
                    attestationStatus: /verified/i.test(question) ? "verified" : undefined,
                    tpmRequired: /tpm/i.test(question) ? true : undefined,
                    gpuRequired: /gpu/i.test(question) ? true : undefined,
                    limit: limit ?? 10,
                }).map((item) => ({
                    node: item,
                    attestation: nodeAttestation(item),
                    hosting: nodeHostingClass(item),
                })),
            },
        });
    }
    if (/(cluster|operator|validator|prover|gpu|proof|zkml|foundation|decentralization|decentralisation|stake|staking|delegation cap|stake cap|over[-\s]?cap|taper|monarch|quorum|service roi|resource pressure|archive service|oracle service)/i.test(question)) {
        const registry = await loadClusters();
        if (/delegation cap|stake cap|over[-\s]?cap|taper/i.test(question)) {
            return asText({
                question,
                intent: "delegation_cap_explain",
                typedTool: "delegation_cap_explain",
                sources: [{ type: "local_policy", module: "delegation", warning: "TODO(mainnet): replace with signed staking parameters." }],
                result: explainDelegationCaps({
                    phase: /bootstrap/i.test(question) ? "bootstrap" : /mature/i.test(question) ? "mature" : "growth",
                    totalDelegatedStake: extractDecimal(question),
                }),
            });
        }
        if (/autovote|rebalance|undelegate|delegate|stake status/i.test(question)) {
            const mode = /yield/i.test(question)
                ? "max_yield"
                : /diversity/i.test(question)
                    ? "max_diversity"
                    : /decentralization|decentralisation/i.test(question)
                        ? "max_decentralization"
                        : "custom";
            const clusterId = registry.registry.clusters.find((cluster) => lower.includes(cluster.id.toLowerCase()))?.id
                ?? listClusters(registry.registry, { status: "active", foundationControlled: mode === "max_decentralization" ? false : undefined, limit: 1 })[0]?.id;
            const amount = extractDecimal(question) ?? "0";
            const typedTool = /autovote/i.test(question)
                ? "autovote_simulate"
                : /rebalance/i.test(question)
                    ? "rebalance_draft"
                    : /undelegate/i.test(question)
                        ? "undelegate_draft"
                        : /delegate/i.test(question)
                            ? "delegate_draft"
                            : "stake_status";
            const result = typedTool === "autovote_simulate"
                ? autovoteSimulate(registry.registry, { mode })
                : typedTool === "rebalance_draft"
                    ? rebalanceDraft(registry.registry, { mode })
                    : typedTool === "undelegate_draft" && clusterId
                        ? undelegateDraft(registry.registry, { clusterId, amount })
                        : typedTool === "delegate_draft" && clusterId
                            ? delegateDraft(registry.registry, { clusterId, amount, mode })
                            : stakeStatus(registry.registry);
            return asText({
                question,
                intent: typedTool,
                typedTool,
                sources: [{ type: "local_registry", path: CLUSTER_REGISTRY_PATH, hash: registry.contentHash }],
                result,
            });
        }
        const region = /\beu\b|europe/i.test(question)
            ? "EU"
            : /\bna\b|us|america/i.test(question)
                ? "NA"
                : /apac|asia|singapore/i.test(question)
                    ? "APAC"
                    : undefined;
        const serviceType = /prover|gpu|proof|zkml/i.test(question)
            ? "prover"
            : /archive/i.test(question)
                ? "archive"
                : /\boracle\b/i.test(question)
                    ? "oracle"
                    : /\brpc\b/i.test(question)
                        ? "rpc"
                        : undefined;
        const foundationControlled = /foundation[-\s]?controlled|foundation/i.test(question)
            ? !/(not foundation|non[-\s]?foundation|community)/i.test(question)
            : /decentralization|decentralisation|stake|staking/i.test(question)
                ? false
                : undefined;
        if (/operator/i.test(question)) {
            return asText({
                question,
                intent: "operator_search",
                typedTool: "operator_search",
                sources: [{ type: "local_registry", path: CLUSTER_REGISTRY_PATH, hash: registry.contentHash }],
                result: {
                    registry: clusterRegistrySummary(registry),
                    operators: listOperators(registry.registry, {
                        region,
                        foundationControlled,
                        openSeatInterest: /open seat|apply|onboard/i.test(question) ? true : undefined,
                        limit: limit ?? 10,
                    }).map((operator) => operatorStatus(registry.registry, operator)),
                },
            });
        }
        const serviceResults = serviceType
            ? searchServices(registry.registry, {
                serviceType,
                region,
                activeOnly: true,
                limit: limit ?? 10,
            })
            : undefined;
        const wantsMonarch = /monarch|quorum|service roi|resource pressure|operator assistant|cluster health/i.test(question);
        const clusters = listClusters(registry.registry, {
            region,
            serviceType,
            foundationControlled,
            gpuRequired: /gpu/i.test(question) ? true : undefined,
            minOpenSeats: /open seat|operator|decentralization|decentralisation|stake|staking/i.test(question) ? 1 : undefined,
            limit: limit ?? 10,
        });
        const proofType = /zkml/i.test(question) ? "zkml" : /bridge.*proof|proof.*bridge/i.test(question) ? "bridge" : /proof/i.test(question) ? "generic" : undefined;
        return asText({
            question,
            intent: serviceType ? `${serviceType}_service_search` : "cluster_search",
            typedTool: wantsMonarch ? "monarch_operator_assistant" : proofType ? "gpu_proof_market_assistant" : serviceType === "prover" ? "prover_service_search" : serviceType ? `${serviceType}_service_search` : "cluster_search",
            sources: [{ type: "local_registry", path: CLUSTER_REGISTRY_PATH, hash: registry.contentHash }],
            result: {
                registry: clusterRegistrySummary(registry),
                proofType,
                monarch: wantsMonarch
                    ? monarchOperatorAssistant(registry.registry, { region, serviceType, limit: limit ?? 10 })
                    : undefined,
                services: serviceResults,
                clusters: clusters.map((cluster) => ({
                    ...cluster,
                    reputationSummary: clusterReputation(cluster),
                    foundation: clusterFoundationFlag(cluster),
                    sunset: clusterSunsetStatus(cluster),
                })),
                examples: [
                    "Show EU clusters with GPU prover service.",
                    "Which clusters are Foundation-controlled?",
                    "Which clusters maximize decentralization for my stake?",
                ],
            },
        });
    }
    if (/(vendor|provider|pizza|plumber|flight|gift\s*card|lawyer|legal|service|commerce)/i.test(question)) {
        const commerceSafety = commerceSafetyForVendor({ query: question });
        if (!commerceSafety.ok) {
            return errorJson({
                question,
                intent: "vendor_search",
                typedTool: "vendor_search",
                commerceSafety,
                refusal: "ask_chain refused vendor discovery by local commerce safety policy.",
            });
        }
        const registry = await loadVendors();
        const vendorQuery = lower.includes("pizza")
            ? "pizza"
            : lower.includes("plumber")
                ? "plumber"
                : lower.includes("flight")
                    ? "flight"
                    : lower.includes("gift")
                        ? "gift"
                        : lower.includes("lawyer") || lower.includes("legal")
                            ? "legal"
                            : question;
        const category = lower.includes("pizza")
            ? "food"
            : lower.includes("plumber")
                ? "home_services"
                : lower.includes("flight")
                    ? "travel"
                    : lower.includes("gift")
                        ? "gift_cards"
                        : lower.includes("lawyer") || lower.includes("legal")
                            ? "professional_services"
                            : undefined;
        return asText({
            question,
            intent: "vendor_search",
            typedTool: "vendor_search",
            sources: [{ type: "local_registry", path: VENDOR_REGISTRY_PATH, hash: registry.payloadHash }],
            result: {
                registry: vendorRegistrySummary(registry),
                commerceSafety,
                vendors: searchVendors(registry.registry, { query: vendorQuery, category, limit: limit ?? 10 }),
                examples: [
                    "Find a plumber under 150 LYTH.",
                    "Find a pizza vendor.",
                    "Find a crypto lawyer available this week.",
                ],
            },
        });
    }
    if (/(bridge|liquidity|route|cooldown|swap)/i.test(question)) {
        const bridgeRegistry = await loadBridgeRoutes();
        const assetRegistry = await loadAssets();
        const symbol = inferSymbol(question, assetRegistry.registry.assets.map((asset) => asset.symbol));
        const amount = extractDecimal(question);
        const route = symbol ? selectBridgeRoute(bridgeRegistry.registry, { asset: symbol, destinationChain: "Monolythium" }) : null;
        const quote = route && amount
            ? quoteBridgeRoute(route, { amount, asset: symbol, epochHours: bridgeRegistry.registry.epochHours })
            : undefined;
        return asText({
            question,
            intent: "bridge_routes",
            typedTool: amount && route ? "bridge_quote" : "bridge_routes",
            sources: [
                { type: "local_registry", path: BRIDGE_ROUTE_REGISTRY_PATH, hash: bridgeRegistry.contentHash },
                { type: "local_registry", path: ASSET_REGISTRY_PATH, hash: assetRegistry.contentHash },
            ],
            result: {
                asset: symbol,
                amount,
                registry: bridgeRegistrySummary(bridgeRegistry),
                quote,
                routes: listBridgeRoutes(bridgeRegistry.registry, { asset: symbol, limit: limit ?? 10 }),
            },
        });
    }
    if (/(asset|token|coin|lyth|usdc|btc|privacy|private)/i.test(question)) {
        const registry = await loadAssets();
        const symbol = inferSymbol(question, registry.registry.assets.map((asset) => asset.symbol));
        const assets = symbol
            ? [getAsset(registry.registry, symbol)]
            : listAssets(registry.registry, { query: question, limit: limit ?? 10 });
        return asText({
            question,
            intent: "asset_search",
            typedTool: symbol ? "asset_get" : "asset_search",
            sources: [{ type: "local_registry", path: ASSET_REGISTRY_PATH, hash: registry.contentHash }],
            result: {
                registry: assetRegistrySummary(registry),
                assets: assets.map((asset) => ({ ...asset, risk: assetRisk(asset) })),
            },
        });
    }
    if (/(market|clob|order\s*book|trades?)/i.test(question)) {
        const endpoint = await firstReachableEndpoint();
        return asText({
            question,
            intent: "markets",
            typedTool: "markets",
            sources: [{ type: "rpc", endpoint, methods: ["lyth_clobMarkets"] }],
            result: await rpcCall(endpoint, "lyth_clobMarkets", [limit ?? 25]),
        });
    }
    const endpoint = await firstReachableEndpoint();
    return asText({
        question,
        intent: "chain_search",
        typedTool: "search_chain",
        sources: [{ type: "rpc", endpoint, methods: ["lyth_search"] }],
        result: await rpcCall(endpoint, "lyth_search", [question, limit ?? 10]),
        examples: [
            "What is the status of the chain?",
            "Show 0x... account overview.",
            "Can I bridge 100 USDC?",
            "Find a plumber under 150 LYTH.",
        ],
    });
});
server.tool("search_chain", "Search live chain data for addresses, hashes, blocks, clusters, or labels.", {
    query: z.string(),
    limit: z.number().min(1).max(50).optional(),
}, async ({ query, limit }) => {
    const endpoint = await firstReachableEndpoint();
    return text(await rpcCall(endpoint, "lyth_search", [query, limit ?? 10]));
});
server.tool("markets", "Read live CLOB markets and optional market details/order book/trades.", {
    limit: z.number().min(1).max(100).optional(),
    marketId: z.string().optional(),
    includeBook: z.boolean().optional(),
    includeTrades: z.boolean().optional(),
}, async ({ limit, marketId, includeBook, includeTrades }) => {
    const endpoint = await firstReachableEndpoint();
    if (!marketId) {
        return text(await rpcCall(endpoint, "lyth_clobMarkets", [limit ?? 25]));
    }
    const [market, book, trades] = await Promise.allSettled([
        rpcCall(endpoint, "lyth_clobMarket", [marketId]),
        includeBook ? rpcCall(endpoint, "lyth_clobOrderBook", [marketId, 20]) : Promise.resolve(null),
        includeTrades ? rpcCall(endpoint, "lyth_clobTrades", [marketId, limit ?? 25]) : Promise.resolve(null),
    ]);
    return text({
        marketId,
        market: market.status === "fulfilled" ? market.value : { error: market.reason?.message ?? String(market.reason) },
        orderBook: book.status === "fulfilled" ? book.value : { error: book.reason?.message ?? String(book.reason) },
        trades: trades.status === "fulfilled" ? trades.value : { error: trades.reason?.message ?? String(trades.reason) },
    });
});
server.tool("list_runbooks", "List supported AI runbooks and their live-readiness status.", {}, async () => {
    const canonicalRunbooks = await listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH);
    return text({
        network: NETWORK,
        chainId: CHAIN_ID,
        runbooks: runbookCatalogue(),
        canonicalRunbooks,
        safety: {
            walletStorage: "optional local encrypted MCP wallet store; no plaintext keys or mnemonics",
            approval: "all economic actions require wallet/user approval",
            broadcasting: SUBMIT_ENABLED ? "enabled by env" : "disabled; set LYTH_MCP_ENABLE_SUBMIT=1 to enable signed-envelope broadcast",
        },
    });
});
server.tool("runbook_list", "List canonical runbook files with stable content hashes.", {}, async () => {
    return text({
        registry: RUNBOOK_REGISTRY_PATH,
        hashAlgorithm: "sha256",
        note: "This is a local canonical registry for MCP releases. The future protocol target is signed/hash-verified runbooks from SDK or on-chain metadata.",
        runbooks: await listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH),
    });
});
server.tool("runbook_get", "Load a canonical runbook by name or id, including content and content hash.", {
    idOrName: z.string().min(1).describe("Examples: pay_vendor, pay_vendor.v1."),
}, async ({ idOrName }) => {
    const runbook = await getCanonicalRunbook(RUNBOOK_REGISTRY_PATH, idOrName);
    return text({
        registry: RUNBOOK_REGISTRY_PATH,
        runbook,
    });
});
server.tool("runbook_verify", "Verify a canonical runbook hash, optionally against an expected hash.", {
    idOrName: z.string().min(1),
    expectedHash: z.string().optional().describe("Optional sha256:... content hash to compare."),
}, async ({ idOrName, expectedHash }) => {
    const runbook = await getCanonicalRunbook(RUNBOOK_REGISTRY_PATH, idOrName);
    const matchesExpected = expectedHash ? runbook.contentHash === expectedHash : true;
    return text({
        ok: matchesExpected,
        id: runbook.id,
        name: runbook.name,
        version: runbook.version,
        contentHash: runbook.contentHash,
        hashAlgorithm: runbook.hashAlgorithm,
        expectedHash: expectedHash ?? null,
        registry: RUNBOOK_REGISTRY_PATH,
        warning: "Hash verification proves local file content stability only. It is not yet a signed upstream registry.",
    });
});
server.tool("runbook_diff_versions", "Diff two canonical runbook versions by name/version id.", {
    left: z.string().min(1).describe("Left runbook id/name, e.g. pay_vendor.v1."),
    right: z.string().min(1).describe("Right runbook id/name."),
}, async ({ left, right }) => {
    const leftRunbook = await getCanonicalRunbook(RUNBOOK_REGISTRY_PATH, left);
    const rightRunbook = await getCanonicalRunbook(RUNBOOK_REGISTRY_PATH, right);
    return text({
        left: {
            id: leftRunbook.id,
            contentHash: leftRunbook.contentHash,
        },
        right: {
            id: rightRunbook.id,
            contentHash: rightRunbook.contentHash,
        },
        sameHash: leftRunbook.contentHash === rightRunbook.contentHash,
        changes: diffRunbookContent(leftRunbook.content, rightRunbook.content),
    });
});
server.tool("draft_runbook", "Draft a typed AI runbook for payment, booking, escrow, trading, policy, receipt, or vendor-rating workflows.", {
    runbook: runbookEnum,
    fields: recordSchema.describe("Runbook-specific fields such as recipient, amount, asset, vendorId, service, marketId."),
    policy: policySchema.describe("Optional spending policy constraints to evaluate while drafting."),
    agent: recordSchema.describe("Optional agent identity metadata."),
    principal: recordSchema.describe("Optional human or organization principal metadata."),
}, async (args) => text(await buildVerifiedRunbookDraft(args)));
server.tool("validate_runbook", "Validate a drafted runbook against spending-policy and MCP safety rules.", {
    runbook: runbookEnum,
    fields: recordSchema,
    policy: policySchema,
    agent: recordSchema,
    principal: recordSchema,
}, async (args) => {
    const draft = await buildVerifiedRunbookDraft(args);
    return text({ draft, validation: validateRunbook(draft) });
});
server.tool("prepare_wallet_request", "Prepare a wallet approval payload from a runbook. MVP supports native LYTH pay_vendor transfers.", {
    runbook: runbookEnum,
    from: z.string().optional().describe("0x sender address required for live wallet payloads."),
    fields: recordSchema,
    policy: policySchema,
    agent: recordSchema,
    principal: recordSchema,
}, async ({ from, ...args }) => {
    const draft = await buildVerifiedRunbookDraft(args);
    return text({ draft, prepared: prepareWalletRequest(draft, from) });
});
server.tool("submit_signed_transaction", "Broadcast an already-signed transaction/envelope. Disabled unless LYTH_MCP_ENABLE_SUBMIT=1. This tool never signs.", {
    kind: z.literal("lyth_encrypted").default("lyth_encrypted").describe("Native encrypted envelopes use lyth_submitEncrypted."),
    payloadHex: z.string().describe("0x-prefixed signed raw transaction or encrypted envelope hex."),
    outboxId: z.string().optional().describe("Optional local outbox id to update with the broadcast attempt."),
    allowExpired: z.boolean().optional().describe("Allow submitting an outbox payload after local reservation expiry. Default false."),
}, async ({ kind, payloadHex, outboxId, allowExpired }) => {
    if (!isHex(payloadHex)) {
        return errorText("payloadHex must be 0x-prefixed hex");
    }
    if (!SUBMIT_ENABLED) {
        return errorText("Broadcast disabled. Set LYTH_MCP_ENABLE_SUBMIT=1 to allow this MCP to submit already-signed payloads.");
    }
    const entry = outboxId ? await getOutboxEntry(outboxId) : null;
    if (entry?.status === "expired" && allowExpired !== true) {
        return errorText("Outbox entry is expired locally. Set allowExpired=true only if the user explicitly wants to submit a payload whose MCP allowance reservation was released.");
    }
    const endpoint = await firstWritableEndpoint();
    const method = outboxMethod(kind);
    try {
        const txHash = await rpcCall(endpoint, method, [payloadHex]);
        const outbox = outboxId
            ? await recordOutboxAttempt(outboxId, { at: new Date().toISOString(), endpoint, method, ok: true, txHash })
            : null;
        let lowValueAccounting = null;
        if (entry?.lowValueReserved && entry.walletName && entry.amount) {
            if (entry.status === "signed") {
                lowValueAccounting = await moveLowValueAccounting({ walletName: entry.walletName, amount: entry.amount, from: "reserved", to: "submitted" });
            }
            else if (entry.status === "expired" && allowExpired === true) {
                lowValueAccounting = await moveLowValueAccounting({ walletName: entry.walletName, amount: entry.amount, from: "expired", to: "submitted" });
            }
        }
        const receipt = await addReceipt({
            kind: "submit_signed_transaction",
            status: "submitted",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: "Submitted signed transaction",
            summary: `${method} -> ${txHash}`,
            outboxId,
            txHash,
            endpoint,
            result: { method, txHash, lowValueAccounting },
        });
        return text({ endpoint, method, txHash, outbox, receipt, lowValueAccounting });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const outbox = outboxId
            ? await recordOutboxAttempt(outboxId, { at: new Date().toISOString(), endpoint, method, ok: false, error: message })
            : null;
        const receipt = await addReceipt({
            kind: "submit_signed_transaction",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: "Failed signed transaction submission",
            summary: `${method} failed`,
            outboxId,
            endpoint,
            error: message,
        });
        return text({
            endpoint,
            method,
            outbox,
            receipt,
            error: message,
            errorExplanation: explainError({
                errorMessage: message,
                rpcMethod: method,
                tool: "submit_signed_transaction",
                outboxId,
                context: { outbox },
            }),
        });
    }
});
server.tool("tx_outbox_list", "List local signed payloads that can be retried without rebuilding/re-signing.", {
    status: outboxStatusEnum.optional(),
    walletName: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ status, walletName, limit }) => text({
    store: await outboxInfo(),
    entries: await listOutboxEntries({ status: status, walletName, limit }),
}));
server.tool("tx_outbox_get", "Get a local outbox entry by id.", { id: z.string().min(1) }, async ({ id }) => text(await getOutboxEntry(id)));
server.tool("tx_outbox_retry", "Retry a signed payload from the local outbox. Requires LYTH_MCP_ENABLE_SUBMIT=1.", {
    id: z.string().min(1),
    allowExpired: z.boolean().optional().describe("Allow retrying after local reservation expiry. Default false."),
}, async ({ id, allowExpired }) => {
    const entry = await getOutboxEntry(id);
    if (entry.status === "expired" && allowExpired !== true) {
        return errorText("Outbox entry is expired locally. Set allowExpired=true only if the user explicitly wants to submit a payload whose MCP allowance reservation was released.");
    }
    if (!SUBMIT_ENABLED) {
        return errorText("Broadcast disabled. Set LYTH_MCP_ENABLE_SUBMIT=1 to retry outbox payloads.");
    }
    const endpoint = await firstWritableEndpoint();
    const method = outboxMethod(entry.kind);
    try {
        const txHash = await submitPayload(endpoint, entry.kind, entry.payloadHex);
        const outbox = await recordOutboxAttempt(id, { at: new Date().toISOString(), endpoint, method, ok: true, txHash });
        let lowValueAccounting = null;
        if (entry.lowValueReserved && entry.walletName && entry.amount) {
            if (entry.status === "signed") {
                lowValueAccounting = await moveLowValueAccounting({ walletName: entry.walletName, amount: entry.amount, from: "reserved", to: "submitted" });
            }
            else if (entry.status === "expired" && allowExpired === true) {
                lowValueAccounting = await moveLowValueAccounting({ walletName: entry.walletName, amount: entry.amount, from: "expired", to: "submitted" });
            }
        }
        const receipt = await addReceipt({
            kind: "tx_outbox_retry",
            status: "submitted",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Retried outbox ${id}`,
            summary: `${method} -> ${txHash}`,
            walletName: entry.walletName,
            from: entry.from,
            to: entry.to,
            amount: entry.amount,
            asset: entry.asset,
            outboxId: id,
            txHash,
            payloadHash: entry.payloadHash,
            endpoint,
            result: { method, txHash, lowValueAccounting },
        });
        return text({ endpoint, method, txHash, outbox, receipt, lowValueAccounting });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const outbox = await recordOutboxAttempt(id, { at: new Date().toISOString(), endpoint, method, ok: false, error: message });
        const receipt = await addReceipt({
            kind: "tx_outbox_retry",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Failed retry for outbox ${id}`,
            summary: `${method} failed`,
            walletName: entry.walletName,
            from: entry.from,
            to: entry.to,
            amount: entry.amount,
            asset: entry.asset,
            outboxId: id,
            payloadHash: entry.payloadHash,
            endpoint,
            error: message,
        });
        return text({
            endpoint,
            method,
            outbox,
            receipt,
            error: message,
            errorExplanation: explainError({
                errorMessage: message,
                rpcMethod: method,
                tool: "tx_outbox_retry",
                outboxId: id,
                context: { outbox },
            }),
        });
    }
});
server.tool("tx_outbox_forget", "Remove a local outbox entry. This does not invalidate an already-signed payload.", {
    id: z.string().min(1),
    confirm: z.literal("FORGET_SIGNED_PAYLOAD"),
}, async ({ id }) => text({
    ...(await forgetOutboxEntry(id)),
    warning: "Forgetting removes the local record only. It cannot invalidate a signed payload that was copied elsewhere.",
}));
server.tool("tx_outbox_release", "Release a local low-value allowance reservation for a signed/not-submitted outbox entry. This cannot invalidate the signed payload.", {
    id: z.string().min(1),
    target: z.enum(["expired", "failed"]).optional().describe("Accounting bucket to move the reservation into. Default expired."),
    confirm: z.literal("RELEASE_LOW_VALUE_RESERVATION"),
}, async ({ id, target }) => text(await releaseLowValueReservation({ outboxId: id, to: target ?? "expired" })));
server.tool("tx_outbox_expire_stale", "List or release expired signed/not-submitted low-value outbox reservations.", {
    release: z.boolean().optional().describe("When true, release eligible reservations. Default false."),
    confirm: z.literal("EXPIRE_STALE_RESERVATIONS").optional().describe("Required when release=true."),
    limit: z.number().min(1).max(100).optional(),
}, async ({ release, confirm, limit }) => {
    if (release && confirm !== "EXPIRE_STALE_RESERVATIONS") {
        return errorText("confirm must be EXPIRE_STALE_RESERVATIONS when release=true");
    }
    const entries = (await listOutboxEntries({ limit: limit ?? 100 }))
        .filter((entry) => entry.status === "signed" && entry.lowValueReserved === true && isPast(entry.expiresAt));
    if (!release) {
        return text({
            release: false,
            eligible: entries,
            warning: "These entries are locally expired candidates. Expiring them releases MCP allowance only; signed payloads may still be valid elsewhere.",
        });
    }
    const released = [];
    for (const entry of entries) {
        released.push(await releaseLowValueReservation({ outboxId: entry.id, to: "expired" }));
    }
    return text({
        release: true,
        count: released.length,
        released,
        warning: "Released local MCP allowance reservations only. This cannot invalidate signed payloads copied elsewhere.",
    });
});
server.tool("tx_status_summary", "Summarize live transaction status by tx hash or local outbox id.", {
    txHash: z.string().optional(),
    outboxId: z.string().optional(),
}, async ({ txHash, outboxId }) => {
    if (!txHash && !outboxId) {
        return errorText("txHash or outboxId is required");
    }
    return text(await txStatusSummary({ txHash, outboxId }));
});
server.tool("tx_watch", "Poll transaction status by tx hash or outbox id until confirmed, failed, or attempts are exhausted.", {
    txHash: z.string().optional(),
    outboxId: z.string().optional(),
    attempts: z.number().min(1).max(30).optional().describe("Default 6."),
    intervalMs: z.number().min(250).max(10_000).optional().describe("Default 2000."),
}, async ({ txHash, outboxId, attempts, intervalMs }) => {
    if (!txHash && !outboxId) {
        return errorText("txHash or outboxId is required");
    }
    const snapshots = [];
    const maxAttempts = attempts ?? 6;
    const waitMs = intervalMs ?? 2_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const snapshot = await txStatusSummary({ txHash, outboxId });
        snapshots.push({ attempt, snapshot });
        const derived = snapshot.derived;
        if (derived === "confirmed" || derived === "failed") {
            return text({
                done: true,
                final: derived,
                attempts: attempt,
                snapshots,
            });
        }
        if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    return text({
        done: false,
        final: "pending_or_not_found",
        attempts: maxAttempts,
        snapshots,
    });
});
server.tool("receipt_list", "List local MCP receipts for drafted, signed, submitted, confirmed, or failed operations.", {
    status: receiptStatusEnum.optional(),
    kind: z.string().optional(),
    walletName: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ status, kind, walletName, limit }) => text({
    store: await receiptInfo(),
    receipts: await listReceipts({ status: status, kind, walletName, limit }),
}));
server.tool("receipt_get", "Get one local MCP receipt by id.", { id: z.string().min(1) }, async ({ id }) => text(await getReceipt(id)));
server.tool("receipt_export", "Export a local MCP receipt as JSON.", { id: z.string().min(1) }, async ({ id }) => text({
    receipt: await getReceipt(id),
    format: "json",
}));
server.tool("mcp_dashboard", "Render a compact Markdown dashboard for Claude Code or other text UIs.", {
    includeEntries: z.boolean().optional().describe("Include recent outbox/receipt rows. Default true."),
}, async ({ includeEntries }) => {
    const wallets = await listWallets();
    const outbox = await listOutboxEntries({ limit: 10 });
    const receipts = await listReceipts({ limit: 10 });
    const connectors = await listConnectors({ limit: 10 });
    const orders = await listOrders({ limit: 10 });
    const bookings = await listBookings({ limit: 10 });
    const invoices = await listInvoices({ limit: 10 });
    const merchantPolicies = await listMerchantPolicies({ limit: 10 });
    const contacts = await listAddressbookContacts();
    const walletInfo = await walletStoreInfo();
    const contactInfo = await addressbookInfo();
    const outboxStore = await outboxInfo();
    const receiptStore = await receiptInfo();
    const connectorStore = await connectorStoreInfo();
    const orderStore = await orderStoreInfo();
    const bookingStore = await bookingStoreInfo();
    const invoiceStore = await invoiceStoreInfo();
    const merchantPolicyStore = await merchantPolicyStoreInfo();
    const [securityContext, vendors, assets, bridgeRoutes, runbooks] = await Promise.all([
        buildSecurityContext({ includeRpc: false }),
        loadVendors(),
        loadAssets(),
        loadBridgeRoutes(),
        listCanonicalRunbooks(RUNBOOK_REGISTRY_PATH),
    ]);
    const securitySummary = securityStatus(securityContext);
    const readinessSummary = readinessCheck({
        toolNames: MCP_TOOL_NAMES,
        runbookCount: runbooks.length,
        vendorCount: vendors.registry.vendors.length,
        bridgeRouteCount: bridgeRoutes.registry.routes.length,
        activeBridgeRouteCount: bridgeRoutes.registry.routes.filter((route) => route.status === "active").length,
        assetCount: assets.registry.assets.length,
        walletCount: wallets.length,
        docsUpdated: true,
        testsUpdated: true,
    });
    const lines = [
        "# Lyth MCP Dashboard",
        "",
        `Network: ${NETWORK} (${CHAIN_ID})`,
        `Broadcast: ${SUBMIT_ENABLED ? "enabled" : "disabled"}`,
        `Security: ${securitySummary.severity}`,
        `Readiness: ${readinessSummary.completionPercent}% (${readinessSummary.status})`,
        "",
        mdTable(["Store", "Count", "Path"], [
            ["Wallets", String(wallets.length), walletInfo.path],
            ["Contacts", String(contacts.length), contactInfo.path],
            ["Outbox", String(outboxStore.entryCount), outboxStore.path],
            ["Receipts", String(receiptStore.receiptCount), receiptStore.path],
            ["Connectors", String(connectorStore.connectorCount), connectorStore.path],
            ["Orders", String(orderStore.orderCount), orderStore.path],
            ["Bookings", String(bookingStore.bookingCount), bookingStore.path],
            ["Invoices", String(invoiceStore.invoiceCount), invoiceStore.path],
            ["Merchant Policies", String(merchantPolicyStore.policyCount), merchantPolicyStore.path],
        ]),
        "",
        "## Wallets",
        wallets.length
            ? mdTable(["Name", "Address", "Mode", "Cap", "Daily", "Reserved", "Submitted", "Paused", "Purpose"], wallets.map((wallet) => {
                const low = wallet.lowValue;
                const agent = wallet.agent;
                return [
                    wallet.name,
                    short(wallet.address),
                    wallet.keyProtection,
                    low?.maxAmount ?? "",
                    low?.dailyLimit ?? "",
                    low?.accounting?.reserved ?? "",
                    low?.accounting?.submitted ?? "",
                    agent?.paused ? "yes" : "no",
                    agent?.purpose ?? "",
                ];
            }))
            : "No wallets.",
    ];
    if (includeEntries !== false) {
        lines.push("", "## Outbox", outbox.length
            ? mdTable(["ID", "Status", "Wallet", "To", "Amount", "Tx"], outbox.map((entry) => [
                entry.id,
                entry.status,
                entry.walletName ?? "",
                short(entry.to),
                entry.amount ? `${entry.amount} ${entry.asset ?? ""}` : "",
                short(entry.txHash),
            ]))
            : "No outbox entries.", "", "## Receipts", receipts.length
            ? mdTable(["ID", "Status", "Kind", "Summary"], receipts.map((receipt) => [
                receipt.id,
                receipt.status,
                receipt.kind,
                receipt.summary,
            ]))
            : "No receipts.", "", "## Orders", orders.length
            ? mdTable(["ID", "Status", "Vendor", "Item", "Amount"], orders.map((order) => [
                order.id,
                order.status,
                order.vendorDisplayName ?? order.vendorId,
                order.itemName ?? order.itemId ?? "",
                `${order.amount} ${order.asset}`,
            ]))
            : "No orders.", "", "## Connectors", connectors.length
            ? mdTable(["ID", "Vendor", "Enabled", "Auth", "Endpoint"], connectors.map((connector) => [
                connector.id,
                connector.vendorId ?? "",
                connector.enabled ? "yes" : "no",
                connector.auth.mode,
                connector.endpoint,
            ]))
            : "No connectors.", "", "## Bookings", bookings.length
            ? mdTable(["ID", "Status", "Vendor", "Service", "Amount"], bookings.map((booking) => [
                booking.id,
                booking.status,
                booking.vendorDisplayName ?? booking.vendorId,
                booking.service,
                `${booking.amount} ${booking.asset}`,
            ]))
            : "No bookings.", "", "## Invoices", invoices.length
            ? mdTable(["ID", "Type", "Status", "Amount", "Recipient"], invoices.map((invoice) => [
                invoice.id,
                invoice.type,
                invoice.status,
                `${invoice.amount} ${invoice.asset}`,
                short(invoice.recipient),
            ]))
            : "No invoices.", "", "## Merchant Policies", merchantPolicies.length
            ? mdTable(["Vendor", "Enabled", "Allow", "Deny", "Cap", "Assets"], merchantPolicies.map((policy) => [
                policy.vendorId,
                policy.enabled ? "yes" : "no",
                policy.allowlisted ? "yes" : "",
                policy.denylisted ? "yes" : "",
                policy.maxOrderAmount ?? "",
                policy.allowedAssets?.join(",") ?? "",
            ]))
            : "No merchant policies.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("vendor_search", "Search the local vendor registry used by agent runbooks. Set LYTH_MCP_VENDOR_REGISTRY to a JSON file.", {
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().min(1).max(50).optional(),
}, async ({ query, category, limit }) => {
    const commerceSafety = commerceSafetyForVendor({ query, category });
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            commerceSafety,
            vendors: [],
            refusal: "Vendor search refused by local commerce safety policy.",
        });
    }
    const registry = await loadVendors();
    return text({
        registry: vendorRegistrySummary(registry),
        commerceSafety,
        vendors: searchVendors(registry.registry, { query, category, limit }),
    });
});
server.tool("asset_registry_info", "Show local asset registry metadata, hash, status classes, and denomination classes.", {}, async () => {
    const registry = await loadAssets();
    return text(assetRegistrySummary(registry));
});
server.tool("asset_search", "Search local asset metadata and wallet-readable risk labels.", {
    query: z.string().optional(),
    kind: assetKindEnum.optional(),
    denomination: assetDenominationEnum.optional(),
    status: assetStatusEnum.optional(),
    useCase: assetUseCaseEnum.optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ query, kind, denomination, status, useCase, limit }) => {
    const registry = await loadAssets();
    const assets = listAssets(registry.registry, {
        query,
        kind: kind,
        denomination: denomination,
        status: status,
        useCase: useCase,
        limit,
    });
    return text({
        registry: assetRegistrySummary(registry),
        assets: assets.map((asset) => ({
            ...asset,
            risk: assetRisk(asset),
        })),
        warning: "Bundled asset metadata is example planning data until signed/on-chain asset registry support is available.",
    });
});
server.tool("asset_get", "Get one asset's metadata, risk labels, allowed use cases, and privacy/bridge warnings.", {
    symbol: z.string().min(1),
}, async ({ symbol }) => {
    const registry = await loadAssets();
    const asset = getAsset(registry.registry, symbol);
    const bridgeRegistry = await loadBridgeRoutes();
    const routes = asset.bridgeRouteIds?.length
        ? asset.bridgeRouteIds.map((routeId) => {
            try {
                return getBridgeRoute(bridgeRegistry.registry, routeId);
            }
            catch {
                return null;
            }
        }).filter((route) => route !== null)
        : listBridgeRoutes(bridgeRegistry.registry, { asset: asset.symbol });
    return text({
        registry: assetRegistrySummary(registry),
        asset,
        risk: assetRisk(asset),
        bridgeRoutes: routes,
    });
});
server.tool("asset_risk_label", "Render wallet-readable risk labels for an asset and optional intended use case.", {
    symbol: z.string().min(1),
    useCase: assetUseCaseEnum.optional(),
}, async ({ symbol, useCase }) => {
    const registry = await loadAssets();
    const asset = getAsset(registry.registry, symbol);
    return text({
        asset,
        risk: assetRisk(asset),
        policy: useCase ? evaluateAssetUseCase(asset, useCase) : undefined,
    });
});
server.tool("asset_route_labels", "Show asset route labels by joining local asset metadata with bridge route metadata.", {
    symbol: z.string().min(1),
}, async ({ symbol }) => {
    const assetRegistry = await loadAssets();
    const bridgeRegistry = await loadBridgeRoutes();
    const asset = getAsset(assetRegistry.registry, symbol);
    const routes = asset.bridgeRouteIds?.length
        ? asset.bridgeRouteIds.map((routeId) => {
            try {
                return getBridgeRoute(bridgeRegistry.registry, routeId);
            }
            catch {
                return null;
            }
        }).filter((route) => route !== null)
        : listBridgeRoutes(bridgeRegistry.registry, { asset: asset.symbol });
    return text({
        asset,
        risk: assetRisk(asset),
        routes,
        labels: [
            ...assetRisk(asset).labels,
            ...routes.flatMap((route) => [route.routeType, route.status, ...(route.circuitBreaker?.paused ? ["circuit_breaker_paused"] : [])]),
        ],
        warning: "Route labels are local registry metadata, not proof that a bridge transaction can execute.",
    });
});
server.tool("privacy_policy_check", "Check whether an asset/denomination can be used for a requested action. Private LYTH is blocked from productive/public actions.", {
    symbol: z.string().min(1),
    useCase: assetUseCaseEnum,
}, async ({ symbol, useCase }) => {
    const registry = await loadAssets();
    const asset = getAsset(registry.registry, symbol);
    const policy = evaluateAssetUseCase(asset, useCase);
    return policy.ok ? text(policy) : errorJson(policy);
});
server.tool("private_denomination_warning", "Explain public/private LYTH separation, one-way privacy crossing, and blocked productive use cases.", {
    symbol: z.string().optional().describe("Optional asset symbol. Defaults to pLYTH if present."),
}, async ({ symbol }) => {
    const registry = await loadAssets();
    let asset = null;
    try {
        asset = getAsset(registry.registry, symbol ?? "pLYTH");
    }
    catch {
        asset = null;
    }
    return text({
        registry: assetRegistrySummary(registry),
        asset,
        warning: privateDenominationWarning(asset ?? undefined),
    });
});
server.tool("commerce_safety_check", "Check a vendor/service/search request against local anti-illicit-commerce policy before discovery, orders, or bookings.", {
    query: z.string().optional(),
    category: z.string().optional(),
    service: z.string().optional(),
    description: z.string().optional(),
    vendorId: z.string().optional(),
}, async (args) => {
    const result = commerceSafetySummary(args);
    return result.ok ? text(result) : errorJson(result);
});
server.tool("risk_explain", "Render a plain-English risk summary for a planned MCP action using policy, bridge, asset, commerce, and preflight inputs.", {
    title: z.string().optional(),
    operation: z.string().optional(),
    amount: z.string().optional(),
    asset: z.string().optional(),
    counterparty: z.string().optional(),
    merchantRisk: recordSchema,
    assetPolicy: recordSchema,
    bridgeQuote: recordSchema,
    commerceSafety: recordSchema,
    preflight: recordSchema,
    receiptPath: z.string().optional(),
    retryPath: z.string().optional(),
}, async (args) => {
    const summary = renderRisk(args);
    return summary.ok ? text(summary) : errorJson(summary);
});
server.tool("contract_path_guidance", "Explain Monolythium's no-EVM contract path for Solidity/EVM/Rust/RISC-V requests.", {
    language: z.string().optional().describe("Example: Solidity, Rust, C, Move."),
    artifactType: z.string().optional().describe("Example: EVM bytecode, MRV package, WASM."),
}, async ({ language, artifactType }) => {
    const raw = `${language ?? ""} ${artifactType ?? ""}`.toLowerCase();
    const asksEvm = raw.includes("solidity") || raw.includes("evm") || raw.includes("revm") || raw.includes("bytecode");
    const asksRust = raw.includes("rust") || raw.includes("risc") || raw.includes("mrv");
    return text({
        supported: asksEvm ? false : asksRust ? "draft_tooling_pending" : "unknown_until_artifact_is_identified",
        requested: { language, artifactType },
        executionModel: "Rust/RISC-V native smart contracts; Solidity/EVM bytecode is not a first-class deployment path.",
        answer: asksEvm
            ? "Solidity/EVM bytecode is not supported by this MCP path. Use the Rust/RISC-V MRV contract path once contract package/deploy tools are wired."
            : asksRust
                ? "Rust/RISC-V is the intended contract path, but deploy/call builders are still TODO until core exposes the contract module surface."
                : "Identify the artifact format first. The supported direction is Rust/RISC-V MRV, not EVM bytecode.",
        todo: [
            "TODO(contract-tooling): add contract_build_mrv, contract_validate_mrv, contract_deploy_draft, contract_call_draft, contract_query, and contract_events when core exposes them.",
            "TODO(docs): link this guidance to the public no-EVM/Rust-RISC-V developer docs.",
        ],
        alternatives: [
            "Use native MRC standards/modules for tokens, NFTs, vaults, and markets where possible.",
            "Use Rust/RISC-V contracts for custom programmable logic when the contract module is available.",
        ],
    });
});
server.tool("bridge_routes", "List configured bridge/liquidity routes with status, cooldown, and trust model metadata.", {
    asset: z.string().optional(),
    sourceChain: z.string().optional(),
    destinationChain: z.string().optional(),
    status: bridgeStatusEnum.optional(),
    routeType: bridgeRouteTypeEnum.optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ asset, sourceChain, destinationChain, status, routeType, limit }) => {
    const registry = await loadBridgeRoutes();
    return text({
        registry: bridgeRegistrySummary(registry),
        routes: listBridgeRoutes(registry.registry, {
            asset,
            sourceChain,
            destinationChain,
            status: status,
            routeType: routeType,
            limit,
        }),
        warning: "Route metadata is planning/preflight data. Only routes with status=active should be treated as executable.",
    });
});
server.tool("bridge_route_get", "Get one bridge route with trust assumptions, cooldown, drain cap, and circuit-breaker metadata.", {
    routeId: z.string().min(1),
}, async ({ routeId }) => {
    const registry = await loadBridgeRoutes();
    const route = getBridgeRoute(registry.registry, routeId);
    return text({
        registry: bridgeRegistrySummary(registry),
        route,
        cooldown: bridgeCooldownMatrix({ ...registry.registry, routes: [route] })[0],
        status: bridgeStatusSummary({ ...registry.registry, routes: [route] })[0],
    });
});
server.tool("bridge_quote", "Preflight a bridge amount against route status, cooldown, fees, drain caps, and circuit breakers. Does not build or submit a bridge transaction.", {
    amount: z.string(),
    asset: z.string(),
    routeId: z.string().optional(),
    sourceChain: z.string().optional(),
    destinationChain: z.string().optional(),
}, async ({ amount, asset, routeId, sourceChain, destinationChain }) => {
    const registry = await loadBridgeRoutes();
    const assetPolicy = await evaluateAssetPolicy(asset, "bridge");
    if (!assetPolicy.policy.ok) {
        const riskSummary = renderRisk({
            title: "Bridge Quote Risk",
            operation: "bridge_quote",
            amount,
            asset,
            assetPolicy: assetPolicy.policy,
        });
        return errorJson({
            ok: false,
            assetPolicy: assetPolicy.policy,
            assetRegistry: assetRegistrySummary(assetPolicy.registry),
            riskSummary,
            refusal: "Bridge quote refused by local asset/privacy policy.",
        });
    }
    const route = routeId
        ? getBridgeRoute(registry.registry, routeId)
        : selectBridgeRoute(registry.registry, { asset, sourceChain, destinationChain });
    if (!route) {
        const bridgeQuote = {
            ok: false,
            violations: [`No bridge route found for ${asset}${sourceChain ? ` from ${sourceChain}` : ""}${destinationChain ? ` to ${destinationChain}` : ""}.`],
        };
        return errorJson({
            ok: false,
            violations: bridgeQuote.violations,
            registry: bridgeRegistrySummary(registry),
            riskSummary: renderRisk({
                title: "Bridge Quote Risk",
                operation: "bridge_quote",
                amount,
                asset,
                bridgeQuote,
            }),
        });
    }
    const quote = quoteBridgeRoute(route, {
        amount,
        asset,
        epochHours: registry.registry.epochHours,
    });
    const riskSummary = renderRisk({
        title: "Bridge Quote Risk",
        operation: "bridge_quote",
        amount,
        asset,
        counterparty: `${route.sourceChain}->${route.destinationChain}`,
        assetPolicy: assetPolicy.policy,
        bridgeQuote: quote,
    });
    return quote.executable
        ? text({ registry: bridgeRegistrySummary(registry), assetPolicy: assetPolicy.policy, quote, riskSummary })
        : errorJson({ registry: bridgeRegistrySummary(registry), assetPolicy: assetPolicy.policy, quote, riskSummary });
});
server.tool("bridge_cooldown_matrix", "Show the configured cooldown matrix for Chainlink CCIP bridge routes.", {
    asset: z.string().optional(),
}, async ({ asset }) => {
    const registry = await loadBridgeRoutes();
    const routes = asset
        ? { ...registry.registry, routes: listBridgeRoutes(registry.registry, { asset }) }
        : registry.registry;
    return text({
        registry: bridgeRegistrySummary(registry),
        matrix: bridgeCooldownMatrix(routes),
    });
});
server.tool("bridge_status_summary", "Summarize configured bridge route health, circuit breakers, drain caps, and risk attention flags.", {}, async () => {
    const registry = await loadBridgeRoutes();
    return text({
        registry: bridgeRegistrySummary(registry),
        routes: bridgeStatusSummary(registry.registry),
    });
});
server.tool("bridge_circuit_breaker_watch", "Watch configured bridge routes for paused routes, non-active status, non-CCIP/LINK metadata, missing audit metadata, and low drain caps.", {
    asset: z.string().optional(),
    drainCapWarnPercent: z.number().min(1).max(100).optional().describe("Warn when drain-cap remaining is at or below this percentage. Default 20."),
}, async ({ asset, drainCapWarnPercent }) => {
    const registry = await loadBridgeRoutes();
    const alerts = bridgeCircuitBreakerAlerts(registry.registry, { asset, drainCapWarnPercent });
    return alerts.some((item) => item.severity === "critical")
        ? errorJson({
            ok: false,
            registry: bridgeRegistrySummary(registry),
            alerts,
            warning: "Critical bridge alerts should freeze new route usage until an operator reviews the route.",
        })
        : text({
            ok: true,
            registry: bridgeRegistrySummary(registry),
            alerts,
        });
});
server.tool("liquidity_onboarding", "Explain how to bring an asset into Mono using configured bridge/liquidity routes.", {
    asset: z.string(),
    sourceChain: z.string().optional(),
    amount: z.string().optional(),
}, async ({ asset, sourceChain, amount }) => {
    const registry = await loadBridgeRoutes();
    const routes = listBridgeRoutes(registry.registry, {
        asset,
        sourceChain,
        destinationChain: "Monolythium",
    });
    const recommended = selectBridgeRoute(registry.registry, {
        asset,
        sourceChain,
        destinationChain: "Monolythium",
    });
    const quote = recommended && amount
        ? quoteBridgeRoute(recommended, { amount, asset, epochHours: registry.registry.epochHours })
        : undefined;
    return text({
        asset: asset.toUpperCase(),
        sourceChain,
        registry: bridgeRegistrySummary(registry),
        recommendedRoute: recommended,
        quote,
        routes,
        guidance: [
            "Use only active Chainlink CCIP routes with LINK fee-token metadata.",
            "Draft routes explain intended cooldowns and risk, but should not be treated as executable.",
            "Missing CCIP or LINK metadata should keep the route non-executable.",
        ],
    });
});
server.tool("cluster_registry_info", "Show local cluster/operator registry metadata, hashes, regions, statuses, and services.", {}, async () => {
    const registry = await loadClusters();
    return text(clusterRegistrySummary(registry));
});
server.tool("cluster_search", "Search local cluster metadata by region, service, status, foundation control, GPU availability, and open seats.", {
    query: z.string().optional(),
    region: z.string().optional(),
    jurisdiction: z.string().optional(),
    status: clusterStatusEnum.optional(),
    serviceType: clusterServiceTypeEnum.optional(),
    foundationControlled: z.boolean().optional(),
    gpuRequired: z.boolean().optional(),
    minOpenSeats: z.number().int().min(0).optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ query, region, jurisdiction, status, serviceType, foundationControlled, gpuRequired, minOpenSeats, limit }) => {
    const registry = await loadClusters();
    const clusters = listClusters(registry.registry, {
        query,
        region,
        jurisdiction,
        status: status,
        serviceType: serviceType,
        foundationControlled,
        gpuRequired,
        minOpenSeats,
        limit,
    });
    return text({
        registry: clusterRegistrySummary(registry),
        clusters: clusters.map((cluster) => ({
            ...cluster,
            reputationSummary: clusterReputation(cluster),
            foundation: clusterFoundationFlag(cluster),
            sunset: clusterSunsetStatus(cluster),
        })),
        warning: "Local planning metadata only. TODO(mainnet): replace with signed cluster registry and live indexer data.",
    });
});
server.tool("cluster_get", "Get one cluster with reputation, foundation-control flag, sunset status, service tiers, and operator roster.", {
    clusterId: z.string().min(1),
}, async ({ clusterId }) => {
    const registry = await loadClusters();
    const cluster = getCluster(registry.registry, clusterId);
    return text({
        registry: clusterRegistrySummary(registry),
        cluster,
        reputation: clusterReputation(cluster),
        foundation: clusterFoundationFlag(cluster),
        sunset: clusterSunsetStatus(cluster),
        operators: listOperators(registry.registry, { clusterId, limit: 50 }),
    });
});
server.tool("cluster_reputation", "Explain one cluster's reputation, uptime, slashing history, service tiers, and decentralization risk.", {
    clusterId: z.string().min(1),
}, async ({ clusterId }) => {
    const registry = await loadClusters();
    return text(clusterReputation(getCluster(registry.registry, clusterId)));
});
server.tool("cluster_foundation_flag", "Explain whether a cluster is foundation-controlled and what that means for delegation/decentralization.", {
    clusterId: z.string().min(1),
}, async ({ clusterId }) => {
    const registry = await loadClusters();
    return text(clusterFoundationFlag(getCluster(registry.registry, clusterId)));
});
server.tool("cluster_sunset_status", "Explain whether a cluster is active, sunsetting, retired, or unsafe for new delegation/routing.", {
    clusterId: z.string().min(1),
}, async ({ clusterId }) => {
    const registry = await loadClusters();
    return text(clusterSunsetStatus(getCluster(registry.registry, clusterId)));
});
server.tool("operator_search", "Search local operator metadata by region, cluster, foundation control, and open-seat interest.", {
    query: z.string().optional(),
    region: z.string().optional(),
    clusterId: z.string().optional(),
    foundationControlled: z.boolean().optional(),
    openSeatInterest: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ query, region, clusterId, foundationControlled, openSeatInterest, limit }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        operators: listOperators(registry.registry, { query, region, clusterId, foundationControlled, openSeatInterest, limit })
            .map((operator) => operatorStatus(registry.registry, operator)),
        warning: "Local planning metadata only. TODO(mainnet): replace with signed operator registry and TPM attestation data.",
    });
});
server.tool("operator_get", "Get one operator's local cluster membership, reputation, open seats, and attestation status.", {
    operatorId: z.string().min(1),
}, async ({ operatorId }) => {
    const registry = await loadClusters();
    const operator = getOperator(registry.registry, operatorId);
    return text({
        registry: clusterRegistrySummary(registry),
        ...operatorStatus(registry.registry, operator),
    });
});
server.tool("operator_open_seats", "List clusters/operators with open operator seats for onboarding or decentralization planning.", {
    operatorId: z.string().optional(),
    region: z.string().optional(),
    serviceType: clusterServiceTypeEnum.optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ operatorId, region, serviceType, limit }) => {
    const registry = await loadClusters();
    const operator = operatorId ? getOperator(registry.registry, operatorId) : null;
    const clusters = listClusters(registry.registry, {
        region,
        serviceType: serviceType,
        minOpenSeats: 1,
        limit,
    }).filter((cluster) => !operator || operator.clusterIds?.includes(cluster.id) || operator.openSeatInterest);
    return text({
        registry: clusterRegistrySummary(registry),
        operator: operator ? operatorStatus(registry.registry, operator) : undefined,
        clusters: clusters.map((cluster) => ({
            cluster,
            openSeats: cluster.operatorSeats?.open ?? 0,
            reputation: clusterReputation(cluster),
        })),
        warning: "Open seats are local metadata. TODO(mainnet): use live operator registry and application flow.",
    });
});
server.tool("monarch_operator_assistant", "Explain cluster health, 7-of-10 quorum, update status, open seats, resource pressure, and service ROI for node operators.", {
    clusterId: z.string().optional(),
    operatorId: z.string().optional(),
    region: z.string().optional(),
    serviceType: clusterServiceTypeEnum.optional(),
    includeDraft: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ clusterId, operatorId, region, serviceType, includeDraft, limit }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        assistant: monarchOperatorAssistant(registry.registry, {
            clusterId,
            operatorId,
            region,
            serviceType: serviceType,
            includeDraft,
            limit,
        }),
        warning: "Node-ops guidance only. This tool must not be used as a consumer wallet/payment flow.",
    });
});
server.tool("delegation_cap_explain", "Explain current delegation phase, per-cluster cap, minimum diversification, over-cap grace, and tapered rewards.", {
    phase: delegationPhaseEnum.optional(),
    clusterId: z.string().optional(),
    totalDelegatedStake: z.string().optional(),
    currentClusterStake: z.string().optional(),
    intendedAdditionalStake: z.string().optional(),
    selectedClusterCount: z.number().int().min(0).optional(),
    overCapEpochs: z.number().int().min(0).optional(),
}, async (args) => text({
    phaseConfig: delegationPhaseConfig(args.phase ?? "growth"),
    explanation: explainDelegationCaps({
        ...args,
        phase: args.phase,
    }),
}));
server.tool("stake_status", "Summarize local staking positions against delegation phase caps and cluster risk metadata. Planning only.", {
    phase: delegationPhaseEnum.optional(),
    positions: delegationPositionsSchema,
}, async ({ phase, positions }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        status: stakeStatus(registry.registry, {
            phase: phase,
            positions: positions,
        }),
    });
});
server.tool("delegate_draft", "Draft a local delegation plan for one cluster. Does not build or submit a staking transaction.", {
    clusterId: z.string().min(1),
    amount: z.string().min(1),
    mode: delegationModeEnum.optional(),
    phase: delegationPhaseEnum.optional(),
    positions: delegationPositionsSchema,
}, async ({ clusterId, amount, mode, phase, positions }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        draft: delegateDraft(registry.registry, {
            clusterId,
            amount,
            mode: mode,
            phase: phase,
            positions: positions,
        }),
    });
});
server.tool("rebalance_draft", "Draft a local rebalance plan across clusters for yield, diversity, or decentralization mode. Planning only.", {
    mode: delegationModeEnum.optional(),
    phase: delegationPhaseEnum.optional(),
    positions: delegationPositionsSchema,
    targetClusterCount: z.number().int().min(1).max(50).optional(),
}, async ({ mode, phase, positions, targetClusterCount }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        draft: rebalanceDraft(registry.registry, {
            mode: mode,
            phase: phase,
            positions: positions,
            targetClusterCount,
        }),
    });
});
server.tool("undelegate_draft", "Draft a local undelegation plan for one cluster. Does not build or submit a staking transaction.", {
    clusterId: z.string().min(1),
    amount: z.string().min(1),
    positions: delegationPositionsSchema,
    reason: z.string().optional(),
}, async ({ clusterId, amount, positions, reason }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        draft: undelegateDraft(registry.registry, {
            clusterId,
            amount,
            positions: positions,
            reason,
        }),
    });
});
server.tool("autovote_simulate", "Simulate cluster ranking for staking autovote modes without voting, delegating, or signing.", {
    mode: delegationModeEnum.optional(),
    phase: delegationPhaseEnum.optional(),
    positions: delegationPositionsSchema,
    candidateLimit: z.number().int().min(1).max(50).optional(),
}, async ({ mode, phase, positions, candidateLimit }) => {
    const registry = await loadClusters();
    return text({
        registry: clusterRegistrySummary(registry),
        simulation: autovoteSimulate(registry.registry, {
            mode: mode,
            phase: phase,
            positions: positions,
            candidateLimit,
        }),
    });
});
server.tool("node_registry_info", "Show local node registry metadata, hashes, roles, statuses, hosting classes, and attestation states.", {}, async () => {
    const registry = await loadNodes();
    return text(nodeRegistrySummary(registry));
});
server.tool("node_search", "Search local node metadata by cluster, operator, role, status, region, hosting class, attestation status, GPU, and TPM.", {
    query: z.string().optional(),
    clusterId: z.string().optional(),
    operatorId: z.string().optional(),
    role: nodeRoleEnum.optional(),
    status: nodeStatusEnum.optional(),
    region: z.string().optional(),
    hostingClass: nodeHostingClassEnum.optional(),
    attestationStatus: attestationStatusEnum.optional(),
    gpuRequired: z.boolean().optional(),
    tpmRequired: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ query, clusterId, operatorId, role, status, region, hostingClass, attestationStatus, gpuRequired, tpmRequired, limit }) => {
    const registry = await loadNodes();
    const nodes = listNodes(registry.registry, {
        query,
        clusterId,
        operatorId,
        role: role,
        status: status,
        region,
        hostingClass: hostingClass,
        attestationStatus: attestationStatus,
        gpuRequired,
        tpmRequired,
        limit,
    });
    return text({
        registry: nodeRegistrySummary(registry),
        nodes: nodes.map((node) => ({
            node,
            attestation: nodeAttestation(node),
            hosting: nodeHostingClass(node),
        })),
        warning: "Local planning metadata only. TODO(mainnet): replace with signed node registry and live TPM quote verification.",
    });
});
server.tool("node_attestation_get", "Get local TPM/attestation metadata for one node and compare PCRs against the expected profile.", {
    nodeId: z.string().min(1),
}, async ({ nodeId }) => {
    const registry = await loadNodes();
    const node = getNode(registry.registry, nodeId);
    return nodeAttestation(node).ok
        ? text({ registry: nodeRegistrySummary(registry), node, attestation: nodeAttestation(node) })
        : errorJson({ registry: nodeRegistrySummary(registry), node, attestation: nodeAttestation(node) });
});
server.tool("node_pcr_explain", "Explain TPM PCR values for a node, including expected/actual PCR profile and local measured-boot meaning.", {
    nodeId: z.string().min(1),
    pcr: z.string().optional().describe("Optional PCR index, e.g. 0, 2, 4, 7, 11."),
}, async ({ nodeId, pcr }) => {
    const registry = await loadNodes();
    const node = getNode(registry.registry, nodeId);
    return text({
        registry: nodeRegistrySummary(registry),
        node,
        pcr: explainPcr(node, pcr),
        attestation: nodeAttestation(node),
    });
});
server.tool("node_diversity_score", "Score local node diversity by ASN, provider, country, hosting class, operator, and cluster.", {
    clusterId: z.string().optional(),
    operatorId: z.string().optional(),
    region: z.string().optional(),
    role: nodeRoleEnum.optional(),
}, async ({ clusterId, operatorId, region, role }) => {
    const registry = await loadNodes();
    return text({
        registry: nodeRegistrySummary(registry),
        diversity: nodeDiversityScore(registry.registry, { clusterId, operatorId, region, role: role }),
    });
});
server.tool("node_hosting_class", "Explain one node's hosting class and correlated-failure risk.", {
    nodeId: z.string().min(1),
}, async ({ nodeId }) => {
    const registry = await loadNodes();
    const node = getNode(registry.registry, nodeId);
    return text({
        registry: nodeRegistrySummary(registry),
        node,
        hosting: nodeHostingClass(node),
        attestation: nodeAttestation(node),
    });
});
async function serviceSearchResponse(serviceType, args) {
    const registry = await loadClusters();
    return {
        registry: clusterRegistrySummary(registry),
        serviceType,
        services: searchServices(registry.registry, {
            serviceType,
            region: args.region,
            gpuClass: args.gpuClass,
            maxLatencyMs: args.maxLatencyMs,
            activeOnly: args.activeOnly ?? true,
            limit: args.limit,
        }),
        warning: "Service pricing/capacity is local planning metadata until live service-tier markets are exposed.",
    };
}
server.tool("rpc_service_search", "Search local RPC service tiers by region and active status.", {
    region: z.string().optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async (args) => text(await serviceSearchResponse("rpc", args)));
server.tool("archive_service_search", "Search local archive-node service tiers by region and active status.", {
    region: z.string().optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async (args) => text(await serviceSearchResponse("archive", args)));
server.tool("prover_service_search", "Search local GPU prover service tiers by region, GPU class, latency, and active status.", {
    region: z.string().optional(),
    gpuClass: z.string().optional(),
    maxLatencyMs: z.number().min(1).optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async (args) => text(await serviceSearchResponse("prover", args)));
server.tool("gpu_proof_market_assistant", "Route zkML, bridge, or generic proof requests to available local GPU prover service tiers with fee/latency assumptions.", {
    proofType: z.enum(["bridge", "zkml", "generic"]).optional(),
    region: z.string().optional(),
    gpuClass: z.string().optional(),
    maxLatencyMs: z.number().min(1).optional(),
    maxFeePerProof: z.string().optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ proofType, region, gpuClass, maxLatencyMs, maxFeePerProof, activeOnly, limit }) => {
    if (maxFeePerProof) {
        decimalToUnits(maxFeePerProof);
    }
    const registry = await loadClusters();
    const services = searchServices(registry.registry, {
        serviceType: "prover",
        region,
        gpuClass,
        maxLatencyMs,
        activeOnly: activeOnly ?? true,
        limit: limit ?? 10,
    }).filter((entry) => {
        const fee = entry.service.pricePerProof;
        return !maxFeePerProof || !fee || decimalToUnits(fee) <= decimalToUnits(maxFeePerProof);
    });
    const proofMultiplier = proofType === "zkml" ? 3 : proofType === "bridge" ? 1.5 : 1;
    return text({
        registry: clusterRegistrySummary(registry),
        proofType: proofType ?? "generic",
        filters: { region, gpuClass, maxLatencyMs, maxFeePerProof, activeOnly: activeOnly ?? true },
        recommendations: services.map((entry) => ({
            clusterId: entry.clusterId,
            clusterDisplayName: entry.clusterDisplayName,
            region: entry.region,
            foundationControlled: entry.foundationControlled,
            service: entry.service,
            estimatedProofTimeMsP50: entry.service.proofLatencyMsP50
                ? Math.round(entry.service.proofLatencyMsP50 * proofMultiplier)
                : undefined,
            estimatedFee: entry.service.pricePerProof
                ? {
                    amount: entry.service.pricePerProof,
                    asset: entry.service.asset ?? "LYTH",
                    note: proofType === "zkml" ? "zkML pricing likely needs model-size multipliers; this is a placeholder estimate." : undefined,
                }
                : undefined,
            reputation: entry.reputation,
        })),
        verifierStatus: {
            bridge: proofType === "bridge" ? "Use only after the bridge verifier/precompile and route circuit are audited." : undefined,
            zkml: proofType === "zkml" ? "TODO(mainnet): connect to zkML verifier registry and model attestation metadata." : undefined,
            generic: proofType === "generic" || !proofType ? "Generic proof requests need a verifier id before production routing." : undefined,
        },
        warnings: [
            "This is local planning metadata. It does not reserve prover capacity or submit a proof job.",
            "TODO(mainnet): replace with live service-tier market, proof job queue, verifier registry, and signed SLA data.",
        ],
    });
});
server.tool("oracle_service_search", "Search local oracle service tiers by region and active status.", {
    region: z.string().optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async (args) => text(await serviceSearchResponse("oracle", args)));
server.tool("vendor_registry_info", "Show vendor registry metadata, hashes, signature status, and category summary.", {}, async () => {
    const registry = await loadVendors();
    return text(vendorRegistrySummary(registry));
});
server.tool("vendor_get", "Get one vendor by id from the configured registry.", {
    vendorId: z.string().min(1),
}, async ({ vendorId }) => {
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, vendorId);
    const merchantRisk = await evaluateVendorRisk(vendor);
    const commerceSafety = commerceSafetyForVendor({ vendor });
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            registry: vendorRegistrySummary(registry),
            vendor,
            merchantRisk,
            commerceSafety,
            refusal: "Vendor is hidden/refused by local commerce safety policy.",
        });
    }
    return text({
        registry: vendorRegistrySummary(registry),
        vendor,
        merchantRisk,
        commerceSafety,
        warning: vendor.fulfillment?.type?.includes("demo")
            ? "This vendor uses demo fulfillment. No real goods or services are delivered."
            : undefined,
    });
});
server.tool("provider_onboarding_draft", "Draft local vendor registry, merchant policy, availability, and connector metadata for a provider. Does not publish anything on-chain.", {
    vendorId: z.string().min(1),
    displayName: z.string().min(1),
    category: z.string().min(1),
    description: z.string().optional(),
    address: z.string().optional(),
    acceptedAssets: z.array(z.string().min(1)).optional(),
    serviceTags: z.array(z.string().min(1)).optional(),
    requiredFields: z.array(z.string().min(1)).optional(),
    maxOrderAmount: z.string().optional(),
    webhookEndpoint: z.string().url().optional(),
    authMode: z.enum(["none", "bearer", "header", "hmac_sha256"]).optional(),
    jurisdictionNotes: z.string().optional(),
    refundPolicy: z.string().optional(),
    fulfillmentSla: z.string().optional(),
    credentialsRequired: z.array(z.string().min(1)).optional(),
}, async (args) => {
    if (args.address && !isAddress(args.address)) {
        return errorText("address must be a 0x or mono1 address when supplied");
    }
    if (args.maxOrderAmount) {
        decimalToUnits(args.maxOrderAmount);
    }
    const commerceSafety = commerceSafetyForVendor({
        vendorId: args.vendorId,
        category: args.category,
        service: args.displayName,
        description: [args.description, args.serviceTags?.join(" "), args.jurisdictionNotes].filter(Boolean).join("\n"),
    });
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            commerceSafety,
            refusal: "Provider onboarding draft refused by local commerce safety policy.",
        });
    }
    const acceptedAssets = (args.acceptedAssets?.length ? args.acceptedAssets : ["LYTH"])
        .map((asset) => asset.toUpperCase());
    const vendorDraft = {
        id: args.vendorId,
        displayName: args.displayName,
        category: args.category,
        description: args.description,
        address: args.address,
        acceptedAssets,
        maxOrderAmount: args.maxOrderAmount,
        serviceTags: args.serviceTags,
        fulfillment: {
            type: args.webhookEndpoint ? "webhook_pending" : "manual_pending",
            requiredFields: args.requiredFields ?? [],
            endpointConfigured: Boolean(args.webhookEndpoint),
        },
        credentialsRequired: args.credentialsRequired,
        todo: [
            "TODO(onboarding): verify provider identity, credentials, refund policy, jurisdiction, and availability before production listing.",
            "TODO(mainnet): publish signed/on-chain discovery metadata when the provider registry module exists.",
        ],
    };
    const merchantPolicyDraft = {
        vendorId: args.vendorId,
        enabled: true,
        allowlisted: false,
        maxOrderAmount: args.maxOrderAmount,
        allowedAssets: acceptedAssets,
        allowedCategories: [args.category],
        jurisdictionNotes: args.jurisdictionNotes,
        refundPolicy: args.refundPolicy,
        fulfillmentSla: args.fulfillmentSla,
        riskNotes: "Drafted by MCP provider_onboarding_draft; review before allowlisting.",
    };
    const availabilityDraft = {
        vendorId: args.vendorId,
        status: "manual_setup_required",
        serviceTags: args.serviceTags ?? [],
        requiredFields: args.requiredFields ?? [],
        todo: "TODO(core): replace with availability_update_draft once the provider availability module exists.",
    };
    const connectorDraft = args.webhookEndpoint
        ? {
            id: `${args.vendorId}-webhook`,
            vendorId: args.vendorId,
            displayName: `${args.displayName} webhook`,
            endpoint: args.webhookEndpoint,
            method: "POST",
            enabled: false,
            authMode: args.authMode ?? "hmac_sha256",
            confirm: "STORE_CONNECTOR",
        }
        : undefined;
    const riskSummary = renderRisk({
        title: "Provider Onboarding Risk",
        operation: "provider_onboarding_draft",
        counterparty: args.displayName,
        commerceSafety,
    });
    return text({
        ok: true,
        commerceSafety,
        riskSummary,
        vendorDraft,
        merchantPolicyDraft,
        availabilityDraft,
        connectorDraft,
        nextSteps: [
            "Review the commerceSafety warnings before exposing the listing to users.",
            "Apply merchant_policy_set before allowing agent spending.",
            "Use connector_set only after real provider credentials are available.",
        ],
    });
});
server.tool("connector_set", "Create or update a local encrypted webhook connector for a vendor.", {
    id: z.string().min(1).optional().describe("Connector id. Defaults to vendorId, or a generated id from endpoint."),
    vendorId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    endpoint: z.string().url(),
    method: z.enum(["POST", "PUT"]).optional(),
    enabled: z.boolean().optional(),
    authMode: z.enum(["none", "bearer", "header", "hmac_sha256"]).optional(),
    headerName: z.string().optional().describe("Header for header or hmac_sha256 auth."),
    scheme: z.string().optional().describe("Authorization scheme for bearer auth. Default Bearer."),
    secret: z.string().optional().describe("API key/webhook secret. Stored encrypted locally and never returned."),
    confirm: z.literal("STORE_CONNECTOR"),
}, async ({ confirm: _confirm, ...args }) => {
    if (args.vendorId) {
        const registry = await loadVendors();
        getVendor(registry.registry, args.vendorId);
    }
    const connector = await upsertConnector(args);
    return text({
        connector: redactConnector(connector),
        store: await connectorStoreInfo(),
        warning: "Connector secrets are encrypted with a local machine key. Only store credentials for vendors you trust on this machine.",
    });
});
server.tool("connector_get", "Get a local connector without revealing its secret.", {
    id: z.string().min(1),
}, async ({ id }) => text({ connector: redactConnector(await getConnector(id)) }));
server.tool("connector_list", "List local webhook connectors without revealing secrets.", {
    vendorId: z.string().optional(),
    enabledOnly: z.boolean().optional(),
    limit: z.number().min(1).max(200).optional(),
}, async ({ vendorId, enabledOnly, limit }) => text({
    store: await connectorStoreInfo(),
    connectors: await listConnectors({ vendorId, enabledOnly, limit }),
}));
server.tool("connector_remove", "Remove a local webhook connector and its encrypted secret.", {
    id: z.string().min(1),
    confirm: z.literal("REMOVE_CONNECTOR"),
}, async ({ id }) => text(await removeConnector(id)));
server.tool("connector_test_webhook", "Preview or send a test JSON payload through a local webhook connector.", {
    connectorId: z.string().min(1),
    send: z.boolean().optional().describe("Default false. When false, returns a redacted request preview only."),
    confirm: z.literal("SEND_TEST_WEBHOOK").optional(),
}, async ({ connectorId, send, confirm }) => {
    const connector = await getConnector(connectorId);
    const payload = {
        schemaVersion: 1,
        type: "connector_test",
        network: NETWORK,
        chainId: CHAIN_ID,
        connectorId,
        createdAt: new Date().toISOString(),
    };
    if (!send) {
        const body = safeStringify(payload);
        return text({
            connector: redactConnector(connector),
            request: {
                method: connector.method,
                endpoint: connector.endpoint,
                payload,
                payloadHash: connectorPayloadHash(body),
            },
            warning: "Preview only. Set send=true and confirm=SEND_TEST_WEBHOOK to call the external endpoint.",
        });
    }
    if (confirm !== "SEND_TEST_WEBHOOK") {
        return errorText("confirm must be SEND_TEST_WEBHOOK when send=true");
    }
    const response = await sendConnectorJson(connector, payload);
    const receipt = await addReceipt({
        kind: "connector_test_webhook",
        status: response.ok ? "confirmed" : "failed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Tested connector ${connector.id}`,
        summary: `${connector.method} ${connector.endpoint} -> HTTP ${response.status}`,
        result: {
            connector: redactConnector(connector),
            response,
        },
    });
    return response.ok
        ? text({ connector: redactConnector(connector), response, receipt })
        : errorJson({ connector: redactConnector(connector), response, receipt });
});
server.tool("merchant_policy_set", "Create or update local merchant risk controls for a vendor.", {
    vendorId: z.string().min(1),
    enabled: z.boolean().optional().describe("Whether the policy enforces allow/deny/cap checks. Default true."),
    allowlisted: z.boolean().optional(),
    denylisted: z.boolean().optional(),
    maxOrderAmount: z.string().optional().describe("Maximum local order amount for this vendor."),
    allowedAssets: z.array(z.string().min(1)).optional(),
    allowedCategories: z.array(z.string().min(1)).optional(),
    jurisdictionNotes: z.string().optional(),
    refundPolicy: z.string().optional(),
    fulfillmentSla: z.string().optional(),
    disputeProcess: z.string().optional(),
    riskNotes: z.string().optional(),
}, async (args) => {
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, args.vendorId);
    const policy = await upsertMerchantPolicy(args);
    const merchantRisk = evaluateMerchantPolicy({ vendor, policy });
    return text({
        policy,
        merchantRisk,
        registry: vendorRegistrySummary(registry),
        warning: "This is a local MCP policy. It controls MCP order creation, not the on-chain vendor registry.",
    });
});
server.tool("merchant_policy_get", "Get local merchant policy and risk status for a vendor.", {
    vendorId: z.string().min(1),
}, async ({ vendorId }) => {
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, vendorId);
    const policy = await getMerchantPolicy(vendorId);
    return text({
        policy,
        merchantRisk: evaluateMerchantPolicy({ vendor, policy }),
    });
});
server.tool("merchant_policy_list", "List local merchant policies.", {
    vendorId: z.string().optional(),
    onlyBlocked: z.boolean().optional(),
    limit: z.number().min(1).max(200).optional(),
}, async ({ vendorId, onlyBlocked, limit }) => text({
    store: await merchantPolicyStoreInfo(),
    policies: await listMerchantPolicies({ vendorId, onlyBlocked, limit }),
}));
server.tool("merchant_policy_remove", "Remove a local merchant policy for a vendor.", {
    vendorId: z.string().min(1),
    confirm: z.literal("REMOVE_MERCHANT_POLICY"),
}, async ({ vendorId }) => text(await removeMerchantPolicy(vendorId)));
server.tool("merchant_risk_check", "Evaluate vendor, amount, and asset against local merchant risk policy without creating an order.", {
    vendorId: z.string().min(1),
    itemId: z.string().optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    amount: z.string().optional().describe("Optional direct amount when not quoting a catalog item."),
    asset: z.string().optional(),
    fulfillmentFields: recordSchema,
}, async ({ vendorId, itemId, quantity, amount, asset, fulfillmentFields }) => {
    if (amount) {
        decimalToUnits(amount);
    }
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, vendorId);
    const policy = await getMerchantPolicy(vendor.id);
    const quote = itemId || quantity || !amount
        ? quoteVendorOrder({
            registryHash: registry.payloadHash,
            vendor,
            itemId,
            quantity,
            asset,
            fulfillmentFields,
        })
        : undefined;
    const merchantRisk = evaluateMerchantPolicy({
        vendor,
        quote,
        policy,
        amount: amount ?? quote?.amount,
        asset: asset ?? quote?.asset,
    });
    const commerceSafety = commerceSafetyForVendor({ vendor, quote, description: fulfillmentFields });
    const riskSummary = renderRisk({
        title: "Merchant Risk",
        operation: "merchant_risk_check",
        amount: amount ?? quote?.amount,
        asset: asset ?? quote?.asset,
        counterparty: vendor.displayName ?? vendor.id,
        merchantRisk,
        commerceSafety,
    });
    return merchantRisk.ok && commerceSafety.ok
        ? text({ registry: vendorRegistrySummary(registry), quote, merchantRisk, commerceSafety, riskSummary })
        : errorJson({ registry: vendorRegistrySummary(registry), quote, merchantRisk, commerceSafety, riskSummary });
});
server.tool("order_quote", "Quote a demo vendor catalog item. This does not create an order or spend funds.", {
    vendorId: z.string().min(1),
    itemId: z.string().optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    asset: z.string().optional(),
    fulfillmentFields: recordSchema.describe("Fulfillment fields such as deliveryAddress, email, phone, routeId."),
}, async ({ vendorId, itemId, quantity, asset, fulfillmentFields }) => {
    const { registry, vendor, quote } = await quoteOrder({ vendorId, itemId, quantity, asset, fulfillmentFields });
    const merchantRisk = await evaluateVendorRisk(vendor, quote);
    const assetPolicy = await evaluateAssetPolicy(quote.asset, "commerce");
    const commerceSafety = commerceSafetyForVendor({ vendor, quote, description: fulfillmentFields });
    const riskSummary = renderRisk({
        title: "Order Quote Risk",
        operation: "order_quote",
        amount: quote.amount,
        asset: quote.asset,
        counterparty: quote.vendorDisplayName ?? quote.vendorId,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
    });
    const payload = {
        registry: vendorRegistrySummary(registry),
        quote,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        riskSummary,
        warning: "Quote only. No payment has been prepared and no vendor has been contacted.",
    };
    return assetPolicy.policy.ok && merchantRisk.ok && commerceSafety.ok ? text(payload) : errorJson(payload);
});
server.tool("order_create", "Create a local demo order from the vendor registry. This does not contact a real vendor or spend funds.", {
    vendorId: z.string().min(1),
    itemId: z.string().optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    asset: z.string().optional(),
    fulfillmentFields: recordSchema,
    notes: z.string().optional(),
}, async ({ vendorId, itemId, quantity, asset, fulfillmentFields, notes }) => {
    const { registry, vendor, quote } = await quoteOrder({ vendorId, itemId, quantity, asset, fulfillmentFields });
    const merchantRisk = await evaluateVendorRisk(vendor, quote);
    const assetPolicy = await evaluateAssetPolicy(quote.asset, "commerce");
    const commerceSafety = commerceSafetyForVendor({
        vendor,
        quote,
        description: { fulfillmentFields, notes },
    });
    const riskSummary = renderRisk({
        title: "Order Creation Risk",
        operation: "order_create",
        amount: quote.amount,
        asset: quote.asset,
        counterparty: quote.vendorDisplayName ?? quote.vendorId,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        receiptPath: "order_receipt",
        retryPath: "tx_outbox_retry",
    });
    if (!assetPolicy.policy.ok) {
        return errorJson({
            ok: false,
            quote,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            refusal: "Order creation refused by local asset/privacy policy.",
        });
    }
    if (!merchantRisk.ok) {
        return errorJson({
            ok: false,
            quote,
            merchantRisk,
            commerceSafety,
            riskSummary,
            refusal: "Order creation refused by local merchant policy.",
        });
    }
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            quote,
            merchantRisk,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            refusal: "Order creation refused by local commerce safety policy.",
        });
    }
    const order = await createOrder({
        network: NETWORK,
        chainId: CHAIN_ID,
        vendorId: quote.vendorId,
        vendorDisplayName: quote.vendorDisplayName,
        vendorAddress: quote.vendorAddress,
        itemId: quote.itemId,
        itemName: quote.itemName,
        quantity: quote.quantity,
        amount: quote.amount,
        asset: quote.asset,
        registryHash: quote.registryHash,
        fulfillmentFields,
        quote: { ...quote, merchantRisk, assetPolicy: assetPolicy.policy, commerceSafety, riskSummary, notes },
    });
    const receipt = await addReceipt({
        kind: "order_create",
        status: "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Created order ${order.id}`,
        summary: `${quote.vendorDisplayName ?? quote.vendorId}: ${quote.itemName ?? quote.itemId ?? "custom"} (${quote.amount} ${quote.asset})`,
        to: quote.vendorAddress,
        amount: quote.amount,
        asset: quote.asset,
        result: order,
    });
    return text({
        registry: vendorRegistrySummary(registry),
        order,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        riskSummary,
        receipt,
        warning: "Local order only. No real vendor was contacted and no payment was sent.",
    });
});
server.tool("order_pay", "Prepare a pay_vendor runbook and optional wallet request for a local order.", {
    orderId: z.string().min(1),
    from: z.string().optional().describe("Optional 0x sender address for prepare_wallet_request."),
    paymentTxHash: z.string().optional().describe("Optional tx hash to mark the order paid after an external payment."),
}, async ({ orderId, from, paymentTxHash }) => {
    const order = await getOrder(orderId);
    if (order.status === "cancelled") {
        return errorText(`order '${orderId}' is cancelled`);
    }
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, order.vendorId);
    const policy = await getMerchantPolicy(order.vendorId);
    const merchantRisk = evaluateMerchantPolicy({
        vendor,
        policy,
        amount: order.amount,
        asset: order.asset,
    });
    const assetPolicy = await evaluateAssetPolicy(order.asset, "commerce");
    const commerceSafety = commerceSafetyForVendor({
        vendor,
        service: order.itemName ?? order.itemId ?? order.vendorDisplayName,
        description: order.fulfillmentFields,
    });
    const riskSummary = renderRisk({
        title: "Order Payment Risk",
        operation: "order_pay",
        amount: order.amount,
        asset: order.asset,
        counterparty: order.vendorDisplayName ?? order.vendorId,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        receiptPath: "order_receipt",
        retryPath: "tx_outbox_retry",
    });
    if (!assetPolicy.policy.ok) {
        return errorJson({
            ok: false,
            order,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            refusal: "Payment preparation refused by local asset/privacy policy.",
        });
    }
    if (!merchantRisk.ok) {
        return errorJson({
            ok: false,
            order,
            merchantRisk,
            commerceSafety,
            riskSummary,
            refusal: "Payment preparation refused by local merchant policy.",
        });
    }
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            order,
            merchantRisk,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            refusal: "Payment preparation refused by local commerce safety policy.",
        });
    }
    const draft = await buildVerifiedRunbookDraft({
        runbook: "pay_vendor",
        fields: {
            recipient: order.vendorAddress,
            vendorId: order.vendorId,
            amount: order.amount,
            asset: order.asset,
            category: "commerce",
            memo: `order:${order.id}`,
        },
        policy: {
            maxAmount: order.amount,
            assetAllowlist: [order.asset],
            vendorAllowlist: [order.vendorId, order.vendorAddress ?? ""].filter(Boolean),
            requireHumanApproval: true,
        },
    });
    const prepared = prepareWalletRequest(draft, from);
    const status = paymentTxHash ? "paid" : "payment_prepared";
    const updated = await updateOrder(order.id, {
        status,
        payment: {
            txHash: paymentTxHash,
            runbookId: draft.id,
            preparedAt: new Date().toISOString(),
        },
    }, {
        type: status,
        data: { paymentTxHash, runbookId: draft.id, prepared },
    });
    const receipt = await addReceipt({
        kind: "order_pay",
        status: paymentTxHash ? "submitted" : "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Payment prepared for order ${order.id}`,
        summary: `${order.amount} ${order.asset} -> ${order.vendorAddress}`,
        to: order.vendorAddress,
        amount: order.amount,
        asset: order.asset,
        txHash: paymentTxHash,
        result: { order: updated, draft, prepared },
    });
    return text({
        order: updated,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        riskSummary,
        draft,
        prepared,
        receipt,
        warning: "Payment preparation only unless paymentTxHash was supplied. Use wallet_build_transfer for local MCP wallet signing.",
    });
});
server.tool("order_mark_paid", "Mark a local order paid after observing or supplying a payment tx hash.", {
    orderId: z.string().min(1),
    txHash: z.string().min(1),
}, async ({ orderId, txHash }) => {
    const order = await updateOrder(orderId, {
        status: "paid",
        payment: {
            ...(await getOrder(orderId)).payment,
            txHash,
        },
    }, {
        type: "paid",
        data: { txHash },
    });
    return text({ order });
});
server.tool("order_status", "Get one local order by id.", {
    orderId: z.string().min(1),
}, async ({ orderId }) => text(await getOrder(orderId)));
server.tool("order_list", "List local demo orders.", {
    status: orderStatusEnum.optional(),
    vendorId: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ status, vendorId, limit }) => text({
    store: await orderStoreInfo(),
    orders: await listOrders({ status: status, vendorId, limit }),
}));
server.tool("order_receipt", "Return a local order receipt with event history.", {
    orderId: z.string().min(1),
}, async ({ orderId }) => {
    const order = await getOrder(orderId);
    return text({
        receipt: {
            id: `order_receipt_${order.id}`,
            order,
            warning: "Local MCP order receipt only. It is not proof of real-world fulfillment.",
        },
    });
});
server.tool("order_cancel", "Cancel a local order if it has not been fulfilled.", {
    orderId: z.string().min(1),
    reason: z.string().optional(),
    confirm: z.literal("CANCEL_ORDER"),
}, async ({ orderId, reason }) => {
    const current = await getOrder(orderId);
    if (current.status === "fulfilled_demo" || current.status === "fulfilled_manual") {
        return errorText("fulfilled orders cannot be cancelled");
    }
    const order = await updateOrder(orderId, {
        status: "cancelled",
        cancelReason: reason,
    }, {
        type: "cancelled",
        note: reason,
    });
    return text({ order });
});
server.tool("order_fulfill_dry_run", "Mark a local demo order fulfilled by a dry-run adapter. No real vendor is contacted.", {
    orderId: z.string().min(1),
    confirm: z.literal("FULFILL_DRY_RUN"),
}, async ({ orderId }) => {
    const current = await getOrder(orderId);
    if (current.status === "cancelled") {
        return errorText("cancelled orders cannot be fulfilled");
    }
    if (current.status === "fulfilled_demo" || current.status === "fulfilled_manual") {
        return errorText("fulfilled orders cannot be fulfilled again");
    }
    const confirmation = `dryrun_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const order = await updateOrder(orderId, {
        status: "fulfilled_demo",
        fulfillment: {
            adapter: "dry_run",
            confirmation,
            fulfilledAt: new Date().toISOString(),
        },
    }, {
        type: "fulfilled_demo",
        data: { confirmation },
        note: "Dry-run fulfillment only.",
    });
    const receipt = await addReceipt({
        kind: "order_fulfill_dry_run",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Dry-run fulfilled order ${order.id}`,
        summary: `${order.vendorDisplayName ?? order.vendorId}: ${confirmation}`,
        to: order.vendorAddress,
        amount: order.amount,
        asset: order.asset,
        result: order,
    });
    return text({
        order,
        receipt,
        warning: "Dry-run fulfillment only. No real goods, food, tickets, services, or gift cards were delivered.",
    });
});
server.tool("order_fulfill_manual", "Mark a local order fulfilled after manual vendor confirmation. This records evidence but does not call an external API.", {
    orderId: z.string().min(1),
    confirmation: z.string().min(1).describe("Vendor confirmation code, receipt id, email reference, or manual evidence id."),
    note: z.string().optional(),
    confirm: z.literal("FULFILL_MANUAL"),
}, async ({ orderId, confirmation, note }) => {
    const current = await getOrder(orderId);
    if (current.status === "cancelled") {
        return errorText("cancelled orders cannot be fulfilled");
    }
    if (current.status === "fulfilled_demo" || current.status === "fulfilled_manual") {
        return errorText("fulfilled orders cannot be fulfilled again");
    }
    const order = await updateOrder(orderId, {
        status: "fulfilled_manual",
        fulfillment: {
            adapter: "manual",
            confirmation,
            fulfilledAt: new Date().toISOString(),
            note,
        },
    }, {
        type: "fulfilled_manual",
        data: { confirmation },
        note,
    });
    const receipt = await addReceipt({
        kind: "order_fulfill_manual",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Manually fulfilled order ${order.id}`,
        summary: `${order.vendorDisplayName ?? order.vendorId}: ${confirmation}`,
        to: order.vendorAddress,
        amount: order.amount,
        asset: order.asset,
        result: order,
    });
    return text({
        order,
        receipt,
        warning: "Manual fulfillment records evidence supplied to the MCP. It does not prove vendor-side delivery unless backed by a real connector or external receipt.",
    });
});
server.tool("order_fulfill_webhook", "Send a local order to a configured vendor webhook connector and record the fulfillment request.", {
    orderId: z.string().min(1),
    connectorId: z.string().min(1).optional().describe("Optional connector id. Defaults to the enabled connector for the order vendor."),
    allowUnpaid: z.boolean().optional().describe("Default false. Set true only for vendors that accept unpaid reservation/quote webhooks."),
    allowRetry: z.boolean().optional().describe("Default false. Set true to resend an already requested fulfillment."),
    extra: recordSchema.describe("Optional connector-specific fields to include in the webhook payload."),
    confirm: z.literal("SEND_ORDER_WEBHOOK"),
}, async ({ orderId, connectorId, allowUnpaid, allowRetry, extra }) => {
    const current = await getOrder(orderId);
    if (current.status === "cancelled") {
        return errorText("cancelled orders cannot be sent to fulfillment");
    }
    if (current.status === "fulfilled_demo" || current.status === "fulfilled_manual") {
        return errorText("fulfilled orders cannot be sent to fulfillment again");
    }
    if (current.status === "fulfillment_requested" && !allowRetry) {
        return errorText("order already has a fulfillment request; set allowRetry=true to send another webhook");
    }
    if (!allowUnpaid && current.status !== "paid") {
        return errorText("order must be marked paid before webhook fulfillment unless allowUnpaid=true");
    }
    const connector = await resolveConnector({ connectorId, vendorId: current.vendorId });
    const payload = {
        schemaVersion: 1,
        type: "order_fulfillment_request",
        network: NETWORK,
        chainId: CHAIN_ID,
        createdAt: new Date().toISOString(),
        order: {
            id: current.id,
            status: current.status,
            vendorId: current.vendorId,
            vendorDisplayName: current.vendorDisplayName,
            itemId: current.itemId,
            itemName: current.itemName,
            quantity: current.quantity,
            amount: current.amount,
            asset: current.asset,
            fulfillmentFields: current.fulfillmentFields,
            payment: current.payment,
        },
        extra: extra ?? {},
    };
    let response;
    try {
        response = await sendConnectorJson(connector, payload);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const order = await updateOrder(current.id, {}, {
            type: "fulfillment_webhook_failed",
            data: { connector: redactConnector(connector), error: message },
        });
        const receipt = await addReceipt({
            kind: "order_fulfill_webhook",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Order webhook failed ${order.id}`,
            summary: `${connector.id}: ${message}`,
            to: order.vendorAddress,
            amount: order.amount,
            asset: order.asset,
            result: { order, connector: redactConnector(connector), error: message },
            error: message,
        });
        return errorJson({ order, connector: redactConnector(connector), receipt, error: message });
    }
    if (!response.ok) {
        const order = await updateOrder(current.id, {}, {
            type: "fulfillment_webhook_failed",
            data: { connector: redactConnector(connector), response },
        });
        const receipt = await addReceipt({
            kind: "order_fulfill_webhook",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Order webhook rejected ${order.id}`,
            summary: `${connector.id}: HTTP ${response.status}`,
            to: order.vendorAddress,
            amount: order.amount,
            asset: order.asset,
            result: { order, connector: redactConnector(connector), response },
            error: `HTTP ${response.status}`,
        });
        return errorJson({ order, connector: redactConnector(connector), response, receipt });
    }
    const confirmation = connectorResponseReference(response.responseBody, `webhook_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const order = await updateOrder(current.id, {
        status: "fulfillment_requested",
        fulfillment: {
            adapter: "webhook",
            confirmation,
            requestedAt: new Date().toISOString(),
            connectorId: connector.id,
            responseStatus: response.status,
            responseHash: response.responseHash,
        },
    }, {
        type: "fulfillment_webhook_sent",
        data: { connector: redactConnector(connector), response },
    });
    const receipt = await addReceipt({
        kind: "order_fulfill_webhook",
        status: "submitted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Order webhook sent ${order.id}`,
        summary: `${connector.id}: HTTP ${response.status}`,
        to: order.vendorAddress,
        amount: order.amount,
        asset: order.asset,
        result: { order, connector: redactConnector(connector), response },
    });
    return text({
        order,
        connector: redactConnector(connector),
        response,
        receipt,
        warning: "Webhook acceptance is not final delivery proof. Use order_fulfill_manual when vendor-side evidence confirms fulfillment.",
    });
});
server.tool("booking_request_create", "Create a local service-booking request and canonical book_service runbook draft.", {
    vendorId: z.string().min(1),
    service: z.string().optional().describe("Requested service, e.g. plumber, flight ticket, pizza delivery."),
    itemId: z.string().optional().describe("Optional vendor catalog item to price the booking."),
    amount: z.string().optional().describe("Direct amount when not using a catalog quote."),
    asset: z.string().optional(),
    requestedWindow: z.string().optional(),
    location: z.string().optional(),
    bookingFields: recordSchema.describe("Structured booking fields such as address, route, passengerName, phone, notes."),
    notes: z.string().optional(),
}, async ({ vendorId, service, itemId, amount, asset, requestedWindow, location, bookingFields, notes }) => {
    const registry = await loadVendors();
    const vendor = getVendor(registry.registry, vendorId);
    const quote = amount
        ? undefined
        : quoteVendorOrder({
            registryHash: registry.payloadHash,
            vendor,
            itemId,
            quantity: 1,
            asset,
            fulfillmentFields: bookingFields,
        });
    const finalAmount = amount ?? quote?.amount ?? "0";
    const finalAsset = String(asset ?? quote?.asset ?? vendor.acceptedAssets?.[0] ?? "LYTH").toUpperCase();
    decimalToUnits(finalAmount);
    const finalService = service ?? quote?.itemName ?? itemId ?? vendor.serviceTags?.[0];
    if (!finalService) {
        return errorText("service or itemId is required for a booking request");
    }
    const assetPolicy = await evaluateAssetPolicy(finalAsset, "service_payment");
    const commerceSafety = commerceSafetyForVendor({
        vendor,
        quote,
        service: finalService,
        description: { bookingFields, location, notes },
    });
    const policy = await getMerchantPolicy(vendor.id);
    const merchantRisk = evaluateMerchantPolicy({
        vendor,
        quote,
        policy,
        amount: finalAmount,
        asset: finalAsset,
    });
    const riskSummary = renderRisk({
        title: "Booking Request Risk",
        operation: "booking_request_create",
        amount: finalAmount,
        asset: finalAsset,
        counterparty: vendor.displayName ?? vendorId,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        receiptPath: "booking_status",
        retryPath: "tx_outbox_retry",
    });
    if (!assetPolicy.policy.ok) {
        return errorJson({
            ok: false,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            merchantRisk,
            riskSummary,
            quote,
            refusal: "Booking creation refused by local asset/privacy policy.",
        });
    }
    if (!merchantRisk.ok) {
        return errorJson({
            ok: false,
            merchantRisk,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            quote,
            refusal: "Booking creation refused by local merchant policy.",
        });
    }
    if (!commerceSafety.ok) {
        return errorJson({
            ok: false,
            merchantRisk,
            assetPolicy: assetPolicy.policy,
            commerceSafety,
            riskSummary,
            quote,
            refusal: "Booking creation refused by local commerce safety policy.",
        });
    }
    const draft = await buildVerifiedRunbookDraft({
        runbook: "book_service",
        fields: {
            vendorId,
            service: finalService,
            amount: finalAmount,
            asset: finalAsset,
            deliveryWindow: requestedWindow,
            location,
            notes,
        },
        policy: {
            maxAmount: finalAmount,
            assetAllowlist: [finalAsset],
            vendorAllowlist: [vendorId, vendor.address ?? ""].filter(Boolean),
            categoryAllowlist: vendor.category ? [vendor.category] : undefined,
            requireHumanApproval: true,
        },
    });
    const booking = await createBooking({
        network: NETWORK,
        chainId: CHAIN_ID,
        vendorId,
        vendorDisplayName: vendor.displayName,
        vendorAddress: vendor.address,
        service: finalService,
        amount: finalAmount,
        asset: finalAsset,
        registryHash: registry.payloadHash,
        requestedWindow,
        location,
        bookingFields,
        quote: quote ?? { amount: finalAmount, asset: finalAsset, service: finalService },
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        riskSummary,
        runbookId: draft.id,
    });
    const receipt = await addReceipt({
        kind: "booking_request_create",
        status: "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Created booking request ${booking.id}`,
        summary: `${vendor.displayName ?? vendorId}: ${finalService} (${finalAmount} ${finalAsset})`,
        to: vendor.address,
        amount: finalAmount,
        asset: finalAsset,
        result: { booking, draft },
    });
    return text({
        registry: vendorRegistrySummary(registry),
        booking,
        merchantRisk,
        assetPolicy: assetPolicy.policy,
        commerceSafety,
        riskSummary,
        draft,
        receipt,
        warning: "Local booking request only. No real provider was contacted.",
    });
});
server.tool("booking_accept_demo", "Mark a local booking accepted by a demo provider. No external provider is contacted.", {
    bookingId: z.string().min(1),
    providerNote: z.string().optional(),
    confirm: z.literal("ACCEPT_DEMO_BOOKING"),
}, async ({ bookingId, providerNote }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled" || current.status === "completed_demo") {
        return errorText(`booking '${bookingId}' cannot be accepted from status ${current.status}`);
    }
    const booking = await updateBooking(bookingId, { status: "accepted_demo" }, {
        type: "accepted_demo",
        note: providerNote,
    });
    return text({
        booking,
        warning: "Demo acceptance only. No real provider was contacted.",
    });
});
server.tool("booking_send_webhook", "Send a local service booking request to a configured vendor webhook connector.", {
    bookingId: z.string().min(1),
    connectorId: z.string().min(1).optional().describe("Optional connector id. Defaults to the enabled connector for the booking vendor."),
    allowRetry: z.boolean().optional().describe("Default false. Set true to resend an already requested booking."),
    extra: recordSchema.describe("Optional connector-specific fields to include in the webhook payload."),
    confirm: z.literal("SEND_BOOKING_WEBHOOK"),
}, async ({ bookingId, connectorId, allowRetry, extra }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled" || current.status === "completed_demo" || current.status === "disputed_demo") {
        return errorText(`booking '${bookingId}' cannot be sent from status ${current.status}`);
    }
    if (current.status === "provider_requested" && !allowRetry) {
        return errorText("booking already has a provider request; set allowRetry=true to send another webhook");
    }
    const connector = await resolveConnector({ connectorId, vendorId: current.vendorId });
    const payload = {
        schemaVersion: 1,
        type: "booking_request",
        network: NETWORK,
        chainId: CHAIN_ID,
        createdAt: new Date().toISOString(),
        booking: {
            id: current.id,
            status: current.status,
            vendorId: current.vendorId,
            vendorDisplayName: current.vendorDisplayName,
            service: current.service,
            amount: current.amount,
            asset: current.asset,
            requestedWindow: current.requestedWindow,
            location: current.location,
            bookingFields: current.bookingFields,
            paymentTxHash: current.paymentTxHash,
            escrow: current.escrow,
        },
        extra: extra ?? {},
    };
    let response;
    try {
        response = await sendConnectorJson(connector, payload);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const booking = await updateBooking(current.id, {}, {
            type: "booking_webhook_failed",
            data: { connector: redactConnector(connector), error: message },
        });
        const receipt = await addReceipt({
            kind: "booking_send_webhook",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Booking webhook failed ${booking.id}`,
            summary: `${connector.id}: ${message}`,
            to: booking.vendorAddress,
            amount: booking.amount,
            asset: booking.asset,
            result: { booking, connector: redactConnector(connector), error: message },
            error: message,
        });
        return errorJson({ booking, connector: redactConnector(connector), receipt, error: message });
    }
    if (!response.ok) {
        const booking = await updateBooking(current.id, {}, {
            type: "booking_webhook_failed",
            data: { connector: redactConnector(connector), response },
        });
        const receipt = await addReceipt({
            kind: "booking_send_webhook",
            status: "failed",
            network: NETWORK,
            chainId: CHAIN_ID,
            title: `Booking webhook rejected ${booking.id}`,
            summary: `${connector.id}: HTTP ${response.status}`,
            to: booking.vendorAddress,
            amount: booking.amount,
            asset: booking.asset,
            result: { booking, connector: redactConnector(connector), response },
            error: `HTTP ${response.status}`,
        });
        return errorJson({ booking, connector: redactConnector(connector), response, receipt });
    }
    const booking = await updateBooking(current.id, {
        status: "provider_requested",
    }, {
        type: "booking_webhook_sent",
        data: {
            connector: redactConnector(connector),
            response,
            reference: connectorResponseReference(response.responseBody, `booking_webhook_${Date.now()}_${randomUUID().slice(0, 8)}`),
        },
    });
    const receipt = await addReceipt({
        kind: "booking_send_webhook",
        status: "submitted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Booking webhook sent ${booking.id}`,
        summary: `${connector.id}: HTTP ${response.status}`,
        to: booking.vendorAddress,
        amount: booking.amount,
        asset: booking.asset,
        result: { booking, connector: redactConnector(connector), response },
    });
    return text({
        booking,
        connector: redactConnector(connector),
        response,
        receipt,
        warning: "Webhook acceptance is not final service acceptance. Use booking_accept_demo or a future provider confirmation adapter when vendor-side evidence is available.",
    });
});
server.tool("booking_prepare_escrow", "Prepare an open_escrow runbook draft for a local booking.", {
    bookingId: z.string().min(1),
    deliverable: z.string().min(1),
    deadline: z.string().optional(),
    arbiter: z.string().optional(),
    acceptanceCriteria: z.string().optional(),
    refundPolicy: z.string().optional(),
    notes: z.string().optional(),
}, async ({ bookingId, deliverable, deadline, arbiter, acceptanceCriteria, refundPolicy, notes }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled" || current.status === "completed_demo") {
        return errorText(`booking '${bookingId}' cannot prepare escrow from status ${current.status}`);
    }
    const draft = await buildVerifiedRunbookDraft({
        runbook: "open_escrow",
        fields: {
            counterparty: current.vendorAddress ?? current.vendorId,
            amount: current.amount,
            asset: current.asset,
            deliverable,
            deadline,
            arbiter,
            acceptanceCriteria,
            refundPolicy,
            notes,
        },
        policy: {
            maxAmount: current.amount,
            assetAllowlist: [current.asset],
            vendorAllowlist: [current.vendorId, current.vendorAddress ?? ""].filter(Boolean),
            expiresAt: deadline,
            requireHumanApproval: true,
        },
    });
    const booking = await updateBooking(bookingId, {
        status: "escrow_prepared",
        escrow: {
            runbookId: draft.id,
            preparedAt: new Date().toISOString(),
        },
    }, {
        type: "escrow_prepared",
        data: { draft },
    });
    const receipt = await addReceipt({
        kind: "booking_prepare_escrow",
        status: "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Prepared escrow for booking ${booking.id}`,
        summary: `${booking.amount} ${booking.asset} escrow for ${deliverable}`,
        to: booking.vendorAddress,
        amount: booking.amount,
        asset: booking.asset,
        result: { booking, draft },
    });
    return text({
        booking,
        draft,
        receipt,
        warning: "Escrow is a runbook draft only until a live escrow module or contract surface is available.",
    });
});
server.tool("booking_mark_paid", "Mark a booking paid after observing or supplying a payment/escrow transaction hash.", {
    bookingId: z.string().min(1),
    txHash: z.string().min(1),
}, async ({ bookingId, txHash }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled") {
        return errorText("cancelled bookings cannot be marked paid");
    }
    const booking = await updateBooking(bookingId, {
        status: "paid",
        paymentTxHash: txHash,
        escrow: current.escrow ? { ...current.escrow, txHash } : undefined,
    }, {
        type: "paid",
        data: { txHash },
    });
    return text({ booking });
});
server.tool("booking_complete_dry_run", "Mark a local booking completed by a dry-run fulfillment adapter.", {
    bookingId: z.string().min(1),
    deliverable: z.string().optional(),
    confirm: z.literal("COMPLETE_DRY_RUN"),
}, async ({ bookingId, deliverable }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled") {
        return errorText("cancelled bookings cannot be completed");
    }
    if (current.status === "disputed_demo") {
        return errorText("disputed demo bookings must be resolved outside the dry-run completion tool");
    }
    const confirmation = `booking_dryrun_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const booking = await updateBooking(bookingId, {
        status: "completed_demo",
        completion: {
            confirmation,
            completedAt: new Date().toISOString(),
            deliverable,
        },
    }, {
        type: "completed_demo",
        data: { confirmation, deliverable },
        note: "Dry-run completion only.",
    });
    const receipt = await addReceipt({
        kind: "booking_complete_dry_run",
        status: "confirmed",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Dry-run completed booking ${booking.id}`,
        summary: `${booking.vendorDisplayName ?? booking.vendorId}: ${confirmation}`,
        to: booking.vendorAddress,
        amount: booking.amount,
        asset: booking.asset,
        result: booking,
    });
    return text({
        booking,
        receipt,
        warning: "Dry-run completion only. No real service was delivered.",
    });
});
server.tool("booking_dispute_demo", "Open a local demo dispute for a booking.", {
    bookingId: z.string().min(1),
    reason: z.string().min(1),
    confirm: z.literal("OPEN_DEMO_DISPUTE"),
}, async ({ bookingId, reason }) => {
    const current = await getBooking(bookingId);
    if (current.status === "cancelled" || current.status === "completed_demo") {
        return errorText(`booking '${bookingId}' cannot be disputed from status ${current.status}`);
    }
    const booking = await updateBooking(bookingId, {
        status: "disputed_demo",
        dispute: {
            reason,
            openedAt: new Date().toISOString(),
        },
    }, {
        type: "disputed_demo",
        note: reason,
    });
    return text({
        booking,
        warning: "Local demo dispute only. Real disputes require a live escrow/arbiter surface.",
    });
});
server.tool("booking_status", "Get one local booking by id.", {
    bookingId: z.string().min(1),
}, async ({ bookingId }) => text(await getBooking(bookingId)));
server.tool("booking_list", "List local service bookings.", {
    status: bookingStatusEnum.optional(),
    vendorId: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ status, vendorId, limit }) => text({
    store: await bookingStoreInfo(),
    bookings: await listBookings({ status: status, vendorId, limit }),
}));
server.tool("booking_cancel", "Cancel a local booking if it has not completed.", {
    bookingId: z.string().min(1),
    reason: z.string().optional(),
    confirm: z.literal("CANCEL_BOOKING"),
}, async ({ bookingId, reason }) => {
    const current = await getBooking(bookingId);
    if (current.status === "completed_demo") {
        return errorText("completed demo bookings cannot be cancelled");
    }
    const booking = await updateBooking(bookingId, {
        status: "cancelled",
        cancelReason: reason,
    }, {
        type: "cancelled",
        note: reason,
    });
    return text({ booking });
});
server.tool("invoice_create", "Create a local invoice requesting payment to an address.", {
    recipient: z.string().describe("0x recipient address."),
    amount: z.string(),
    asset: z.string().optional(),
    purpose: z.string().min(1),
    payer: z.string().optional(),
    expiresAt: z.string().optional(),
    memo: z.string().optional(),
}, async ({ recipient, amount, asset, purpose, payer, expiresAt, memo }) => {
    if (!isWireAddress(recipient)) {
        return errorText("recipient must be a 0x wire address");
    }
    const invoice = await createInvoice({
        type: "invoice",
        network: NETWORK,
        chainId: CHAIN_ID,
        recipient,
        amount,
        asset: asset ?? "LYTH",
        purpose,
        payer,
        expiresAt,
        memo,
    });
    const draft = await buildVerifiedRunbookDraft({
        runbook: "request_funds",
        fields: {
            agentAddress: recipient,
            amount,
            asset: asset ?? "LYTH",
            purpose,
            expiresAt,
        },
        policy: {
            maxAmount: amount,
            assetAllowlist: [asset ?? "LYTH"],
            expiresAt,
            requireHumanApproval: true,
        },
    });
    const receipt = await addReceipt({
        kind: "invoice_create",
        status: "drafted",
        network: NETWORK,
        chainId: CHAIN_ID,
        title: `Created invoice ${invoice.id}`,
        summary: `${amount} ${asset ?? "LYTH"} -> ${recipient}`,
        to: recipient,
        amount,
        asset: asset ?? "LYTH",
        result: { invoice, draft },
    });
    return text({
        invoice,
        draft,
        receipt,
        paymentUri: `monolythium://send?to=${encodeURIComponent(recipient)}&amount=${encodeURIComponent(amount)}&asset=${encodeURIComponent(asset ?? "LYTH")}&chainId=${CHAIN_ID}`,
    });
});
server.tool("funding_request_create", "Create a local agent funding request. The agent can show the returned address/URI to the user.", {
    walletName: z.string().optional().describe("Existing local wallet name. If omitted, recipient is required."),
    recipient: z.string().optional().describe("0x recipient address. Optional when walletName is supplied."),
    amount: z.string(),
    asset: z.string().optional(),
    purpose: z.string().min(1),
    expiresAt: z.string().optional(),
    memo: z.string().optional(),
}, async ({ walletName, recipient, amount, asset, purpose, expiresAt, memo }) => {
    const wallet = walletName ? (await listWallets()).find((item) => item.name === walletName) : null;
    const address = wallet?.address ?? recipient;
    if (!address || !isWireAddress(address)) {
        return errorText("recipient must be a 0x wire address, or walletName must resolve to a local wallet");
    }
    const request = await createInvoice({
        type: "funding_request",
        network: NETWORK,
        chainId: CHAIN_ID,
        recipient: address,
        amount,
        asset: asset ?? "LYTH",
        purpose,
        expiresAt,
        memo,
    });
    const draft = await buildVerifiedRunbookDraft({
        runbook: "request_funds",
        fields: {
            agentAddress: address,
            amount,
            asset: asset ?? "LYTH",
            purpose,
            expiresAt,
        },
        agent: wallet ? { name: wallet.name, address: wallet.address, purpose: wallet.agent?.purpose } : undefined,
        policy: {
            maxAmount: amount,
            assetAllowlist: [asset ?? "LYTH"],
            expiresAt,
            requireHumanApproval: true,
        },
    });
    return text({
        fundingRequest: request,
        draft,
        message: `Send ${amount} ${asset ?? "LYTH"} to ${address} for: ${purpose}`,
        paymentUri: `monolythium://send?to=${encodeURIComponent(address)}&amount=${encodeURIComponent(amount)}&asset=${encodeURIComponent(asset ?? "LYTH")}&chainId=${CHAIN_ID}`,
    });
});
server.tool("invoice_status", "Get a local invoice or funding request.", {
    id: z.string().min(1),
}, async ({ id }) => text(await getInvoice(id)));
server.tool("invoice_list", "List local invoices and funding requests.", {
    status: invoiceStatusEnum.optional(),
    type: z.enum(["invoice", "funding_request"]).optional(),
    limit: z.number().min(1).max(100).optional(),
}, async ({ status, type, limit }) => text({
    store: await invoiceStoreInfo(),
    invoices: await listInvoices({ status: status, type, limit }),
}));
server.tool("invoice_mark_paid", "Mark a local invoice/funding request paid with a tx hash.", {
    id: z.string().min(1),
    txHash: z.string().min(1),
}, async ({ id, txHash }) => {
    const invoice = await updateInvoice(id, { status: "paid", txHash }, "paid", { txHash });
    return text({ invoice });
});
server.tool("invoice_cancel", "Cancel a local open invoice/funding request.", {
    id: z.string().min(1),
    confirm: z.literal("CANCEL_INVOICE"),
}, async ({ id }) => {
    const invoice = await getInvoice(id);
    if (invoice.status === "paid") {
        return errorText("paid invoices cannot be cancelled");
    }
    return text({ invoice: await updateInvoice(id, { status: "cancelled" }, "cancelled") });
});
server.tool("api_get", "Low-level read-only helper for the node /api/v1 surface. Use when a higher-level tool is missing.", {
    path: z.string().describe("Path under /api/v1, e.g. health, stats, blocks/latest."),
    query: z.record(z.union([z.string(), z.number()])).optional(),
}, async ({ path, query }) => {
    const endpoint = await firstReachableEndpoint();
    return text(await apiGet(endpoint, path, query));
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("lyth-mcp fatal:", err);
    process.exit(1);
});
