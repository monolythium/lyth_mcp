export interface NowpaymentsEncryptedPayload {
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
export interface NowpaymentsConfig {
    schemaVersion: 1;
    environment: "sandbox" | "production";
    baseUrl: string;
    encryptedApiKey: NowpaymentsEncryptedPayload;
    encryptedIpnSecret?: NowpaymentsEncryptedPayload;
    ipnCallbackUrl?: string;
    configuredAt: string;
    updatedAt: string;
}
export declare const NOWPAYMENTS_BASES: {
    readonly sandbox: "https://api-sandbox.nowpayments.io/v1";
    readonly production: "https://api.nowpayments.io/v1";
};
export declare function nowpaymentsConfigPath(): string;
export declare function readNowpaymentsConfig(path?: string): Promise<NowpaymentsConfig | null>;
export declare function writeNowpaymentsConfig(config: NowpaymentsConfig, path?: string): Promise<void>;
export declare function configureNowpayments(args: {
    environment: "sandbox" | "production";
    apiKey: string;
    ipnSecret?: string;
    ipnCallbackUrl?: string;
}): Promise<NowpaymentsConfig>;
export interface NowpaymentsStatus {
    message: string;
}
export interface NowpaymentsCurrenciesResponse {
    currencies: string[];
}
export interface NowpaymentsMerchantCoinsResponse {
    selectedCurrencies: string[];
}
export interface NowpaymentsEstimateResponse {
    currency_from: string;
    amount_from: number;
    currency_to: string;
    estimated_amount: number;
}
export interface NowpaymentsPayment {
    payment_id: string | number;
    payment_status: string;
    pay_address: string;
    price_amount: number;
    price_currency: string;
    pay_amount: number;
    pay_currency: string;
    order_id?: string;
    order_description?: string;
    ipn_callback_url?: string;
    created_at?: string;
    updated_at?: string;
    purchase_id?: string;
    amount_received?: number;
    payin_extra_id?: string;
    smart_contract?: string;
    network?: string;
    network_precision?: number;
}
export interface NowpaymentsInvoice {
    id: string | number;
    token_id?: string;
    order_id?: string;
    order_description?: string;
    price_amount: string;
    price_currency: string;
    pay_currency?: string;
    ipn_callback_url?: string;
    invoice_url: string;
    success_url?: string;
    cancel_url?: string;
    created_at?: string;
    updated_at?: string;
}
export declare function nowpaymentsStatus(): Promise<NowpaymentsStatus>;
export declare function nowpaymentsCurrencies(): Promise<NowpaymentsCurrenciesResponse>;
export declare function nowpaymentsMerchantCoins(): Promise<NowpaymentsMerchantCoinsResponse>;
export declare function nowpaymentsEstimate(args: {
    amount: number;
    currencyFrom: string;
    currencyTo: string;
}): Promise<NowpaymentsEstimateResponse>;
export declare function nowpaymentsCreatePayment(args: {
    priceAmount: number;
    priceCurrency: string;
    payCurrency: string;
    orderId?: string;
    orderDescription?: string;
    ipnCallbackUrl?: string;
    payAmount?: number;
    payinExtraId?: string;
}): Promise<NowpaymentsPayment>;
export declare function nowpaymentsCreateInvoice(args: {
    priceAmount: number;
    priceCurrency: string;
    payCurrency?: string;
    orderId?: string;
    orderDescription?: string;
    ipnCallbackUrl?: string;
    successUrl?: string;
    cancelUrl?: string;
}): Promise<NowpaymentsInvoice>;
export declare function nowpaymentsGetPayment(paymentId: string): Promise<NowpaymentsPayment>;
export declare function nowpaymentsListPayments(args?: {
    limit?: number;
    page?: number;
    dateFrom?: string;
    dateTo?: string;
}): Promise<{
    data: NowpaymentsPayment[];
    limit?: number;
    page?: number;
    totalCount?: number;
}>;
export interface NowpaymentsRefundDraft {
    paymentId: string;
    reason: string;
    recipientAddress?: string;
    status: "drafted_manual";
    note: string;
}
export declare function nowpaymentsRefundDraft(args: {
    paymentId: string;
    reason: string;
    recipientAddress?: string;
}): NowpaymentsRefundDraft;
export declare function canonicalizeForIpn(obj: unknown): string;
export declare function verifyNowpaymentsIpn(args: {
    rawBody: string;
    sigHeader: string;
}): Promise<{
    valid: boolean;
    reason?: string;
    parsed?: unknown;
}>;
export declare function nowpaymentsRedactedConfig(): Promise<{
    environment: NowpaymentsConfig["environment"];
    baseUrl: string;
    ipnCallbackUrl?: string;
    apiKeyConfigured: boolean;
    ipnSecretConfigured: boolean;
    configuredAt?: string;
    updatedAt?: string;
} | null>;
