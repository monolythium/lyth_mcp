import { MlDsa65Backend, type EncryptionKey, type NativeEvmTxFields } from "@monolythium/core-sdk/crypto";
export interface WalletRecord {
    name: string;
    address: string;
    publicKey: string;
    algorithm: "PQM1-MLDSA65";
    keyProtection?: "passphrase" | "local_machine_key";
    createdAt: string;
    encryptedMnemonic: EncryptedPayload;
    lowValue?: LowValuePolicy;
}
export interface WalletStore {
    schemaVersion: 1;
    wallets: WalletRecord[];
}
export interface LowValuePolicy {
    enabled: boolean;
    asset: "LYTH";
    maxAmount: string;
    dailyLimit?: string;
    day?: string;
    spentToday?: string;
    configuredAt: string;
    encryptedMnemonic: EncryptedPayload;
}
export interface EncryptedPayload {
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
export interface WalletSummary {
    name: string;
    address: string;
    publicKey: string;
    algorithm: WalletRecord["algorithm"];
    keyProtection: "passphrase" | "local_machine_key";
    createdAt: string;
    lowValue?: Omit<LowValuePolicy, "encryptedMnemonic">;
}
export interface BuiltTransfer {
    wallet: WalletSummary;
    tx: NativeEvmTxFields;
    walletRequest: {
        method: "eth_sendTransaction";
        params: Array<{
            from: string;
            to: string;
            value: string;
            data: string;
            gas: string;
            nonce: string;
            chainId: string;
            maxFeePerGas: string;
            maxPriorityFeePerGas: string;
        }>;
    };
    signed?: {
        mode: "passphrase" | "low_value";
        signedInnerTxHex: string;
        innerSighashHex: string;
        innerWireBytes: number;
        encryptedEnvelopeHex: string;
    };
    lowValuePolicy?: {
        used: boolean;
        remainingToday?: string;
        warning?: string;
    };
}
export declare function walletStorePath(): string;
export declare function hotKeyPath(): string;
export declare function localKeyPath(): string;
export declare function resolvePassphrase(passphrase?: string): string;
export declare function readWalletStore(path?: string): Promise<WalletStore>;
export declare function writeWalletStore(store: WalletStore, path?: string): Promise<void>;
export declare function walletStoreInfo(path?: string): Promise<{
    path: string;
    walletCount: number;
    wallets: WalletSummary[];
    hotKeyPath: string;
    localKeyPath: string;
    fileMode: string | null;
}>;
export declare function createWallet(args: {
    name: string;
    passphrase?: string;
    revealMnemonic?: boolean;
    overwrite?: boolean;
    allowLocalKey?: boolean;
    lowValue?: {
        enabled: boolean;
        maxAmount: string;
        dailyLimit?: string;
    };
}): Promise<WalletSummary & {
    mnemonic?: string;
    storePath: string;
}>;
export declare function importWallet(args: {
    name: string;
    mnemonic: string;
    passphrase?: string;
    overwrite?: boolean;
    allowLocalKey?: boolean;
    lowValue?: {
        enabled: boolean;
        maxAmount: string;
        dailyLimit?: string;
    };
}): Promise<WalletSummary & {
    storePath: string;
}>;
export declare function listWallets(): Promise<WalletSummary[]>;
export declare function getWallet(name: string): Promise<WalletRecord>;
export declare function exportMnemonic(name: string, passphrase?: string): Promise<string>;
export declare function configureLowValuePolicy(args: {
    name: string;
    passphrase?: string;
    enabled: boolean;
    maxAmount?: string;
    dailyLimit?: string;
}): Promise<WalletSummary>;
export declare function deleteWallet(name: string, confirmName: string): Promise<{
    deleted: boolean;
    storePath: string;
}>;
export declare function removeWalletStoreForTestsOnly(path: string): Promise<void>;
export declare function unlockBackend(name: string, passphrase?: string): Promise<MlDsa65Backend>;
export declare function buildTransfer(args: {
    walletName: string;
    to: string;
    amountUnits: bigint;
    chainId: number;
    nonce: bigint;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    input?: string;
    passphrase?: string;
    encryptionKey?: EncryptionKey;
    sign?: boolean;
    allowLowValueSigning?: boolean;
}): Promise<BuiltTransfer>;
export declare function summarizeWallet(record: WalletRecord): WalletSummary;
export declare function toQuantity(value: bigint): string;
export declare function encryptionKeyFromRpc(result: {
    algo?: string;
    epoch: number | string;
    encapsulationKey: string;
}): EncryptionKey;
