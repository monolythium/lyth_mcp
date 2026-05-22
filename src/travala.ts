import { x402Pay, type X402PaymentRequiredBody, type X402PayResult, type X402VendorPolicy } from "./x402.js";
import type { EvmWalletRecord } from "./evm_wallet.js";

// Travala publishes a hosted MCP server at this URL (see github.com/travala/travel-mcp).
export const DEFAULT_TRAVALA_MCP_URL = "https://travel-mcp.travala.com/mcp";

export function travalaMcpUrl(): string {
  return process.env.LYTH_MCP_TRAVALA_MCP_URL || DEFAULT_TRAVALA_MCP_URL;
}

// -----------------------------------------------------------------------------
// Minimal MCP-over-HTTP JSON-RPC client (streamable HTTP transport, JSON path).
// -----------------------------------------------------------------------------

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

async function mcpJsonRpc<T>(url: string, method: string, params: unknown, timeoutMs = 20000): Promise<T> {
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
    if (!res.ok && res.status !== 402) {
      throw new Error(`Travala MCP HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    // Streamable HTTP can return SSE — extract last "data:" line if so.
    const ct = res.headers.get("content-type") ?? "";
    let payload: JsonRpcEnvelope<T>;
    if (ct.includes("text/event-stream")) {
      const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
      if (lines.length === 0) throw new Error("empty SSE response from Travala MCP");
      payload = JSON.parse(lines[lines.length - 1]!.slice(5).trim()) as JsonRpcEnvelope<T>;
    } else {
      payload = JSON.parse(text) as JsonRpcEnvelope<T>;
    }
    if (payload.error) {
      const err = new Error(`Travala MCP ${method} error: ${payload.error.message}`) as Error & { data?: unknown };
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

export async function travalaCallTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
  return mcpJsonRpc<McpToolCallResult>(travalaMcpUrl(), "tools/call", { name, arguments: args });
}

// -----------------------------------------------------------------------------
// x402 extraction from a Travala MCP tool result.
// -----------------------------------------------------------------------------

export interface ExtractedX402 {
  paymentRequired?: X402PaymentRequiredBody;
  paymentUrl?: string;
  bookingId?: string;
  status?: string;
  rawText?: string;
}

function tryParseJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

function looksLikeX402Body(value: unknown): value is X402PaymentRequiredBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.x402Version === 1 && Array.isArray(v.accepts);
}

// Travala MCP tool results can carry payment instructions in a few shapes
// depending on transport version: as embedded JSON, as a URL to hit, or as a
// structured field. We probe for each.
export function extractX402FromToolResult(result: McpToolCallResult): ExtractedX402 {
  const out: ExtractedX402 = {};
  if (result.structuredContent) {
    const sc = result.structuredContent as Record<string, unknown>;
    if (looksLikeX402Body(sc.paymentRequired)) out.paymentRequired = sc.paymentRequired as X402PaymentRequiredBody;
    if (looksLikeX402Body(sc)) out.paymentRequired = sc;
    if (typeof sc.paymentUrl === "string") out.paymentUrl = sc.paymentUrl;
    if (typeof sc.bookingId === "string") out.bookingId = sc.bookingId;
    if (typeof sc.status === "string") out.status = sc.status;
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (typeof block.text === "string") {
        out.rawText = (out.rawText ?? "") + block.text;
        const parsed = tryParseJson(block.text);
        if (parsed && looksLikeX402Body(parsed)) out.paymentRequired = parsed;
        if (parsed && typeof parsed === "object") {
          const p = parsed as Record<string, unknown>;
          if (looksLikeX402Body(p.paymentRequired)) out.paymentRequired = p.paymentRequired as X402PaymentRequiredBody;
          if (!out.paymentUrl && typeof p.paymentUrl === "string") out.paymentUrl = p.paymentUrl;
          if (!out.bookingId && typeof p.bookingId === "string") out.bookingId = p.bookingId;
          if (!out.status && typeof p.status === "string") out.status = p.status;
        }
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// High-level helpers
// -----------------------------------------------------------------------------

export interface TravalaBookPayArgs {
  packageId: string;
  sessionId: string;
  customer: { firstName: string; lastName: string; email: string; phone: string };
  agentId?: string;
  rewardWallet?: string;
  wallet: EvmWalletRecord;
  policy: X402VendorPolicy;
  passphrase?: string;
  dryRun?: boolean;
}

export interface TravalaBookPayResult {
  bookTool: { tool: "travala_book"; args: Record<string, unknown>; result: McpToolCallResult; extracted: ExtractedX402 };
  paid?: X402PayResult;
  finalBooking?: McpToolCallResult;
  bookingId?: string;
  warning?: string;
}

export async function travalaBookPay(args: TravalaBookPayArgs): Promise<TravalaBookPayResult> {
  const bookArgs: Record<string, unknown> = {
    packageId: args.packageId,
    sessionId: args.sessionId,
    customer: args.customer,
  };
  if (args.agentId) bookArgs.agentId = args.agentId;
  if (args.rewardWallet) bookArgs.rewardWallet = args.rewardWallet;

  const bookResult = await travalaCallTool("travala_book", bookArgs);
  const extracted = extractX402FromToolResult(bookResult);

  // Case A: the tool result is a final confirmation (no payment instructions found).
  if (!extracted.paymentRequired && !extracted.paymentUrl) {
    return {
      bookTool: { tool: "travala_book", args: bookArgs, result: bookResult, extracted },
      bookingId: extracted.bookingId,
      warning: bookResult.isError
        ? "travala_book returned isError=true. Inspect the tool result content."
        : "No x402 payment instructions found in travala_book response. Either the booking already completed or the response shape differs from the known Travala MCP contract — verify against the latest Travala MCP docs.",
    };
  }

  // Case B: x402 body delivered inline. We honor it by reusing x402Pay against a
  // *synthetic* URL not allowed by our policy → fail closed. The current x402Pay
  // requires a real URL to retry; inline 402 bodies aren't directly retriable.
  // The expected production shape is Case C (paymentUrl), so we surface a clear
  // error here rather than fabricating a retry path.
  if (extracted.paymentRequired && !extracted.paymentUrl) {
    return {
      bookTool: { tool: "travala_book", args: bookArgs, result: bookResult, extracted },
      warning:
        "travala_book returned an inline x402 paymentRequirements body without a paymentUrl. x402Pay requires a target URL to retry against. Either point to the URL Travala expects the X-PAYMENT to be sent to, or use the Coinbase agentic-wallet MCP path.",
    };
  }

  // Case C: paymentUrl supplied. Pay via x402.
  const paid = await x402Pay({
    url: extracted.paymentUrl!,
    method: "POST",
    wallet: args.wallet,
    policy: args.policy,
    assetSymbolHint: "USDC",
    passphrase: args.passphrase,
    dryRun: args.dryRun,
  });

  // After x402 payment, optionally re-poll travala_book_status to pick up the
  // confirmed booking record.
  let finalBooking: McpToolCallResult | undefined;
  let bookingId = extracted.bookingId;
  if (paid.ok && !args.dryRun) {
    try {
      const statusResult = await travalaCallTool("travala_book_status", {
        packageId: args.packageId,
        sessionId: args.sessionId,
      });
      finalBooking = statusResult;
      const statusExtracted = extractX402FromToolResult(statusResult);
      bookingId = statusExtracted.bookingId ?? bookingId;
    } catch (err) {
      finalBooking = undefined;
    }
  }

  return {
    bookTool: { tool: "travala_book", args: bookArgs, result: bookResult, extracted },
    paid,
    finalBooking,
    bookingId,
  };
}

export async function travalaBookStatus(args: { packageId: string; sessionId: string }): Promise<McpToolCallResult> {
  return travalaCallTool("travala_book_status", args);
}

export async function travalaProxyCall(args: { tool: string; args: Record<string, unknown> }): Promise<McpToolCallResult> {
  return travalaCallTool(args.tool, args.args);
}
