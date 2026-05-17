#!/usr/bin/env node
/**
 * lyth-mcp — Monolythium MCP server.
 *
 * The server is intentionally wallet-safe:
 * - reads live Monolythium RPC/API data;
 * - drafts and validates AI runbooks;
 * - prepares wallet approval payloads;
 * - stores local MCP wallets only as encrypted PQM-1 mnemonics;
 * - never broadcasts unless LYTH_MCP_ENABLE_SUBMIT=1 is explicitly set.
 */
export {};
