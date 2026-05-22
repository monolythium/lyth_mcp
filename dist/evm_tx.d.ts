import { type EvmWalletRecord } from "./evm_wallet.js";
import { type EvmTokenRecord } from "./evm_tokens.js";
export interface EvmRpcConfig {
    chainId: number;
    endpoints: string[];
}
export declare function evmRpcEndpoints(chainId: number): string[];
export declare function isEvmSubmitEnabled(): boolean;
export declare function evmRpcCall<T = unknown>(endpoint: string, method: string, params?: unknown[], timeoutMs?: number): Promise<T>;
export interface EvmEndpointHealth {
    endpoint: string;
    ok: boolean;
    chainIdMatch?: boolean;
    reportedChainId?: number;
    latencyMs?: number;
    blockNumber?: number;
    error?: string;
}
export declare function probeEvmEndpoints(chainId: number, endpoints?: string[]): Promise<EvmEndpointHealth[]>;
export declare function selectEvmEndpoint(chainId: number): Promise<string>;
export interface EvmFeeQuote {
    baseFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    source: "eth_maxPriorityFeePerGas" | "eth_gasPrice_fallback";
}
export declare function quoteEip1559Fee(endpoint: string, priorityFloorWei?: bigint): Promise<EvmFeeQuote>;
export declare function getEvmNonce(endpoint: string, address: string): Promise<bigint>;
export declare function getEvmNativeBalance(endpoint: string, address: string): Promise<bigint>;
export declare function getErc20Balance(endpoint: string, token: string, address: string): Promise<bigint>;
export declare function getErc20Allowance(endpoint: string, token: string, owner: string, spender: string): Promise<bigint>;
export declare function estimateGas(endpoint: string, call: {
    from: string;
    to: string;
    data: string;
    value?: string;
}): Promise<bigint>;
export declare function sendRawEvmTransaction(endpoint: string, signedHex: string): Promise<string>;
export declare function getEvmReceipt(endpoint: string, txHash: string): Promise<{
    status?: string;
    blockNumber?: string;
} | null>;
export declare function encodeErc20Transfer(to: string, amountUnits: bigint): string;
export declare function encodeErc20Approve(spender: string, amountUnits: bigint): string;
export declare function encodeErc20Allowance(owner: string, spender: string): string;
export declare function encodeErc20BalanceOf(owner: string): string;
export type RlpInput = Uint8Array | RlpInput[];
export declare function rlpEncode(input: RlpInput): Uint8Array;
export interface Eip1559Tx {
    chainId: number;
    nonce: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    gasLimit: bigint;
    to: string;
    value: bigint;
    data: string;
}
export declare function eip1559SigHash(tx: Eip1559Tx): Uint8Array;
export interface SignedEip1559 {
    rawTxHex: string;
    txHash: string;
    from: string;
    sigHashHex: string;
}
export declare function signEip1559(tx: Eip1559Tx, privateKey: Uint8Array): SignedEip1559;
export interface BuiltEvmTransfer {
    kind: "native" | "erc20_transfer" | "erc20_approve";
    chainId: number;
    chainName: string;
    walletName: string;
    walletAddress: string;
    asset: string;
    amount: string;
    amountUnits: string;
    to: string;
    tokenAddress?: string;
    tx: {
        nonce: string;
        maxPriorityFeePerGas: string;
        maxFeePerGas: string;
        gasLimit: string;
        to: string;
        value: string;
        data: string;
    };
    fee: {
        baseFeePerGas: string;
        maxPriorityFeePerGas: string;
        maxFeePerGas: string;
        estimatedFeeWei: string;
        estimatedFeeEth: string;
        source: EvmFeeQuote["source"];
    };
    preflight: {
        nativeBalance: string;
        nativeBalanceWei: string;
        sufficientForGas: boolean;
        tokenBalance?: string;
        tokenBalanceUnits?: string;
        sufficientForAmount: boolean;
        selectedEndpoint: string;
        chainIdMatch: boolean;
    };
    signed?: {
        rawTxHex: string;
        txHash: string;
        sigHashHex: string;
        submitEnabled: boolean;
    };
    submitted?: {
        txHash: string;
        broadcastEndpoint: string;
    };
    warning?: string;
}
export declare function buildEvmNativeTransfer(args: {
    wallet: EvmWalletRecord;
    chainId: number;
    to: string;
    amount: string;
    passphrase?: string;
    sign?: boolean;
    submit?: boolean;
    gasLimit?: bigint;
}): Promise<BuiltEvmTransfer>;
export declare function buildErc20Transfer(args: {
    wallet: EvmWalletRecord;
    chainId: number;
    asset: string;
    to: string;
    amount: string;
    passphrase?: string;
    sign?: boolean;
    submit?: boolean;
    gasLimit?: bigint;
}): Promise<BuiltEvmTransfer>;
export declare function buildErc20Approve(args: {
    wallet: EvmWalletRecord;
    chainId: number;
    asset: string;
    spender: string;
    amount: string;
    passphrase?: string;
    sign?: boolean;
    submit?: boolean;
    gasLimit?: bigint;
}): Promise<BuiltEvmTransfer>;
export declare function readErc20Allowance(args: {
    chainId: number;
    asset: string;
    owner: string;
    spender: string;
}): Promise<{
    allowance: string;
    allowanceUnits: string;
    token: EvmTokenRecord;
    endpoint: string;
}>;
export declare function evmTokenInfo(chainId: number, symbol: string): EvmTokenRecord | null;
