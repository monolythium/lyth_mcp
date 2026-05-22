export declare const EVM_CHAINS: Record<number, {
    name: string;
    symbol: string;
    explorer?: string;
}>;
export declare const DEFAULT_EVM_CHAIN_IDS: number[];
export interface EvmEncryptedPayload {
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
export interface EvmAgentMetadata {
    purpose?: string;
    maxBalance?: string;
    allowedCounterparties?: string[];
    allowedCategories?: string[];
    expiresAt?: string;
    fallbackApproval?: "passphrase" | "wallet_handoff" | "deny";
    paused?: boolean;
    updatedAt: string;
}
export type EvmAccountingBucket = "reserved" | "submitted" | "confirmed" | "failed" | "expired";
export interface EvmCap {
    chainId: number;
    asset: string;
    maxPerTx: string;
    dailyLimit?: string;
}
export interface EvmCapAccounting {
    day: string;
    reserved: string;
    submitted: string;
    confirmed: string;
    failed: string;
    expired: string;
}
export interface EvmLowValuePolicy {
    enabled: boolean;
    caps: EvmCap[];
    day?: string;
    accounting?: Record<string, EvmCapAccounting>;
    configuredAt: string;
}
export interface EvmWalletRecord {
    name: string;
    address: string;
    publicKey: string;
    algorithm: "secp256k1-EVM";
    keyProtection: "passphrase" | "local_machine_key";
    createdAt: string;
    encryptedPrivateKey: EvmEncryptedPayload;
    allowedChainIds: number[];
    allowedAssets: string[];
    agent?: EvmAgentMetadata;
    lowValue?: EvmLowValuePolicy;
}
export interface EvmWalletStore {
    schemaVersion: 1;
    wallets: EvmWalletRecord[];
}
export interface EvmWalletSummary {
    name: string;
    address: string;
    publicKey: string;
    algorithm: "secp256k1-EVM";
    keyProtection: "passphrase" | "local_machine_key";
    createdAt: string;
    allowedChainIds: number[];
    allowedAssets: string[];
    agent?: EvmAgentMetadata;
    lowValue?: EvmLowValuePolicy;
}
export declare function evmWalletStorePath(): string;
export declare function evmHotKeyPath(): string;
export declare function evmLocalKeyPath(): string;
export declare function readEvmWalletStore(path?: string): Promise<EvmWalletStore>;
export declare function writeEvmWalletStore(store: EvmWalletStore, path?: string): Promise<void>;
export declare function evmWalletStoreInfo(path?: string): Promise<{
    path: string;
    walletCount: number;
    wallets: EvmWalletSummary[];
    hotKeyPath: string;
    localKeyPath: string;
    fileMode: string | null;
}>;
export declare function createEvmWallet(args: {
    name: string;
    passphrase?: string;
    revealPrivateKey?: boolean;
    overwrite?: boolean;
    allowLocalKey?: boolean;
    allowedChainIds?: number[];
    allowedAssets?: string[];
    agent?: Omit<EvmAgentMetadata, "updatedAt">;
    lowValue?: {
        enabled: boolean;
        caps: EvmCap[];
    };
}): Promise<EvmWalletSummary & {
    privateKey?: string;
    storePath: string;
}>;
export declare function importEvmWallet(args: {
    name: string;
    privateKey: string;
    passphrase?: string;
    overwrite?: boolean;
    allowLocalKey?: boolean;
    allowedChainIds?: number[];
    allowedAssets?: string[];
    agent?: Omit<EvmAgentMetadata, "updatedAt">;
}): Promise<EvmWalletSummary & {
    storePath: string;
}>;
export declare function listEvmWallets(): Promise<EvmWalletSummary[]>;
export declare function getEvmWallet(name: string): Promise<EvmWalletRecord>;
export declare function exportEvmPrivateKey(name: string, passphrase?: string): Promise<string>;
export declare function unlockEvmPrivateKeyBytes(name: string, passphrase?: string): Promise<Uint8Array>;
export declare function configureEvmLowValuePolicy(args: {
    name: string;
    enabled: boolean;
    caps?: EvmCap[];
}): Promise<EvmWalletSummary>;
export declare function updateEvmAgentMetadata(args: {
    name: string;
    patch: Partial<Omit<EvmAgentMetadata, "updatedAt">>;
}): Promise<EvmWalletSummary>;
export declare function pauseEvmWallet(name: string): Promise<EvmWalletSummary>;
export declare function deleteEvmWallet(name: string, confirmName: string): Promise<{
    deleted: boolean;
    storePath: string;
}>;
export declare function removeEvmWalletStoreForTestsOnly(path: string): Promise<void>;
export interface EvmFundingDraft {
    network: "evm";
    chainId: number;
    chainName: string;
    asset: string;
    amount: string;
    recipientAddress: string;
    purpose: string;
    expiresAt?: string;
    walletName: string;
    message: string;
    warning: string;
}
export declare function draftEvmFundingRequest(args: {
    name: string;
    chainId: number;
    asset: string;
    amount: string;
    purpose: string;
    expiresAt?: string;
}): Promise<EvmFundingDraft>;
export interface EvmDrainDraftStub {
    network: "evm";
    chainId: number;
    chainName: string;
    walletName: string;
    fromAddress: string;
    toAddress: string;
    assets: string[];
    note: string;
}
export declare function draftEvmDrain(args: {
    name: string;
    chainId: number;
    toAddress: string;
}): Promise<EvmDrainDraftStub>;
export interface EvmCapDecision {
    ok: boolean;
    reason?: string;
    cap?: EvmCap;
    accountingKey?: string;
    before?: EvmCapAccounting;
}
export declare function checkEvmCap(policy: EvmLowValuePolicy | undefined, chainId: number, asset: string, amount: string): EvmCapDecision;
export declare function moveEvmAccounting(args: {
    name: string;
    chainId: number;
    asset: string;
    amount: string;
    from: EvmAccountingBucket;
    to: EvmAccountingBucket;
}): Promise<EvmCapAccounting | null>;
export declare function reserveEvmCap(args: {
    name: string;
    chainId: number;
    asset: string;
    amount: string;
}): Promise<EvmCapAccounting | null>;
export declare function summarizeEvmWallet(record: EvmWalletRecord): EvmWalletSummary;
export declare function deriveEvmAddress(privBytes: Uint8Array): {
    address: string;
    publicKeyHex: string;
};
export declare function toChecksumAddress(address: string): string;
export declare function isAddress(value: string): boolean;
export declare function bytesToHex(bytes: Uint8Array): string;
export declare function hexToBytes(input: string): Uint8Array;
