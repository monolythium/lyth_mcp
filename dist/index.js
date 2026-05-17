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
import { bridgeCircuitBreakerAlerts, bridgeCooldownMatrix, bridgeRegistrySummary, bridgeStatusSummary, getBridgeRoute, listBridgeRoutes, loadBridgeRegistry, quoteBridgeRoute, selectBridgeRoute, } from "./bridges.js";
import { assetRegistrySummary, assetRisk, evaluateAssetUseCase, getAsset, listAssets, loadAssetRegistry, privateDenominationWarning, } from "./assets.js";
import { commerceSafetySummary } from "./commerce_safety.js";
import { createOrder, getOrder, listOrders, orderStoreInfo, updateOrder, } from "./orders.js";
import { bookingStoreInfo, createBooking, getBooking, listBookings, updateBooking, } from "./bookings.js";
import { createInvoice, getInvoice, invoiceStoreInfo, listInvoices, updateInvoice, } from "./invoices.js";
import { explainError } from "./error_explain.js";
import { evaluateMerchantPolicy, getMerchantPolicy, listMerchantPolicies, merchantPolicyStoreInfo, removeMerchantPolicy, upsertMerchantPolicy, } from "./merchant_policy.js";
import { diffRunbookContent, getCanonicalRunbook, listCanonicalRunbooks, } from "./runbooks.js";
import { renderRisk } from "./risk_renderer.js";
import { getVendor, loadVendorRegistry, quoteVendorOrder, searchVendors, vendorRegistrySummary, } from "./vendors.js";
import { buildTransfer, configureLowValuePolicy, createWallet, deleteWallet, encryptionKeyFromRpc, exportMnemonic, importWallet, listWallets, moveLowValueAccounting, unitsToDecimal, updateAgentWalletMetadata, walletStoreInfo, } from "./wallet.js";
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
function outboxMethod(kind) {
    return kind === "eth_raw" ? "eth_sendRawTransaction" : "lyth_submitEncrypted";
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
const bridgeRouteTypeEnum = z.enum(["ibc", "zk_light_client", "trusted", "issuer_native", "manual"]);
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
    kind: z.enum(["eth_raw", "lyth_encrypted"]).describe("eth_raw uses eth_sendRawTransaction; lyth_encrypted uses lyth_submitEncrypted."),
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
    const method = kind === "eth_raw" ? "eth_sendRawTransaction" : "lyth_submitEncrypted";
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
    const lines = [
        "# Lyth MCP Dashboard",
        "",
        `Network: ${NETWORK} (${CHAIN_ID})`,
        `Broadcast: ${SUBMIT_ENABLED ? "enabled" : "disabled"}`,
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
server.tool("bridge_cooldown_matrix", "Show the configured cooldown matrix for IBC, zk-light-client, Bitcoin, Solana, Ethereum, and trusted routes.", {
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
server.tool("bridge_circuit_breaker_watch", "Watch configured bridge routes for paused routes, non-active status, trusted-route risk, missing audit metadata, and low drain caps.", {
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
            "Prefer IBC or zk-light-client routes over trusted/transitional routes when active.",
            "Draft routes explain intended cooldowns and risk, but should not be treated as executable.",
            "Trusted routes should keep longer cooldowns until a zk/light-client path replaces them.",
        ],
    });
});
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
