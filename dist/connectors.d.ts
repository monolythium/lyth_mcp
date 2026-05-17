export type ConnectorAuthMode = "none" | "bearer" | "header" | "hmac_sha256";
export type ConnectorMethod = "POST" | "PUT";
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
export interface ConnectorRecord {
    id: string;
    kind: "webhook";
    enabled: boolean;
    displayName?: string;
    vendorId?: string;
    endpoint: string;
    method: ConnectorMethod;
    auth: {
        mode: ConnectorAuthMode;
        headerName?: string;
        scheme?: string;
        encryptedSecret?: EncryptedPayload;
    };
    createdAt: string;
    updatedAt: string;
}
export interface ConnectorSummary {
    id: string;
    kind: ConnectorRecord["kind"];
    enabled: boolean;
    displayName?: string;
    vendorId?: string;
    endpoint: string;
    method: ConnectorMethod;
    auth: {
        mode: ConnectorAuthMode;
        headerName?: string;
        scheme?: string;
        secretConfigured: boolean;
    };
    createdAt: string;
    updatedAt: string;
}
export interface ConnectorStore {
    schemaVersion: 1;
    connectors: ConnectorRecord[];
}
export interface ConnectorPatch {
    id?: string;
    vendorId?: string;
    displayName?: string;
    endpoint: string;
    method?: ConnectorMethod;
    enabled?: boolean;
    authMode?: ConnectorAuthMode;
    headerName?: string;
    scheme?: string;
    secret?: string;
}
export declare function connectorStorePath(): string;
export declare function connectorKeyPath(): string;
export declare function readConnectorStore(path?: string): Promise<ConnectorStore>;
export declare function writeConnectorStore(store: ConnectorStore, path?: string): Promise<void>;
export declare function connectorStoreInfo(path?: string): Promise<{
    path: string;
    connectorCount: number;
    fileMode: string | null;
}>;
export declare function upsertConnector(patch: ConnectorPatch): Promise<ConnectorRecord>;
export declare function getConnector(id: string): Promise<ConnectorRecord>;
export declare function listConnectors(args?: {
    vendorId?: string;
    enabledOnly?: boolean;
    limit?: number;
}): Promise<ConnectorSummary[]>;
export declare function removeConnector(id: string): Promise<{
    removed: boolean;
    id: string;
}>;
export declare function resolveConnector(args: {
    connectorId?: string;
    vendorId?: string;
}): Promise<ConnectorRecord>;
export declare function redactConnector(connector: ConnectorRecord): ConnectorSummary;
export declare function buildConnectorHeaders(connector: ConnectorRecord, body: string): Promise<Record<string, string>>;
export declare function connectorPayloadHash(body: string): string;
