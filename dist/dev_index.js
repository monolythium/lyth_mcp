#!/usr/bin/env node
/**
 * lyth-dev-mcp — native developer MCP profile.
 *
 * This entry point deliberately registers only native project, artifact,
 * asset-plan, verification, and wallet-approval tools. Economic actions are
 * plan-only until the desktop wallet approval drawer accepts them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertNativeDevProfileOnly, nativeDevReadiness, nativeDevToolDescriptors, registerNativeDevTools, } from "./native_dev.js";
const server = new McpServer({
    name: "lyth-dev-mcp",
    version: "0.1.0",
});
assertNativeDevProfileOnly(nativeDevToolDescriptors.map((tool) => tool.name));
server.tool("native_dev_profile", "Describe the native developer MCP profile and wallet approval boundary.", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(nativeDevReadiness(), null, 2) }],
}));
registerNativeDevTools(server);
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("lyth-dev-mcp fatal:", err);
    process.exit(1);
});
