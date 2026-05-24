/**
 * ChangeNow integration — non-custodial swap + fiat off-ramp.
 *
 * Mirrors the storage + transport pattern of `nowpayments.ts` so audit/
 * rotation/secret-handling stays uniform across providers.
 *
 * API: https://api.changenow.io/v2 (v2 uses `x-changenow-api-key` header).
 * Partner program: pass `partner` (alias of partnerCode) on swap creation
 * and the configured revenue share goes to the partner account.
 *
 * Crypto-flow surface (wired):
 *   - changenow_configure        — store API key + partner code (AES-256-GCM + scrypt)
 *   - changenow_status           — health probe + redacted config
 *   - changenow_currencies       — supported currencies (with onchain identifiers)
 *   - changenow_min_amount       — min swappable
 *   - changenow_estimate         — quote (standard or fixed-rate)
 *   - changenow_swap_create      — create a swap, return deposit address
 *   - changenow_swap_status      — poll a swap
 *   - changenow_swap_list        — list past swaps
 *
 * Fiat off-ramp surface (DRAFT-ONLY for now):
 *   - changenow_fiat_estimate    — quote crypto → fiat
 *   - changenow_fiat_sell_draft  — draft the sell-to-fiat payload (caller
 *                                  approves; we do NOT submit until KYC
 *                                  hand-off is decided)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { requireApproval } from "./approval.js";
const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
const CHANGENOW_V2_BASE = "https://api.changenow.io/v2";
export function changenowConfigPath() {
    return (process.env.LYTH_MCP_CHANGENOW_CONFIG ||
        join(homedir(), ".lyth_mcp", "changenow.json"));
}
function changenowKeyPath() {
    return (process.env.LYTH_MCP_CHANGENOW_KEY ||
        join(homedir(), ".lyth_mcp", "changenow.key"));
}
async function readOrCreateKey() {
    const path = changenowKeyPath();
    try {
        return (await readFile(path, "utf8")).trim();
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
    const key = randomBytes(32).toString("hex");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    return key;
}
function deriveKey(passphrase, salt, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }) {
    return scryptSync(passphrase, salt, params.keyLen, {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: 64 * 1024 * 1024,
    });
}
function encryptSecret(secret, passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        cipher: "aes-256-gcm",
        kdf: "scrypt",
        params: { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN },
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
    };
}
function decryptSecret(payload, passphrase) {
    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const key = deriveKey(passphrase, salt, payload.params);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
export async function readChangenowConfig(path = changenowConfigPath()) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== STORE_VERSION) {
            throw new Error(`unsupported changenow config shape at ${path}`);
        }
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
export async function writeChangenowConfig(config, path = changenowConfigPath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
}
export async function configureChangenow(args) {
    if (!args.apiKey || args.apiKey.length < 8) {
        throw new Error("changenow api key is required (min 8 chars)");
    }
    const key = await readOrCreateKey();
    const existing = await readChangenowConfig();
    const now = new Date().toISOString();
    const config = {
        schemaVersion: STORE_VERSION,
        baseUrl: CHANGENOW_V2_BASE,
        encryptedApiKey: encryptSecret(args.apiKey, key),
        encryptedPrivateApiKey: args.privateApiKey
            ? encryptSecret(args.privateApiKey, key)
            : existing?.encryptedPrivateApiKey,
        encryptedPartnerCode: args.partnerCode
            ? encryptSecret(args.partnerCode, key)
            : existing?.encryptedPartnerCode,
        defaultRefundAddress: args.defaultRefundAddress ?? existing?.defaultRefundAddress,
        configuredAt: existing?.configuredAt ?? now,
        updatedAt: now,
    };
    await writeChangenowConfig(config);
    return config;
}
async function requireConfig() {
    const config = await readChangenowConfig();
    if (!config)
        throw new Error("changenow not configured; call changenow_configure first");
    const localKey = await readOrCreateKey();
    return {
        config,
        apiKey: decryptSecret(config.encryptedApiKey, localKey),
        privateApiKey: config.encryptedPrivateApiKey
            ? decryptSecret(config.encryptedPrivateApiKey, localKey)
            : undefined,
        partnerCode: config.encryptedPartnerCode
            ? decryptSecret(config.encryptedPartnerCode, localKey)
            : undefined,
    };
}
async function cnRequest(method, path, options = {}) {
    const { config, apiKey, privateApiKey } = await requireConfig();
    const key = options.usePrivateKey ? privateApiKey : apiKey;
    if (options.usePrivateKey && !privateApiKey) {
        throw new Error("changenow private api key not configured — call changenow_configure with `privateApiKey` (separate from the public api key, available in the partner dashboard)");
    }
    const url = new URL(config.baseUrl + path);
    if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        }
    }
    const headers = { "x-changenow-api-key": key };
    if (options.body !== undefined)
        headers["content-type"] = "application/json";
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const res = await fetch(url.toString(), { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`changenow ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
    }
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch (err) {
        throw new Error(`changenow ${method} ${path} returned non-json: ${text.slice(0, 200)}`);
    }
}
// ============================================================
// Public functions — wired
// ============================================================
export async function changenowStatus() {
    const { config, partnerCode } = await requireConfig();
    let serverTime;
    try {
        // ChangeNow v2 has no public /health route; ping currencies as a cheap probe.
        await cnRequest("GET", "/exchange/currencies", { query: { active: true } });
        serverTime = new Date().toISOString();
    }
    catch (e) {
        return {
            ok: false,
            baseUrl: config.baseUrl,
            partnerConfigured: !!partnerCode,
            configuredAt: config.configuredAt,
            updatedAt: config.updatedAt,
        };
    }
    return {
        ok: true,
        baseUrl: config.baseUrl,
        partnerConfigured: !!partnerCode,
        serverTime,
        configuredAt: config.configuredAt,
        updatedAt: config.updatedAt,
    };
}
export async function changenowCurrencies(args) {
    return cnRequest("GET", "/exchange/currencies", {
        query: {
            active: args.active,
            flow: args.flow,
            buy: args.buy,
            sell: args.sell,
        },
    });
}
export async function changenowMinAmount(args) {
    return cnRequest("GET", "/exchange/min-amount", {
        query: {
            fromCurrency: args.fromCurrency.toLowerCase(),
            toCurrency: args.toCurrency.toLowerCase(),
            fromNetwork: args.fromNetwork,
            toNetwork: args.toNetwork,
            flow: args.flow ?? "standard",
        },
    });
}
export async function changenowEstimate(args) {
    if (args.fromAmount === undefined && args.toAmount === undefined) {
        throw new Error("changenow_estimate requires fromAmount or toAmount");
    }
    return cnRequest("GET", "/exchange/estimated-amount", {
        query: {
            fromCurrency: args.fromCurrency.toLowerCase(),
            toCurrency: args.toCurrency.toLowerCase(),
            fromAmount: args.fromAmount,
            toAmount: args.toAmount,
            fromNetwork: args.fromNetwork,
            toNetwork: args.toNetwork,
            flow: args.flow ?? "standard",
            type: args.type ?? (args.fromAmount !== undefined ? "direct" : "reverse"),
        },
    });
}
/**
 * Create a non-custodial swap order. Routes through the approval bridge
 * (Stele's secure overlay, or any other host that set LYTH_MCP_APPROVAL_URL)
 * before submitting — so a Claude-initiated swap can't fire without an
 * explicit human approval when Stele is the host.
 */
export async function changenowCreateSwap(args) {
    const { config, partnerCode } = await requireConfig();
    const refundAddress = args.refundAddress ?? config.defaultRefundAddress;
    const body = {
        fromCurrency: args.fromCurrency.toLowerCase(),
        toCurrency: args.toCurrency.toLowerCase(),
        fromAmount: args.fromAmount,
        toAmount: args.toAmount,
        address: args.payoutAddress,
        extraId: args.payoutExtraId,
        refundAddress,
        refundExtraId: args.refundExtraId,
        fromNetwork: args.fromNetwork,
        toNetwork: args.toNetwork,
        flow: args.flow ?? "standard",
        type: args.type ?? (args.fromAmount !== undefined ? "direct" : "reverse"),
        rateId: args.rateId,
        partner: args.partner ?? partnerCode,
    };
    // Gated by the host (Stele) when LYTH_MCP_APPROVAL_URL is set; no-op
    // otherwise so standalone-MCP behavior is preserved.
    await requireApproval({
        tool: "changenow_swap_create",
        summary: `Swap ${args.fromAmount ?? "?"} ${args.fromCurrency}/${args.fromNetwork ?? "-"} → ${args.toCurrency}/${args.toNetwork ?? "-"} (payout: ${args.payoutAddress})`,
        prepared_tx: body,
    });
    return cnRequest("POST", "/exchange", { body });
}
export async function changenowSwapStatus(id) {
    return cnRequest("GET", "/exchange/by-id", { query: { id } });
}
export async function changenowSwapList(args = {}) {
    // ChangeNow v2 listing endpoint is `/exchanges` (GET) — requires the
    // private API key, not the public swap-creation key. Returns an array.
    const data = await cnRequest("GET", "/exchanges", {
        usePrivateKey: true,
        query: {
            limit: args.limit ?? 25,
            offset: args.offset ?? 0,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            status: args.status,
        },
    });
    return { data, total: data.length };
}
// ============================================================
// Fiat off-ramp — DRAFT-ONLY for now
// Final wire requires KYC hand-off decision. See `docs/lyth-mcp-gaps.md`
// in stele-desktop for the larger fiat conversation.
// ============================================================
export async function changenowFiatEstimate(args) {
    return cnRequest("GET", "/fiat-estimate", {
        query: {
            from_currency: args.fromCurrency.toLowerCase(),
            to_currency: args.toCurrency.toLowerCase(),
            from_amount: args.fromAmount,
            to_amount: args.toAmount,
        },
    });
}
export async function changenowFiatSellDraft(args) {
    const { config } = await requireConfig();
    return {
        draft: {
            endpoint: "/fiat-transaction",
            method: "POST",
            body: {
                from_currency: args.fromCurrency.toLowerCase(),
                to_currency: args.toCurrency.toLowerCase(),
                from_amount: args.fromAmount,
                payout_details: args.payoutDetails,
                refund_address: args.refundAddress ?? config.defaultRefundAddress,
            },
        },
        warning: "Fiat off-ramp involves KYC and irreversible bank transfers. Submission is intentionally not wired yet; review payload + complete KYC out-of-band before calling the endpoint manually.",
    };
}
export async function changenowRedactedConfig() {
    const config = await readChangenowConfig();
    if (!config)
        return null;
    return {
        baseUrl: config.baseUrl,
        apiKeyConfigured: true,
        privateApiKeyConfigured: !!config.encryptedPrivateApiKey,
        partnerConfigured: !!config.encryptedPartnerCode,
        defaultRefundAddress: config.defaultRefundAddress,
        configuredAt: config.configuredAt,
        updatedAt: config.updatedAt,
    };
}
