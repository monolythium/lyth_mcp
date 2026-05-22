import type { X402VendorPolicy } from "./x402.js";
export interface X402PolicyStore {
    schemaVersion: 1;
    policies: X402VendorPolicy[];
}
export interface X402AgentIdentityConfig {
    agentId?: string;
    rewardWallet?: string;
    updatedAt?: string;
}
export declare function x402StorePath(): string;
export declare function readX402Store(path?: string): Promise<X402PolicyStore>;
export declare function writeX402Store(store: X402PolicyStore, path?: string): Promise<void>;
export declare function upsertX402Policy(policy: X402VendorPolicy): Promise<X402VendorPolicy>;
export declare function getX402Policy(vendorId: string): Promise<X402VendorPolicy>;
export declare function listX402Policies(): Promise<X402VendorPolicy[]>;
export declare function removeX402Policy(vendorId: string): Promise<{
    removed: boolean;
    path: string;
}>;
export declare function agentIdentityPath(): string;
export declare function readAgentIdentity(): Promise<X402AgentIdentityConfig>;
export declare function writeAgentIdentity(config: X402AgentIdentityConfig): Promise<X402AgentIdentityConfig>;
export declare const X402_AGENT_KEY = "__agent_identity__";
