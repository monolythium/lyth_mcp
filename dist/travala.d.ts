import { type X402PaymentRequiredBody, type X402PayResult, type X402VendorPolicy } from "./x402.js";
import type { EvmWalletRecord } from "./evm_wallet.js";
export declare const DEFAULT_TRAVALA_MCP_URL = "https://travel-mcp.travala.com/mcp";
export declare function travalaMcpUrl(): string;
export interface McpToolCallResultContent {
    type: string;
    text?: string;
    data?: unknown;
}
export interface McpToolCallResult {
    content?: McpToolCallResultContent[];
    isError?: boolean;
    structuredContent?: unknown;
}
export declare function travalaCallTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
export interface ExtractedX402 {
    paymentRequired?: X402PaymentRequiredBody;
    paymentUrl?: string;
    bookingId?: string;
    status?: string;
    rawText?: string;
}
export declare function extractX402FromToolResult(result: McpToolCallResult): ExtractedX402;
export interface TravalaBookPayArgs {
    packageId: string;
    sessionId: string;
    customer: {
        firstName: string;
        lastName: string;
        email: string;
        phone: string;
    };
    agentId?: string;
    rewardWallet?: string;
    wallet: EvmWalletRecord;
    policy: X402VendorPolicy;
    passphrase?: string;
    dryRun?: boolean;
}
export interface TravalaBookPayResult {
    bookTool: {
        tool: "travala_book";
        args: Record<string, unknown>;
        result: McpToolCallResult;
        extracted: ExtractedX402;
    };
    paid?: X402PayResult;
    finalBooking?: McpToolCallResult;
    bookingId?: string;
    warning?: string;
}
export declare function travalaBookPay(args: TravalaBookPayArgs): Promise<TravalaBookPayResult>;
export declare function travalaBookStatus(args: {
    packageId: string;
    sessionId: string;
}): Promise<McpToolCallResult>;
export declare function travalaProxyCall(args: {
    tool: string;
    args: Record<string, unknown>;
}): Promise<McpToolCallResult>;
