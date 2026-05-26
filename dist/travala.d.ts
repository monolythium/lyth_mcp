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
export declare function travalaBookStatus(args: {
    packageId: string;
    sessionId: string;
}): Promise<McpToolCallResult>;
export declare function travalaProxyCall(args: {
    tool: string;
    args: Record<string, unknown>;
}): Promise<McpToolCallResult>;
export interface TravalaToolListEntry {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
export declare function travalaListTools(): Promise<TravalaToolListEntry[]>;
