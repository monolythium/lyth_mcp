import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SteleApiBoundaryError,
  SteleServiceSearchInputSchema,
  SteleServiceSearchPageOutputSchema,
  steleApiClientFromEnvironment,
  type SteleApiReader,
} from "./api-client.js";
import { dedicatedAgentWalletStatus } from "./agent-keystore.js";
import { steleExecutionGate } from "./execution-gate.js";
import {
  SteleNetworkIdentityGuard,
  sdkNetworkIdentity,
  type SteleNetworkIdentityResult,
} from "./network-identity.js";
import { safeSteleError } from "./privacy.js";

export const STELE_TOOL_NAMES = [
  "stele_connection_status",
  "stele_search_services",
  "stele_agent_wallet_status",
] as const;

export type SteleToolName = (typeof STELE_TOOL_NAMES)[number];

export interface SteleToolDescriptor {
  readonly name: SteleToolName;
  readonly description: string;
  readonly readOnly: true;
  readonly economicExecution: "unavailable";
}

export const steleToolDescriptors: readonly SteleToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: "stele_connection_status",
    description: "Verify SDK, trusted operator, and Stele API chain identity without signing.",
    readOnly: true,
    economicExecution: "unavailable",
  }),
  Object.freeze({
    name: "stele_search_services",
    description: "Search public Stele service listings after a fresh network-identity check.",
    readOnly: true,
    economicExecution: "unavailable",
  }),
  Object.freeze({
    name: "stele_agent_wallet_status",
    description: "Report the fail-closed dedicated Stele agent-wallet scaffold; no key is opened.",
    readOnly: true,
    economicExecution: "unavailable",
  }),
]);

const EmptyInputSchema = z.object({}).strict();

export interface SteleIdentityVerifier {
  verify(): Promise<SteleNetworkIdentityResult>;
}

export interface SteleProfileDependencies {
  readonly api: SteleApiReader;
  readonly identity: SteleIdentityVerifier;
}

export interface SteleToolRunResult {
  readonly isError: boolean;
  readonly output: unknown;
}

export function defaultSteleProfileDependencies(): SteleProfileDependencies {
  const api = steleApiClientFromEnvironment();
  return { api, identity: new SteleNetworkIdentityGuard(api) };
}

export function createSteleMcpServer(
  dependencies: SteleProfileDependencies = defaultSteleProfileDependencies(),
): McpServer {
  assertSteleToolAllowlist(steleToolDescriptors.map((descriptor) => descriptor.name));
  const server = new McpServer({ name: "lyth-stele-mcp", version: "0.1.0" });

  server.registerTool(
    "stele_connection_status",
    {
      title: "Stele connection status",
      description: steleToolDescriptors[0]!.description,
      inputSchema: EmptyInputSchema,
      annotations: readOnlyAnnotations(true),
    },
    async (input) => mcpResult(await runSteleTool("stele_connection_status", input, dependencies)),
  );
  server.registerTool(
    "stele_search_services",
    {
      title: "Search Stele services",
      description: steleToolDescriptors[1]!.description,
      inputSchema: SteleServiceSearchInputSchema,
      annotations: readOnlyAnnotations(true),
    },
    async (input) => mcpResult(await runSteleTool("stele_search_services", input, dependencies)),
  );
  server.registerTool(
    "stele_agent_wallet_status",
    {
      title: "Stele dedicated agent-wallet status",
      description: steleToolDescriptors[2]!.description,
      inputSchema: EmptyInputSchema,
      annotations: readOnlyAnnotations(false),
    },
    async (input) => mcpResult(await runSteleTool("stele_agent_wallet_status", input, dependencies)),
  );

  return server;
}

export async function runSteleTool(
  name: SteleToolName,
  input: unknown,
  dependencies: SteleProfileDependencies,
): Promise<SteleToolRunResult> {
  if (name === "stele_agent_wallet_status") {
    if (!EmptyInputSchema.safeParse(input).success) return invalidRequest();
    return {
      isError: false,
      output: {
        profile: "lyth-stele-mcp",
        wallet: dedicatedAgentWalletStatus(),
      },
    };
  }

  if (name === "stele_connection_status") {
    if (!EmptyInputSchema.safeParse(input).success) return invalidRequest();
    const identity = await safeIdentityCheck(dependencies.identity);
    return {
      isError: false,
      output: {
        profile: "lyth-stele-mcp",
        toolCount: STELE_TOOL_NAMES.length,
        identity,
        execution: steleExecutionGate(),
      },
    };
  }

  const parsedInput = SteleServiceSearchInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidRequest();
  const identity = await safeIdentityCheck(dependencies.identity);
  if (!identity.ok) {
    return { isError: true, output: safeSteleError("network_identity_mismatch") };
  }

  try {
    const page = await dependencies.api.searchServices(parsedInput.data);
    const parsedPage = SteleServiceSearchPageOutputSchema.safeParse(page);
    if (!parsedPage.success) throw new SteleApiBoundaryError();
    return {
      isError: false,
      output: {
        services: parsedPage.data.items,
        ...(parsedPage.data.nextCursor === undefined
          ? {}
          : { nextCursor: parsedPage.data.nextCursor }),
      },
    };
  } catch {
    return { isError: true, output: safeSteleError("stele_unavailable") };
  }
}

export function assertSteleToolAllowlist(toolNames: readonly string[]): void {
  if (
    toolNames.length !== STELE_TOOL_NAMES.length ||
    new Set(toolNames).size !== STELE_TOOL_NAMES.length ||
    STELE_TOOL_NAMES.some((name) => !toolNames.includes(name))
  ) {
    throw new Error("Stele MCP tool allowlist mismatch");
  }
}

async function safeIdentityCheck(identity: SteleIdentityVerifier): Promise<SteleNetworkIdentityResult> {
  try {
    return await identity.verify();
  } catch {
    return {
      ok: false,
      code: "network_identity_mismatch",
      reason: "operator_unreachable",
      expected: sdkNetworkIdentity(),
    };
  }
}

function invalidRequest(): SteleToolRunResult {
  return { isError: true, output: safeSteleError("invalid_request") };
}

function mcpResult(result: SteleToolRunResult) {
  return {
    ...(result.isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(result.output) }],
  };
}

function readOnlyAnnotations(openWorld: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
  } as const;
}
