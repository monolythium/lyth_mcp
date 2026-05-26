// Travala publishes a hosted MCP server at this URL (see github.com/travala/travel-mcp).
export const DEFAULT_TRAVALA_MCP_URL = "https://travel-mcp.travala.com/mcp";

export function travalaMcpUrl(): string {
  return process.env.LYTH_MCP_TRAVALA_MCP_URL || DEFAULT_TRAVALA_MCP_URL;
}

let RPC_ID_COUNTER = 0;

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

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

async function mcpJsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const id = ++RPC_ID_COUNTER;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Travala MCP HTTP ${res.status}: ${text.slice(0, 400)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? parseSsePayload<T>(text)
      : (JSON.parse(text) as JsonRpcEnvelope<T>);

    if (payload.error) {
      const err = new Error(`Travala MCP ${method} error: ${payload.error.message}`) as Error & {
        data?: unknown;
      };
      err.data = payload.error.data;
      throw err;
    }
    if (payload.result === undefined) {
      throw new Error(`Travala MCP ${method} returned no result`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function parseSsePayload<T>(text: string): JsonRpcEnvelope<T> {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (lines.length === 0) {
    throw new Error("empty SSE response from Travala MCP");
  }
  return JSON.parse(lines[lines.length - 1]!.slice(5).trim()) as JsonRpcEnvelope<T>;
}

export async function travalaCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  return mcpJsonRpc<McpToolCallResult>(travalaMcpUrl(), "tools/call", {
    name,
    arguments: args,
  });
}

export async function travalaBookStatus(args: {
  packageId: string;
  sessionId: string;
}): Promise<McpToolCallResult> {
  return travalaCallTool("travala_book_status", args);
}

export async function travalaProxyCall(args: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<McpToolCallResult> {
  return travalaCallTool(args.tool, args.args);
}

export interface TravalaToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export async function travalaListTools(): Promise<TravalaToolListEntry[]> {
  const result = await mcpJsonRpc<{ tools: TravalaToolListEntry[] }>(
    travalaMcpUrl(),
    "tools/list",
    {},
  );
  return Array.isArray(result.tools) ? result.tools : [];
}
