import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname, resolve } from "node:path";

import {
  configuredLockedAgentWalletStatus,
  notConfiguredAgentWalletStatus,
} from "../../dist/stele/agent-keystore.js";
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
    providerDraftsEnabled: true,
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

function dependencies({ identityResult = verified, searchServices, walletStatus } = {}) {
  return {
    identity: { async verify() { return identityResult; } },
    walletStatus: walletStatus ?? {
      async readStatus() { return notConfiguredAgentWalletStatus(); },
    },
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

test("dedicated wallet status reads only injected public lifecycle state", async () => {
  let identityCalls = 0;
  let apiCalls = 0;
  let statusCalls = 0;
  const expected = configuredLockedAgentWalletStatus(
    "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u",
    1,
  );
  const result = await runSteleTool("stele_agent_wallet_status", {}, {
    identity: { async verify() { identityCalls += 1; return verified; } },
    walletStatus: {
      async readStatus() {
        statusCalls += 1;
        return expected;
      },
    },
    api: {
      async getMeta() { apiCalls += 1; throw new Error("forbidden"); },
      async searchServices() { apiCalls += 1; throw new Error("forbidden"); },
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.output.wallet, expected);
  assert.equal(result.output.wallet.state, "configured_locked");
  assert.equal(result.output.wallet.address, expected.address);
  assert.equal(result.output.wallet.keyStorage, "os_credential_store");
  assert.equal(result.output.wallet.import, "forbidden");
  assert.equal(result.output.wallet.export, "forbidden");
  assert.deepEqual({ identityCalls, apiCalls, statusCalls }, { identityCalls: 0, apiCalls: 0, statusCalls: 1 });
});

test("wallet lifecycle failures collapse to one safe unavailable response", async () => {
  const sentinel = "native-keyring-secret-error";
  const result = await runSteleTool(
    "stele_agent_wallet_status",
    {},
    dependencies({
      walletStatus: {
        async readStatus() { throw new Error(sentinel); },
      },
    }),
  );
  assert.deepEqual(result, { isError: true, output: { code: "stele_unavailable" } });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("wallet status rejects extra secret fields and malformed public identity", async () => {
  const sentinel = "SENTINEL_PRIVATE_SEED";
  const canonical = configuredLockedAgentWalletStatus(
    "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u",
    1,
  );
  for (const unsafe of [
    { ...canonical, seed: sentinel },
    { ...canonical, address: "mono1notcanonical" },
    { ...canonical, generation: 0 },
    { ...canonical, execution: { ...canonical.execution, submission: "enabled" } },
  ]) {
    const result = await runSteleTool(
      "stele_agent_wallet_status",
      {},
      dependencies({ walletStatus: { async readStatus() { return unsafe; } } }),
    );
    assert.deepEqual(result, { isError: true, output: { code: "stele_unavailable" } });
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
});

test("diagnostic redaction removes credential fields, URL credentials, auth values, and query secrets", () => {
  const redacted = redactSteleValue({
    token: "top-secret",
    nested: { mnemonic: "twelve secret words", safe: "public" },
    url: "https://alice:hunter2@example.com/path?token=abc123",
    authorization: "Bearer abc.def.ghi",
    accessToken: "oauth-access-secret",
    refresh_token: "oauth-refresh-secret",
    clientId: "oauth-client-identifier",
    callback: "http://127.0.0.1:1234/callback/private",
    callbackUrl: "http://127.0.0.1:1234/callback/private-url",
    code: "oauth-authorization-code",
    state: "oauth-state-secret",
    verifier: "oauth-verifier-short-key",
    challenge: "oauth-challenge-secret",
    codeVerifier: "oauth-verifier-secret",
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of ["top-secret", "twelve secret words", "alice", "hunter2", "abc123", "abc.def.ghi", "oauth-access-secret", "oauth-refresh-secret", "oauth-client-identifier", "callback/private", "private-url", "oauth-authorization-code", "oauth-state-secret", "oauth-verifier-short-key", "oauth-challenge-secret", "oauth-verifier-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("public"), true);
  assert.equal(redactSteleText("Bearer abc123"), "[REDACTED]");
  const oauthUrl = redactSteleText("https://stele.monolythium.com/oauth/authorize?client_id=private&state=private-state&code_challenge=private-challenge");
  assert.equal(oauthUrl.includes("private"), false);
  const callbackId = "Z".repeat(43);
  assert.equal(
    redactSteleText(`callback http://127.0.0.1:39147/callback/${callbackId}?code=private path /callback/${callbackId}`).includes(callbackId),
    false,
  );
});

test("the standalone server module graph does not import the legacy wallet or submission modules", async () => {
  const entry = resolve(new URL("../../dist/stele/server.js", import.meta.url).pathname);
  const source = await readFile(entry, "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.equal(imports.some((specifier) => /(?:^|\/)wallet\.js$/u.test(specifier)), false);
  assert.equal(imports.some((specifier) => /(?:submission|outbox|connectors)/u.test(specifier)), false);
  for (const forbiddenTool of ["wallet_import", "wallet_export", "wallet_sign", "tx_submit"]) {
    assert.equal(source.includes(forbiddenTool), false);
  }

  const graph = await localModuleGraph(entry);
  for (const forbiddenModule of [
    "agent-wallet-admin.js",
    "os-credential-store.js",
    "wallet-cli.js",
    "wallet.js",
    "outbox.js",
    "connectors.js",
  ]) {
    assert.equal(
      [...graph].some((path) => path.endsWith(`/${forbiddenModule}`)),
      false,
      `Stele MCP graph reaches ${forbiddenModule}`,
    );
  }
});

async function localModuleGraph(entry) {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/gu)) {
      if (match[1].startsWith(".")) pending.push(resolve(dirname(file), match[1]));
    }
  }
  return visited;
}
