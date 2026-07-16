#!/usr/bin/env node
/** Isolated, public-read-only Stele MCP profile. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSteleMcpServer } from "./stele/server.js";

async function main(): Promise<void> {
  const server = createSteleMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  // Never echo configuration, upstream, or credential-bearing error details.
  console.error("lyth-stele-mcp fatal: startup_failed");
  process.exit(1);
});
