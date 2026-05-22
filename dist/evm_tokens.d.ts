export interface EvmTokenRecord {
    symbol: string;
    name: string;
    chainId: number;
    address: string;
    decimals: number;
    issuer: string;
    native?: boolean;
    notes?: string;
}
export declare function listEvmTokens(chainId?: number): EvmTokenRecord[];
export declare function findEvmToken(chainId: number, symbol: string): EvmTokenRecord | null;
export declare function requireEvmToken(chainId: number, symbol: string): EvmTokenRecord;
