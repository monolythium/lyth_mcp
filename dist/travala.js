// Travala publishes a hosted MCP server at this URL (see github.com/travala/travel-mcp).
export const DEFAULT_TRAVALA_MCP_URL = "https://travel-mcp.travala.com/mcp";
export function travalaMcpUrl() {
    return process.env.LYTH_MCP_TRAVALA_MCP_URL || DEFAULT_TRAVALA_MCP_URL;
}
let RPC_ID_COUNTER = 0;
async function mcpJsonRpc(url, method, params, timeoutMs = 20_000) {
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
            ? parseSsePayload(text)
            : JSON.parse(text);
        if (payload.error) {
            const err = new Error(`Travala MCP ${method} error: ${payload.error.message}`);
            err.data = payload.error.data;
            throw err;
        }
        if (payload.result === undefined) {
            throw new Error(`Travala MCP ${method} returned no result`);
        }
        return payload.result;
    }
    finally {
        clearTimeout(timer);
    }
}
function parseSsePayload(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (lines.length === 0) {
        throw new Error("empty SSE response from Travala MCP");
    }
    return JSON.parse(lines[lines.length - 1].slice(5).trim());
}
export async function travalaCallTool(name, args) {
    return mcpJsonRpc(travalaMcpUrl(), "tools/call", {
        name,
        arguments: args,
    });
}
export async function travalaBookStatus(args) {
    return travalaCallTool("travala_book_status", args);
}
export async function travalaProxyCall(args) {
    return travalaCallTool(args.tool, args.args);
}
export async function travalaListTools() {
    const result = await mcpJsonRpc(travalaMcpUrl(), "tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
}
