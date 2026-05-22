import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes, isAddress, unlockEvmPrivateKeyBytes, } from "./evm_wallet.js";
// -----------------------------------------------------------------------------
// Network name ↔ chain id
// -----------------------------------------------------------------------------
const NETWORK_TO_CHAIN_ID = {
    "base": 8453,
    "base-mainnet": 8453,
    "base-sepolia": 84532,
    "ethereum": 1,
    "ethereum-mainnet": 1,
    "mainnet": 1,
    "polygon": 137,
    "polygon-mainnet": 137,
    "arbitrum": 42161,
    "arbitrum-one": 42161,
    "optimism": 10,
};
export function x402NetworkToChainId(network) {
    const id = NETWORK_TO_CHAIN_ID[network.toLowerCase()];
    if (!id)
        throw new Error(`unsupported x402 network: ${network}`);
    return id;
}
export function chainIdToX402Network(chainId) {
    for (const [name, id] of Object.entries(NETWORK_TO_CHAIN_ID)) {
        if (id === chainId && (name === "base" || name === "ethereum" || name === "polygon")) {
            return name;
        }
    }
    return null;
}
// -----------------------------------------------------------------------------
// EIP-712 hashing (for EIP-3009 TransferWithAuthorization)
// -----------------------------------------------------------------------------
const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const TRANSFER_WITH_AUTHORIZATION_TYPE = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
function keccak256Hex(input) {
    return `0x${bytesToHex(keccak_256(input))}`;
}
function typeHash(typeString) {
    return keccak_256(new TextEncoder().encode(typeString));
}
function padLeft32(bytes) {
    if (bytes.length > 32)
        throw new Error("value too long for 32-byte slot");
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
}
function uint256ToBytes(value) {
    if (value < 0n)
        throw new Error("uint256 must be non-negative");
    let hex = value.toString(16);
    if (hex.length % 2 !== 0)
        hex = `0${hex}`;
    return padLeft32(hexToBytes(hex));
}
function addressTo32(address) {
    if (!isAddress(address))
        throw new Error(`invalid address: ${address}`);
    return padLeft32(hexToBytes(address.replace(/^0x/, "")));
}
function bytes32(hex) {
    const stripped = hex.replace(/^0x/, "");
    if (stripped.length !== 64)
        throw new Error(`bytes32 expected 32 bytes, got ${stripped.length / 2}`);
    return hexToBytes(stripped);
}
function encodeDomainSeparator(args) {
    const parts = [
        typeHash(EIP712_DOMAIN_TYPE),
        keccak_256(new TextEncoder().encode(args.name)),
        keccak_256(new TextEncoder().encode(args.version)),
        uint256ToBytes(BigInt(args.chainId)),
        addressTo32(args.verifyingContract),
    ];
    return keccak_256(concat(...parts));
}
function encodeTransferWithAuthorizationStruct(auth) {
    const parts = [
        typeHash(TRANSFER_WITH_AUTHORIZATION_TYPE),
        addressTo32(auth.from),
        addressTo32(auth.to),
        uint256ToBytes(BigInt(auth.value)),
        uint256ToBytes(BigInt(auth.validAfter)),
        uint256ToBytes(BigInt(auth.validBefore)),
        bytes32(auth.nonce),
    ];
    return keccak_256(concat(...parts));
}
function concat(...parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
export function eip712DigestForTransferAuth(args) {
    const domainSep = encodeDomainSeparator(args.domain);
    const structHash = encodeTransferWithAuthorizationStruct(args.authorization);
    return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSep, structHash));
}
export function signEip712TransferAuth(args) {
    const digest = eip712DigestForTransferAuth({ domain: args.domain, authorization: args.authorization });
    const sigBytes = secp256k1.sign(digest, args.privateKey, { lowS: true, format: "recovered" });
    const sig = secp256k1.Signature.fromBytes(sigBytes, "recovered");
    const r = uint256ToBytes(sig.r);
    const s = uint256ToBytes(sig.s);
    const v = 27 + (sig.recovery ?? 0);
    return `0x${bytesToHex(concat(r, s, Uint8Array.of(v)))}`;
}
export function pickPaymentRequirement(args) {
    if (!args.policy.originAllowlist.includes(args.origin)) {
        return { ok: false, reason: `origin ${args.origin} not in vendor policy allowlist` };
    }
    if (args.body.x402Version !== 1) {
        return { ok: false, reason: `unsupported x402Version: ${args.body.x402Version}` };
    }
    if (!Array.isArray(args.body.accepts) || args.body.accepts.length === 0) {
        return { ok: false, reason: "402 body has no accepts entries" };
    }
    for (const req of args.body.accepts) {
        if (req.scheme !== "exact")
            continue;
        let chainId;
        try {
            chainId = x402NetworkToChainId(req.network);
        }
        catch {
            continue;
        }
        if (!args.wallet.allowedChainIds.includes(chainId))
            continue;
        const symbol = req.extra?.name?.toUpperCase();
        if (!symbol)
            continue;
        if (args.assetSymbolHint && args.assetSymbolHint.toUpperCase() !== symbol)
            continue;
        if (!args.policy.allowedAssets.includes(symbol))
            continue;
        if (!args.wallet.allowedAssets.includes(symbol))
            continue;
        const capKey = `${chainId}:${symbol}`;
        const cap = args.policy.maxPaymentPerRequest[capKey];
        if (cap) {
            const capAtomic = BigInt(cap);
            if (BigInt(req.maxAmountRequired) > capAtomic) {
                return {
                    ok: false,
                    reason: `maxAmountRequired ${req.maxAmountRequired} exceeds vendor cap ${cap} for ${capKey}`,
                };
            }
        }
        return { ok: true, requirement: req, chainId };
    }
    return { ok: false, reason: "no accepts entry matches wallet allowlist + vendor policy" };
}
const PAYMENT_RESPONSE_HEADERS = ["x-payment-response", "X-PAYMENT-RESPONSE"];
function originOf(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
}
export async function x402Pay(args) {
    const method = args.method?.toUpperCase() ?? "GET";
    const origin = originOf(args.url);
    const initialHeaders = {
        accept: "application/json",
        ...(args.headers ?? {}),
    };
    if (args.body !== undefined && !initialHeaders["content-type"] && !initialHeaders["Content-Type"]) {
        initialHeaders["content-type"] = "application/json";
    }
    const initialBody = args.body === undefined ? undefined : (typeof args.body === "string" ? args.body : JSON.stringify(args.body));
    let first;
    try {
        first = await fetch(args.url, { method, headers: initialHeaders, body: initialBody });
    }
    catch (err) {
        return { ok: false, status: 0, url: args.url, retried: false, error: `network error: ${err.message}` };
    }
    if (first.status !== 402) {
        return finalizeResponse(args.url, first, false);
    }
    const ct = first.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
        const txt = await first.text();
        return { ok: false, status: 402, url: args.url, retried: false, error: `402 missing application/json body`, bodyText: txt };
    }
    const requirements = (await first.json());
    const decision = pickPaymentRequirement({ body: requirements, origin, policy: args.policy, wallet: args.wallet, assetSymbolHint: args.assetSymbolHint });
    if (!decision.ok || !decision.requirement || !decision.chainId) {
        return { ok: false, status: 402, url: args.url, retried: false, requirements, error: decision.reason };
    }
    const req = decision.requirement;
    const chainId = decision.chainId;
    if (args.dryRun) {
        return {
            ok: true,
            status: 402,
            url: args.url,
            retried: false,
            requirements,
            selectedRequirement: req,
            error: "dry-run: payment not signed or submitted",
        };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const validityWindow = Math.min(req.maxTimeoutSeconds, args.validityWindowSeconds ?? req.maxTimeoutSeconds);
    const authorization = {
        from: args.wallet.address,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: String(nowSec - 30),
        validBefore: String(nowSec + validityWindow),
        nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const domain = {
        name: req.extra?.name ?? "USDC",
        version: req.extra?.version ?? "2",
        chainId,
        verifyingContract: req.asset,
    };
    const pk = await unlockEvmPrivateKeyBytes(args.wallet.name, args.passphrase);
    const signature = signEip712TransferAuth({ domain, authorization, privateKey: pk });
    const payload = {
        x402Version: 1,
        scheme: "exact",
        network: req.network,
        payload: { signature, authorization },
    };
    const headerB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    let retry;
    try {
        retry = await fetch(args.url, {
            method,
            headers: { ...initialHeaders, "X-PAYMENT": headerB64 },
            body: initialBody,
        });
    }
    catch (err) {
        return {
            ok: false,
            status: 0,
            url: args.url,
            retried: true,
            requirements,
            selectedRequirement: req,
            error: `network error on retry: ${err.message}`,
        };
    }
    const result = await finalizeResponse(args.url, retry, true);
    result.requirements = requirements;
    result.selectedRequirement = req;
    result.paymentReceipt = {
        network: req.network,
        chainId,
        asset: domain.name,
        amountAtomic: req.maxAmountRequired,
        payTo: req.payTo,
        nonce: authorization.nonce,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        digest: `0x${bytesToHex(eip712DigestForTransferAuth({ domain, authorization }))}`,
        signature,
        headerB64,
    };
    for (const h of PAYMENT_RESPONSE_HEADERS) {
        const raw = retry.headers.get(h);
        if (raw) {
            try {
                const decoded = Buffer.from(raw, "base64").toString("utf8");
                const parsed = JSON.parse(decoded);
                result.settlement = parsed;
            }
            catch {
                result.settlement = { success: false };
            }
            break;
        }
    }
    return result;
}
async function finalizeResponse(url, res, retried) {
    const ct = res.headers.get("content-type") ?? "";
    let body = undefined;
    let bodyText;
    try {
        if (ct.includes("application/json")) {
            body = await res.json();
        }
        else {
            bodyText = await res.text();
        }
    }
    catch {
        bodyText = "<unreadable body>";
    }
    return {
        ok: res.ok,
        status: res.status,
        url,
        retried,
        body,
        bodyText,
    };
}
