import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolve } from "node:path";

import { dedicatedAgentWalletStatus } from "../../dist/stele/agent-keystore.js";
import { redactSteleText, redactSteleValue } from "../../dist/stele/privacy.js";
import {
  STELE_TOOL_NAMES,
  assertSteleToolAllowlist,
  createSteleMcpServer,
  runSteleTool,
  steleToolDescriptors,
} from "../../dist/stele/server.js";
import { sdkNetworkIdentity } from "../../dist/stele/network-identity.js";

const identity = sdkNetworkIdentity();
const verified = {
  ok: true,
  code: "identity_verified",
  identity,
  operator: { verified: true },
  meta: {
    stage: "data-auth",
    network: "testnet",
    walletAuthEnabled: true,
    oauthEnabled: true,
    economicWritesEnabled: false,
    hostedSigningEnabled: false,
  },
};
const mismatch = {
  ok: false,
  code: "network_identity_mismatch",
  reason: "operator_regenesis",
  expected: identity,
};

function dependencies({ identityResult = verified, searchServices } = {}) {
  return {
    identity: { async verify() { return identityResult; } },
    api: {
      async getMeta() { throw new Error("not used"); },
      async searchServices(input) {
        if (searchServices) return searchServices(input);
        return { items: [] };
      },
    },
  };
}

test("the standalone profile has an exact three-tool, read-only snapshot", () => {
  assert.deepEqual(STELE_TOOL_NAMES, [
    "stele_connection_status",
    "stele_search_services",
    "stele_agent_wallet_status",
  ]);
  assert.deepEqual(
    steleToolDescriptors.map(({ name, readOnly, economicExecution }) => ({
      name,
      readOnly,
      economicExecution,
    })),
    STELE_TOOL_NAMES.map((name) => ({ name, readOnly: true, economicExecution: "unavailable" })),
  );
  assert.doesNotThrow(() => assertSteleToolAllowlist(STELE_TOOL_NAMES));
  assert.throws(() => assertSteleToolAllowlist([...STELE_TOOL_NAMES, "wallet_import"]));
  assert.throws(() => assertSteleToolAllowlist(["stele_search_services"]));
});

test("an MCP client sees exactly the allowlisted tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createSteleMcpServer(dependencies());
  const client = new Client({ name: "stele-profile-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), STELE_TOOL_NAMES);
    for (const tool of listed.tools) {
      assert.deepEqual(
        {
          readOnlyHint: tool.annotations?.readOnlyHint,
          destructiveHint: tool.annotations?.destructiveHint,
          idempotentHint: tool.annotations?.idempotentHint,
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      );
    }
    const walletStatus = await client.callTool({
      name: "stele_agent_wallet_status",
      arguments: {},
    });
    assert.equal(walletStatus.isError, undefined);
    assert.equal(walletStatus.content[0].type, "text");
    assert.equal(JSON.parse(walletStatus.content[0].text).wallet.state, "not_configured");

    const secret = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const rejectedInput = await client.callTool({
      name: "stele_search_services",
      arguments: { limit: 10, mnemonic: secret },
    });
    assert.equal(rejectedInput.isError, true);
    assert.equal(JSON.stringify(rejectedInput).includes(secret), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the built executable advertises exactly three tools over real stdio", async () => {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/stele_index.js")],
    cwd: root,
    env: { NODE_NO_WARNINGS: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stele-stdio-regression", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), STELE_TOOL_NAMES);
  } finally {
    await client.close();
  }
});

test("connection status reports identity and the permanent foundation execution gate", async () => {
  const result = await runSteleTool("stele_connection_status", {}, dependencies());
  assert.equal(result.isError, false);
  assert.equal(result.output.identity.ok, true);
  assert.equal(result.output.execution.code, "capability_unavailable");
  assert.equal(result.output.execution.signing, "disabled");
  assert.equal(result.output.execution.submission, "disabled");
});

test("network mismatch blocks search before any API catalog read", async () => {
  let searchCalls = 0;
  const result = await runSteleTool(
    "stele_search_services",
    { query: "contract", limit: 10 },
    dependencies({
      identityResult: mismatch,
      searchServices: async () => {
        searchCalls += 1;
        return { items: [] };
      },
    }),
  );
  assert.deepEqual(result, {
    isError: true,
    output: { code: "network_identity_mismatch" },
  });
  assert.equal(searchCalls, 0);
});

test("strict tool input and output schemas prevent secret smuggling", async () => {
  const mnemonic = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const invalid = await runSteleTool(
    "stele_search_services",
    { query: "contract", limit: 10, mnemonic },
    dependencies(),
  );
  assert.deepEqual(invalid, { isError: true, output: { code: "invalid_request" } });
  assert.equal(JSON.stringify(invalid).includes(mnemonic), false);

  const secretFromApi = "upstream-bearer-secret";
  const unsafeOutput = await runSteleTool(
    "stele_search_services",
    { limit: 10 },
    dependencies({
      searchServices: async () => ({
        items: [
          {
            id: "018f1f7a-7b1c-7a2d-8e3f-123456789abc",
            slug: "contract-review",
            title: "Contract review",
            providerDisplayName: "mono1qqqqqqqq",
            category: "legal",
            workflowKind: "project",
            publicUrl:
              "https://stele.monolythium.com/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review",
            secret: secretFromApi,
          },
        ],
      }),
    }),
  );
  assert.deepEqual(unsafeOutput, { isError: true, output: { code: "stele_unavailable" } });
  assert.equal(JSON.stringify(unsafeOutput).includes(secretFromApi), false);
});

test("dedicated wallet status is static, separate, and contains no key lifecycle or address", async () => {
  let identityCalls = 0;
  let apiCalls = 0;
  const result = await runSteleTool("stele_agent_wallet_status", {}, {
    identity: { async verify() { identityCalls += 1; return verified; } },
    api: {
      async getMeta() { apiCalls += 1; throw new Error("forbidden"); },
      async searchServices() { apiCalls += 1; throw new Error("forbidden"); },
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.output.wallet, dedicatedAgentWalletStatus());
  assert.equal(result.output.wallet.state, "not_configured");
  assert.equal(result.output.wallet.address, null);
  assert.equal(result.output.wallet.keyStorage, "os_credential_store_required");
  assert.equal(result.output.wallet.import, "forbidden");
  assert.equal(result.output.wallet.export, "forbidden");
  assert.deepEqual({ identityCalls, apiCalls }, { identityCalls: 0, apiCalls: 0 });
});

test("diagnostic redaction removes credential fields, URL credentials, auth values, and query secrets", () => {
  const redacted = redactSteleValue({
    token: "top-secret",
    nested: { mnemonic: "twelve secret words", safe: "public" },
    url: "https://alice:hunter2@example.com/path?token=abc123",
    authorization: "Bearer abc.def.ghi",
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of ["top-secret", "twelve secret words", "alice", "hunter2", "abc123", "abc.def.ghi"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("public"), true);
  assert.equal(redactSteleText("Bearer abc123"), "[REDACTED]");
});

test("the standalone server module graph does not import the legacy wallet or submission modules", async () => {
  const source = await readFile(new URL("../../dist/stele/server.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.equal(imports.some((specifier) => /(?:^|\/)wallet\.js$/u.test(specifier)), false);
  assert.equal(imports.some((specifier) => /(?:submission|outbox|connectors)/u.test(specifier)), false);
  for (const forbiddenTool of ["wallet_import", "wallet_export", "wallet_sign", "tx_submit"]) {
    assert.equal(source.includes(forbiddenTool), false);
  }
});
