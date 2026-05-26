export type OutboxStatus = "signed" | "submitted" | "confirmed" | "failed" | "expired";
export type OutboxKind = "lyth_encrypted";
export interface OutboxAttempt {
    at: string;
    endpoint: string;
    method: string;
    ok: boolean;
    txHash?: string;
    error?: string;
}
export interface TxOutboxEntry {
    id: string;
    status: OutboxStatus;
    network: string;
    chainId: number;
    kind: OutboxKind;
    method: string;
    payloadHex: string;
    payloadHash: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    walletName?: string;
    from?: string;
    to?: string;
    amount?: string;
    asset?: string;
    nonce?: string;
    runbookId?: string;
    policySnapshot?: unknown;
    lowValueReserved?: boolean;
    txHash?: string;
    attempts: OutboxAttempt[];
    note?: string;
}
export interface TxOutboxStore {
    schemaVersion: 1;
    entries: TxOutboxEntry[];
}
export declare function outboxPath(): string;
export declare function readOutbox(path?: string): Promise<TxOutboxStore>;
export declare function writeOutbox(store: TxOutboxStore, path?: string): Promise<void>;
export declare function outboxInfo(path?: string): Promise<{
    path: string;
    entryCount: number;
    fileMode: string | null;
}>;
export declare function addOutboxEntry(args: Omit<TxOutboxEntry, "id" | "payloadHash" | "createdAt" | "updatedAt" | "attempts" | "status"> & {
    id?: string;
    status?: OutboxStatus;
    attempts?: OutboxAttempt[];
}): Promise<TxOutboxEntry>;
export declare function listOutboxEntries(args?: {
    status?: OutboxStatus;
    walletName?: string;
    limit?: number;
}): Promise<TxOutboxEntry[]>;
export declare function getOutboxEntry(id: string): Promise<TxOutboxEntry>;
export declare function recordOutboxAttempt(id: string, attempt: OutboxAttempt): Promise<TxOutboxEntry>;
export declare function updateOutboxStatus(id: string, status: OutboxStatus, txHash?: string): Promise<TxOutboxEntry>;
export declare function forgetOutboxEntry(id: string): Promise<{
    removed: boolean;
    path: string;
}>;
