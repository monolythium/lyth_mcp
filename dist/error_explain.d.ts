export type ErrorClassification = "mempool_envelope_decryption" | "broadcast_disabled" | "rpc_unavailable" | "insufficient_funds" | "nonce_or_duplicate" | "privacy_policy" | "commerce_safety" | "merchant_policy" | "bridge_route" | "contract_revert" | "user_rejected" | "unknown";
export interface ErrorExplainInput {
    errorMessage?: string;
    code?: string | number;
    rpcMethod?: string;
    tool?: string;
    txHash?: string;
    outboxId?: string;
    context?: unknown;
}
export interface ErrorExplanation {
    ok: false;
    classification: ErrorClassification;
    retryable: boolean;
    severity: "info" | "warning" | "blocked" | "unknown";
    plainEnglish: string;
    likelyCause: string;
    recommendedActions: string[];
    evidence: string[];
    policyFailures: string[];
    warnings: string[];
    assumptions: string[];
}
export declare function explainError(input: ErrorExplainInput): ErrorExplanation;
