import { type EvmWalletRecord } from "./evm_wallet.js";
export interface X402PaymentRequirements {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
    resource: string;
    description: string;
    mimeType?: string;
    outputSchema?: unknown;
    maxTimeoutSeconds: number;
    extra?: {
        name?: string;
        version?: string;
    };
}
export interface X402PaymentRequiredBody {
    x402Version: number;
    error?: string;
    accepts: X402PaymentRequirements[];
}
export interface X402Authorization {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
}
export interface X402ExactPayload {
    signature: string;
    authorization: X402Authorization;
}
export interface X402PaymentPayload {
    x402Version: number;
    scheme: "exact";
    network: string;
    payload: X402ExactPayload;
}
export declare function x402NetworkToChainId(network: string): number;
export declare function chainIdToX402Network(chainId: number): string | null;
export declare function eip712DigestForTransferAuth(args: {
    domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
    };
    authorization: X402Authorization;
}): Uint8Array;
export declare function signEip712TransferAuth(args: {
    domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
    };
    authorization: X402Authorization;
    privateKey: Uint8Array;
}): string;
export interface X402VendorPolicy {
    vendorId: string;
    originAllowlist: string[];
    maxPaymentPerRequest: Record<string, string>;
    allowedAssets: string[];
    walletName: string;
    notes?: string;
}
export interface X402Decision {
    ok: boolean;
    reason?: string;
    requirement?: X402PaymentRequirements;
    chainId?: number;
}
export declare function pickPaymentRequirement(args: {
    body: X402PaymentRequiredBody;
    origin: string;
    policy: X402VendorPolicy;
    wallet: EvmWalletRecord;
    assetSymbolHint?: string;
}): X402Decision;
export interface X402PayResult {
    ok: boolean;
    status: number;
    url: string;
    retried: boolean;
    paymentReceipt?: {
        network: string;
        chainId: number;
        asset: string;
        amountAtomic: string;
        payTo: string;
        nonce: string;
        validAfter: string;
        validBefore: string;
        digest: string;
        signature: string;
        headerB64: string;
    };
    body?: unknown;
    bodyText?: string;
    requirements?: X402PaymentRequiredBody;
    selectedRequirement?: X402PaymentRequirements;
    error?: string;
    settlement?: {
        success: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
    };
}
export interface X402PayArgs {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    wallet: EvmWalletRecord;
    policy: X402VendorPolicy;
    assetSymbolHint?: string;
    passphrase?: string;
    validityWindowSeconds?: number;
    dryRun?: boolean;
}
export declare function x402Pay(args: X402PayArgs): Promise<X402PayResult>;
