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
export interface ChangenowEncryptedPayload {
    cipher: "aes-256-gcm";
    kdf: "scrypt";
    params: {
        n: number;
        r: number;
        p: number;
        keyLen: number;
    };
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
}
export interface ChangenowConfig {
    schemaVersion: 1;
    baseUrl: string;
    /** Public API key — used to create swaps, run estimates, etc. */
    encryptedApiKey: ChangenowEncryptedPayload;
    /** Private API key — required for /exchanges listing endpoint. Separate
     *  from the public key in ChangeNow's partner program. */
    encryptedPrivateApiKey?: ChangenowEncryptedPayload;
    /** Partner code drives revenue share. Optional — swap still works without it. */
    encryptedPartnerCode?: ChangenowEncryptedPayload;
    /** Refund-on-failure address. Defaults to the swap sender's address per ChangeNow rules. */
    defaultRefundAddress?: string;
    configuredAt: string;
    updatedAt: string;
}
export declare function changenowConfigPath(): string;
export declare function readChangenowConfig(path?: string): Promise<ChangenowConfig | null>;
export declare function writeChangenowConfig(config: ChangenowConfig, path?: string): Promise<void>;
export declare function configureChangenow(args: {
    apiKey: string;
    /** Private API key — only required for swap listing. Get from the partner dashboard. */
    privateApiKey?: string;
    partnerCode?: string;
    defaultRefundAddress?: string;
}): Promise<ChangenowConfig>;
export interface ChangenowCurrency {
    ticker: string;
    name: string;
    image?: string;
    hasExternalId?: boolean;
    isFiat?: boolean;
    featured?: boolean;
    isStable?: boolean;
    supportsFixedRate?: boolean;
    network?: string;
    tokenContract?: string | null;
    buy?: boolean;
    sell?: boolean;
    legacyTicker?: string;
}
export interface ChangenowEstimate {
    fromCurrency: string;
    fromNetwork?: string;
    toCurrency: string;
    toNetwork?: string;
    flow: "standard" | "fixed-rate";
    type: "direct" | "reverse";
    rateId?: string;
    validUntil?: string;
    transactionSpeedForecast?: string;
    warningMessage?: string | null;
    depositFee?: number;
    withdrawalFee?: number;
    /** What the receiver gets in toCurrency. */
    toAmount?: number;
    /** What the sender pays in fromCurrency. */
    fromAmount?: number;
}
export interface ChangenowSwap {
    id: string;
    payinAddress: string;
    payoutAddress: string;
    fromCurrency: string;
    fromNetwork?: string;
    toCurrency: string;
    toNetwork?: string;
    refundAddress?: string;
    payinExtraId?: string;
    payoutExtraId?: string;
    fromAmount?: string | number;
    expectedAmount?: string | number;
    flow?: "standard" | "fixed-rate";
    type?: "direct" | "reverse";
    rateId?: string;
    validUntil?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    partner?: string;
}
export declare function changenowStatus(): Promise<{
    ok: boolean;
    baseUrl: string;
    partnerConfigured: boolean;
    serverTime?: string;
    configuredAt?: string;
    updatedAt?: string;
}>;
export declare function changenowCurrencies(args: {
    active?: boolean;
    flow?: "standard" | "fixed-rate";
    buy?: boolean;
    sell?: boolean;
}): Promise<ChangenowCurrency[]>;
export declare function changenowMinAmount(args: {
    fromCurrency: string;
    toCurrency: string;
    fromNetwork?: string;
    toNetwork?: string;
    flow?: "standard" | "fixed-rate";
}): Promise<{
    minAmount: number;
}>;
export declare function changenowEstimate(args: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount?: number;
    toAmount?: number;
    fromNetwork?: string;
    toNetwork?: string;
    flow?: "standard" | "fixed-rate";
    type?: "direct" | "reverse";
}): Promise<ChangenowEstimate>;
/**
 * Create a non-custodial swap order. Routes through the approval bridge
 * (Stele's secure overlay, or any other host that set LYTH_MCP_APPROVAL_URL)
 * before submitting — so a Claude-initiated swap can't fire without an
 * explicit human approval when Stele is the host.
 */
export declare function changenowCreateSwap(args: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount?: number | string;
    toAmount?: number | string;
    /** Address that will receive `toCurrency`. */
    payoutAddress: string;
    /** Memo / tag for chains that need it (XRP, ATOM, etc.). */
    payoutExtraId?: string;
    /** Where ChangeNow sends the funds back if the swap fails. */
    refundAddress?: string;
    refundExtraId?: string;
    fromNetwork?: string;
    toNetwork?: string;
    flow?: "standard" | "fixed-rate";
    type?: "direct" | "reverse";
    /** For fixed-rate flow, the rateId returned by `changenow_estimate`. */
    rateId?: string;
    /** Optional override of the configured partner code. */
    partner?: string;
}): Promise<ChangenowSwap>;
export declare function changenowSwapStatus(id: string): Promise<ChangenowSwap>;
export declare function changenowSwapList(args?: {
    limit?: number;
    offset?: number;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
}): Promise<{
    data: ChangenowSwap[];
    total?: number;
}>;
export declare function changenowFiatEstimate(args: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount?: number;
    toAmount?: number;
}): Promise<unknown>;
export declare function changenowFiatSellDraft(args: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: number;
    /** Payout details — bank wire info, etc. KYC may be required by ChangeNow. */
    payoutDetails: Record<string, unknown>;
    /** Refund address on the crypto side if the fiat leg fails. */
    refundAddress?: string;
}): Promise<{
    draft: {
        endpoint: "/fiat-transaction";
        method: "POST";
        body: Record<string, unknown>;
    };
    warning: string;
}>;
export declare function changenowRedactedConfig(): Promise<{
    baseUrl: string;
    apiKeyConfigured: boolean;
    privateApiKeyConfigured: boolean;
    partnerConfigured: boolean;
    defaultRefundAddress?: string;
    configuredAt?: string;
    updatedAt?: string;
} | null>;
