import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, deriveEvmAddress, hexToBytes, isAddress, toChecksumAddress, unlockEvmPrivateKeyBytes, EVM_CHAINS, } from "./evm_wallet.js";
import { findEvmToken, requireEvmToken } from "./evm_tokens.js";
const DEFAULT_ENDPOINTS = {
    1: ["https://eth.llamarpc.com", "https://cloudflare-eth.com", "https://ethereum-rpc.publicnode.com"],
    8453: ["https://mainnet.base.org", "https://base.llamarpc.com", "https://base-rpc.publicnode.com"],
};
export function evmRpcEndpoints(chainId) {
    const envKey = `LYTH_MCP_EVM_RPC_${chainId}`;
    const envValue = process.env[envKey];
    if (envValue) {
        return envValue.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return DEFAULT_ENDPOINTS[chainId] ?? [];
}
export function isEvmSubmitEnabled() {
    return process.env.LYTH_MCP_ENABLE_EVM_SUBMIT === "1";
}
let RPC_COUNTER = 0;
export async function evmRpcCall(endpoint, method, params = [], timeoutMs = 8000) {
    const id = ++RPC_COUNTER;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`RPC ${endpoint} HTTP ${res.status}`);
        }
        const body = (await res.json());
        if (body.error) {
            throw new Error(`RPC ${method} error: ${body.error.message}`);
        }
        if (body.result === undefined) {
            throw new Error(`RPC ${method} returned no result`);
        }
        return body.result;
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function probeEvmEndpoints(chainId, endpoints) {
    const list = endpoints ?? evmRpcEndpoints(chainId);
    return Promise.all(list.map(async (endpoint) => {
        const started = Date.now();
        try {
            const [chainHex, blockHex] = await Promise.all([
                evmRpcCall(endpoint, "eth_chainId"),
                evmRpcCall(endpoint, "eth_blockNumber"),
            ]);
            const reported = Number(BigInt(chainHex));
            return {
                endpoint,
                ok: true,
                chainIdMatch: reported === chainId,
                reportedChainId: reported,
                latencyMs: Date.now() - started,
                blockNumber: Number(BigInt(blockHex)),
            };
        }
        catch (err) {
            return { endpoint, ok: false, error: err.message, latencyMs: Date.now() - started };
        }
    }));
}
export async function selectEvmEndpoint(chainId) {
    const endpoints = evmRpcEndpoints(chainId);
    if (endpoints.length === 0) {
        throw new Error(`no RPC endpoints configured for chain ${chainId}; set LYTH_MCP_EVM_RPC_${chainId}`);
    }
    const probes = await probeEvmEndpoints(chainId, endpoints);
    const healthy = probes.filter((p) => p.ok && p.chainIdMatch);
    if (healthy.length === 0) {
        const reasons = probes.map((p) => `${p.endpoint}: ${p.error ?? `chainId=${p.reportedChainId}`}`).join("; ");
        throw new Error(`no healthy RPC endpoints for chain ${chainId}: ${reasons}`);
    }
    healthy.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
    return healthy[0].endpoint;
}
export async function quoteEip1559Fee(endpoint, priorityFloorWei) {
    const block = await evmRpcCall(endpoint, "eth_getBlockByNumber", ["latest", false]);
    if (!block.baseFeePerGas) {
        throw new Error("RPC returned no baseFeePerGas; chain may not support EIP-1559");
    }
    const baseFee = BigInt(block.baseFeePerGas);
    let priority;
    let source = "eth_maxPriorityFeePerGas";
    try {
        const tipHex = await evmRpcCall(endpoint, "eth_maxPriorityFeePerGas");
        priority = BigInt(tipHex);
    }
    catch {
        const gasPriceHex = await evmRpcCall(endpoint, "eth_gasPrice");
        priority = BigInt(gasPriceHex);
        source = "eth_gasPrice_fallback";
    }
    if (priorityFloorWei && priority < priorityFloorWei) {
        priority = priorityFloorWei;
    }
    const maxFee = baseFee * 2n + priority;
    return { baseFeePerGas: baseFee, maxPriorityFeePerGas: priority, maxFeePerGas: maxFee, source };
}
export async function getEvmNonce(endpoint, address) {
    const hex = await evmRpcCall(endpoint, "eth_getTransactionCount", [address, "pending"]);
    return BigInt(hex);
}
export async function getEvmNativeBalance(endpoint, address) {
    const hex = await evmRpcCall(endpoint, "eth_getBalance", [address, "latest"]);
    return BigInt(hex);
}
export async function getErc20Balance(endpoint, token, address) {
    const data = encodeErc20BalanceOf(address);
    const hex = await evmRpcCall(endpoint, "eth_call", [{ to: token, data }, "latest"]);
    return BigInt(hex);
}
export async function getErc20Allowance(endpoint, token, owner, spender) {
    const data = encodeErc20Allowance(owner, spender);
    const hex = await evmRpcCall(endpoint, "eth_call", [{ to: token, data }, "latest"]);
    return BigInt(hex);
}
export async function estimateGas(endpoint, call) {
    const hex = await evmRpcCall(endpoint, "eth_estimateGas", [call]);
    return BigInt(hex);
}
export async function sendRawEvmTransaction(endpoint, signedHex) {
    return evmRpcCall(endpoint, "eth_sendRawTransaction", [signedHex]);
}
export async function getEvmReceipt(endpoint, txHash) {
    return (await evmRpcCall(endpoint, "eth_getTransactionReceipt", [txHash])) ?? null;
}
// -----------------------------------------------------------------------------
// ERC-20 calldata encoding
// -----------------------------------------------------------------------------
const SELECTOR_TRANSFER = "a9059cbb"; // transfer(address,uint256)
const SELECTOR_APPROVE = "095ea7b3"; // approve(address,uint256)
const SELECTOR_ALLOWANCE = "dd62ed3e"; // allowance(address,address)
const SELECTOR_BALANCE_OF = "70a08231"; // balanceOf(address)
function padHex(value, len) {
    const stripped = value.replace(/^0x/, "").toLowerCase();
    if (stripped.length > len)
        throw new Error(`hex too long to pad to ${len}`);
    return stripped.padStart(len, "0");
}
function encodeAddressArg(address) {
    if (!isAddress(address))
        throw new Error(`invalid address: ${address}`);
    return padHex(address, 64);
}
function encodeUint256(value) {
    if (value < 0n)
        throw new Error("uint256 cannot be negative");
    return padHex(value.toString(16), 64);
}
export function encodeErc20Transfer(to, amountUnits) {
    return `0x${SELECTOR_TRANSFER}${encodeAddressArg(to)}${encodeUint256(amountUnits)}`;
}
export function encodeErc20Approve(spender, amountUnits) {
    return `0x${SELECTOR_APPROVE}${encodeAddressArg(spender)}${encodeUint256(amountUnits)}`;
}
export function encodeErc20Allowance(owner, spender) {
    return `0x${SELECTOR_ALLOWANCE}${encodeAddressArg(owner)}${encodeAddressArg(spender)}`;
}
export function encodeErc20BalanceOf(owner) {
    return `0x${SELECTOR_BALANCE_OF}${encodeAddressArg(owner)}`;
}
export function rlpEncode(input) {
    if (input instanceof Uint8Array) {
        if (input.length === 1 && input[0] < 0x80) {
            return input;
        }
        return concat(encodeLength(input.length, 0x80), input);
    }
    const items = input.map(rlpEncode);
    const totalLen = items.reduce((s, i) => s + i.length, 0);
    return concat(encodeLength(totalLen, 0xc0), ...items);
}
function encodeLength(len, offset) {
    if (len < 56) {
        return Uint8Array.of(offset + len);
    }
    const hex = len.toString(16);
    const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
    const bytes = hexToBytes(padded);
    return concat(Uint8Array.of(offset + 55 + bytes.length), bytes);
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
function bigintToBytes(value) {
    if (value < 0n)
        throw new Error("negative integers not RLP-encodable here");
    if (value === 0n)
        return new Uint8Array(0);
    let hex = value.toString(16);
    if (hex.length % 2 !== 0)
        hex = `0${hex}`;
    return hexToBytes(hex);
}
function addressToBytes(address) {
    if (!isAddress(address))
        throw new Error(`invalid address: ${address}`);
    return hexToBytes(address.replace(/^0x/, ""));
}
function txFieldsAsRlp(tx) {
    return [
        bigintToBytes(BigInt(tx.chainId)),
        bigintToBytes(tx.nonce),
        bigintToBytes(tx.maxPriorityFeePerGas),
        bigintToBytes(tx.maxFeePerGas),
        bigintToBytes(tx.gasLimit),
        addressToBytes(tx.to),
        bigintToBytes(tx.value),
        hexToBytes(tx.data.replace(/^0x/, "") || ""),
        [], // empty access list
    ];
}
export function eip1559SigHash(tx) {
    const rlp = rlpEncode(txFieldsAsRlp(tx));
    const envelope = concat(Uint8Array.of(0x02), rlp);
    return keccak_256(envelope);
}
export function signEip1559(tx, privateKey) {
    const sigHash = eip1559SigHash(tx);
    const sigBytes = secp256k1.sign(sigHash, privateKey, { lowS: true, format: "recovered" });
    const sig = secp256k1.Signature.fromBytes(sigBytes, "recovered");
    const r = sig.r;
    const s = sig.s;
    const yParity = sig.recovery; // 0 or 1
    const signedFields = [
        ...txFieldsAsRlp(tx),
        bigintToBytes(BigInt(yParity)),
        bigintToBytes(r),
        bigintToBytes(s),
    ];
    const signedRlp = rlpEncode(signedFields);
    const envelope = concat(Uint8Array.of(0x02), signedRlp);
    const rawTxHex = `0x${bytesToHex(envelope)}`;
    const txHash = `0x${bytesToHex(keccak_256(envelope))}`;
    const from = deriveFromPrivateKey(privateKey);
    return { rawTxHex, txHash, from, sigHashHex: `0x${bytesToHex(sigHash)}` };
}
function deriveFromPrivateKey(privateKey) {
    return deriveEvmAddress(privateKey).address;
}
// -----------------------------------------------------------------------------
// High-level transfer builders
// -----------------------------------------------------------------------------
const DEFAULT_NATIVE_GAS = 21000n;
const DEFAULT_ERC20_GAS = 65000n;
const DEFAULT_APPROVE_GAS = 55000n;
function decimalToUnits(amount, decimals) {
    if (!/^\d+(\.\d+)?$/.test(amount.trim()))
        throw new Error(`invalid decimal: ${amount}`);
    const [whole, frac = ""] = amount.trim().split(".");
    if (frac.length > decimals)
        throw new Error(`too many decimal places for ${decimals}-decimal asset`);
    return BigInt(whole + frac.padEnd(decimals, "0"));
}
function unitsToDecimal(value, decimals) {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const raw = abs.toString().padStart(decimals + 1, "0");
    const whole = raw.slice(0, -decimals);
    const frac = raw.slice(-decimals).replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
const ETH_DECIMALS = 18;
export async function buildEvmNativeTransfer(args) {
    if (!isAddress(args.to))
        throw new Error(`invalid recipient: ${args.to}`);
    const chain = EVM_CHAINS[args.chainId];
    if (!chain)
        throw new Error(`unsupported chain ${args.chainId}`);
    if (!args.wallet.allowedChainIds.includes(args.chainId)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for chain ${args.chainId}`);
    }
    const symbol = chain.symbol;
    if (!args.wallet.allowedAssets.includes(symbol)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for asset ${symbol}`);
    }
    const amountWei = decimalToUnits(args.amount, ETH_DECIMALS);
    const endpoint = await selectEvmEndpoint(args.chainId);
    const [feeQuote, nonce, nativeBalance] = await Promise.all([
        quoteEip1559Fee(endpoint),
        getEvmNonce(endpoint, args.wallet.address),
        getEvmNativeBalance(endpoint, args.wallet.address),
    ]);
    const gasLimit = args.gasLimit ?? DEFAULT_NATIVE_GAS;
    const estimatedFee = gasLimit * feeQuote.maxFeePerGas;
    const totalNeeded = amountWei + estimatedFee;
    const tx = {
        chainId: args.chainId,
        nonce,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
        maxFeePerGas: feeQuote.maxFeePerGas,
        gasLimit,
        to: toChecksumAddress(args.to),
        value: amountWei,
        data: "0x",
    };
    const built = {
        kind: "native",
        chainId: args.chainId,
        chainName: chain.name,
        walletName: args.wallet.name,
        walletAddress: args.wallet.address,
        asset: symbol,
        amount: args.amount,
        amountUnits: amountWei.toString(),
        to: tx.to,
        tx: serializeTxForResponse(tx),
        fee: feeSummary(feeQuote, gasLimit),
        preflight: {
            nativeBalance: unitsToDecimal(nativeBalance, ETH_DECIMALS),
            nativeBalanceWei: nativeBalance.toString(),
            sufficientForGas: nativeBalance >= estimatedFee,
            sufficientForAmount: nativeBalance >= totalNeeded,
            selectedEndpoint: endpoint,
            chainIdMatch: true,
        },
    };
    if (args.sign !== false) {
        const pk = await unlockEvmPrivateKeyBytes(args.wallet.name, args.passphrase);
        const signed = signEip1559(tx, pk);
        built.signed = {
            rawTxHex: signed.rawTxHex,
            txHash: signed.txHash,
            sigHashHex: signed.sigHashHex,
            submitEnabled: isEvmSubmitEnabled(),
        };
        if (args.submit && isEvmSubmitEnabled()) {
            const txHash = await sendRawEvmTransaction(endpoint, signed.rawTxHex);
            built.submitted = { txHash, broadcastEndpoint: endpoint };
        }
        else if (args.submit && !isEvmSubmitEnabled()) {
            built.warning = "Submit requested but LYTH_MCP_ENABLE_EVM_SUBMIT is not set to 1. Signed tx not broadcast.";
        }
    }
    return built;
}
export async function buildErc20Transfer(args) {
    if (!isAddress(args.to))
        throw new Error(`invalid recipient: ${args.to}`);
    const chain = EVM_CHAINS[args.chainId];
    if (!chain)
        throw new Error(`unsupported chain ${args.chainId}`);
    if (!args.wallet.allowedChainIds.includes(args.chainId)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for chain ${args.chainId}`);
    }
    const sym = args.asset.toUpperCase();
    if (!args.wallet.allowedAssets.includes(sym)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for asset ${sym}`);
    }
    const token = requireEvmToken(args.chainId, sym);
    const amountUnits = decimalToUnits(args.amount, token.decimals);
    const endpoint = await selectEvmEndpoint(args.chainId);
    const data = encodeErc20Transfer(args.to, amountUnits);
    const [feeQuote, nonce, nativeBalance, tokenBalance] = await Promise.all([
        quoteEip1559Fee(endpoint),
        getEvmNonce(endpoint, args.wallet.address),
        getEvmNativeBalance(endpoint, args.wallet.address),
        getErc20Balance(endpoint, token.address, args.wallet.address),
    ]);
    const gasLimit = args.gasLimit ?? DEFAULT_ERC20_GAS;
    const estimatedFee = gasLimit * feeQuote.maxFeePerGas;
    const tx = {
        chainId: args.chainId,
        nonce,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
        maxFeePerGas: feeQuote.maxFeePerGas,
        gasLimit,
        to: token.address,
        value: 0n,
        data,
    };
    const built = {
        kind: "erc20_transfer",
        chainId: args.chainId,
        chainName: chain.name,
        walletName: args.wallet.name,
        walletAddress: args.wallet.address,
        asset: sym,
        amount: args.amount,
        amountUnits: amountUnits.toString(),
        to: toChecksumAddress(args.to),
        tokenAddress: token.address,
        tx: serializeTxForResponse(tx),
        fee: feeSummary(feeQuote, gasLimit),
        preflight: {
            nativeBalance: unitsToDecimal(nativeBalance, ETH_DECIMALS),
            nativeBalanceWei: nativeBalance.toString(),
            sufficientForGas: nativeBalance >= estimatedFee,
            tokenBalance: unitsToDecimal(tokenBalance, token.decimals),
            tokenBalanceUnits: tokenBalance.toString(),
            sufficientForAmount: tokenBalance >= amountUnits,
            selectedEndpoint: endpoint,
            chainIdMatch: true,
        },
    };
    if (args.sign !== false) {
        const pk = await unlockEvmPrivateKeyBytes(args.wallet.name, args.passphrase);
        const signed = signEip1559(tx, pk);
        built.signed = {
            rawTxHex: signed.rawTxHex,
            txHash: signed.txHash,
            sigHashHex: signed.sigHashHex,
            submitEnabled: isEvmSubmitEnabled(),
        };
        if (args.submit && isEvmSubmitEnabled()) {
            const txHash = await sendRawEvmTransaction(endpoint, signed.rawTxHex);
            built.submitted = { txHash, broadcastEndpoint: endpoint };
        }
        else if (args.submit && !isEvmSubmitEnabled()) {
            built.warning = "Submit requested but LYTH_MCP_ENABLE_EVM_SUBMIT is not set to 1. Signed tx not broadcast.";
        }
    }
    return built;
}
export async function buildErc20Approve(args) {
    if (!isAddress(args.spender))
        throw new Error(`invalid spender: ${args.spender}`);
    const chain = EVM_CHAINS[args.chainId];
    if (!chain)
        throw new Error(`unsupported chain ${args.chainId}`);
    if (!args.wallet.allowedChainIds.includes(args.chainId)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for chain ${args.chainId}`);
    }
    const sym = args.asset.toUpperCase();
    if (!args.wallet.allowedAssets.includes(sym)) {
        throw new Error(`wallet '${args.wallet.name}' not configured for asset ${sym}`);
    }
    const token = requireEvmToken(args.chainId, sym);
    const amountUnits = decimalToUnits(args.amount, token.decimals);
    const endpoint = await selectEvmEndpoint(args.chainId);
    const data = encodeErc20Approve(args.spender, amountUnits);
    const [feeQuote, nonce, nativeBalance] = await Promise.all([
        quoteEip1559Fee(endpoint),
        getEvmNonce(endpoint, args.wallet.address),
        getEvmNativeBalance(endpoint, args.wallet.address),
    ]);
    const gasLimit = args.gasLimit ?? DEFAULT_APPROVE_GAS;
    const estimatedFee = gasLimit * feeQuote.maxFeePerGas;
    const tx = {
        chainId: args.chainId,
        nonce,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
        maxFeePerGas: feeQuote.maxFeePerGas,
        gasLimit,
        to: token.address,
        value: 0n,
        data,
    };
    const built = {
        kind: "erc20_approve",
        chainId: args.chainId,
        chainName: chain.name,
        walletName: args.wallet.name,
        walletAddress: args.wallet.address,
        asset: sym,
        amount: args.amount,
        amountUnits: amountUnits.toString(),
        to: toChecksumAddress(args.spender),
        tokenAddress: token.address,
        tx: serializeTxForResponse(tx),
        fee: feeSummary(feeQuote, gasLimit),
        preflight: {
            nativeBalance: unitsToDecimal(nativeBalance, ETH_DECIMALS),
            nativeBalanceWei: nativeBalance.toString(),
            sufficientForGas: nativeBalance >= estimatedFee,
            sufficientForAmount: true,
            selectedEndpoint: endpoint,
            chainIdMatch: true,
        },
    };
    if (args.sign !== false) {
        const pk = await unlockEvmPrivateKeyBytes(args.wallet.name, args.passphrase);
        const signed = signEip1559(tx, pk);
        built.signed = {
            rawTxHex: signed.rawTxHex,
            txHash: signed.txHash,
            sigHashHex: signed.sigHashHex,
            submitEnabled: isEvmSubmitEnabled(),
        };
        if (args.submit && isEvmSubmitEnabled()) {
            const txHash = await sendRawEvmTransaction(endpoint, signed.rawTxHex);
            built.submitted = { txHash, broadcastEndpoint: endpoint };
        }
        else if (args.submit && !isEvmSubmitEnabled()) {
            built.warning = "Submit requested but LYTH_MCP_ENABLE_EVM_SUBMIT is not set to 1. Signed tx not broadcast.";
        }
    }
    return built;
}
export async function readErc20Allowance(args) {
    const token = requireEvmToken(args.chainId, args.asset);
    const endpoint = await selectEvmEndpoint(args.chainId);
    const units = await getErc20Allowance(endpoint, token.address, args.owner, args.spender);
    return {
        allowance: unitsToDecimal(units, token.decimals),
        allowanceUnits: units.toString(),
        token,
        endpoint,
    };
}
function serializeTxForResponse(tx) {
    return {
        nonce: `0x${tx.nonce.toString(16)}`,
        maxPriorityFeePerGas: `0x${tx.maxPriorityFeePerGas.toString(16)}`,
        maxFeePerGas: `0x${tx.maxFeePerGas.toString(16)}`,
        gasLimit: `0x${tx.gasLimit.toString(16)}`,
        to: tx.to,
        value: `0x${tx.value.toString(16)}`,
        data: tx.data,
    };
}
function feeSummary(quote, gasLimit) {
    const estimatedFee = gasLimit * quote.maxFeePerGas;
    return {
        baseFeePerGas: `${unitsToDecimal(quote.baseFeePerGas, 9)} gwei`,
        maxPriorityFeePerGas: `${unitsToDecimal(quote.maxPriorityFeePerGas, 9)} gwei`,
        maxFeePerGas: `${unitsToDecimal(quote.maxFeePerGas, 9)} gwei`,
        estimatedFeeWei: estimatedFee.toString(),
        estimatedFeeEth: unitsToDecimal(estimatedFee, ETH_DECIMALS),
        source: quote.source,
    };
}
// Helper for index.ts: returns the token, if any, for (chain, symbol)
export function evmTokenInfo(chainId, symbol) {
    return findEvmToken(chainId, symbol);
}
