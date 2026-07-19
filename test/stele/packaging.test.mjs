import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const steleRuntimeModules = [
  "dist/stele_index.js",
  "dist/stele_wallet_index.js",
  "dist/stele/agent-keystore.js",
  "dist/stele/agent-wallet-admin.js",
  "dist/stele/api-client.js",
  "dist/stele/execution-gate.js",
  "dist/stele/network-identity.js",
  "dist/stele/operator-fetch.js",
  "dist/stele/os-credential-store.js",
  "dist/stele/oauth-admin.js",
  "dist/stele/oauth-browser.js",
  "dist/stele/oauth-cli.js",
  "dist/stele/oauth-contract.js",
  "dist/stele/oauth-credential-store.js",
  "dist/stele/oauth-http.js",
  "dist/stele/oauth-loopback.js",
  "dist/stele/oauth-refresh-lock.js",
  "dist/stele/oauth-runtime-http.js",
  "dist/stele/oauth-session-broker.js",
  "dist/stele/privacy.js",
  "dist/stele/server.js",
  "dist/stele/wallet-cli.js",
  "dist/stele/wallet-state.js",
  "dist/stele_oauth_index.js",
];

test("the public package exact-pins the reviewed SDK release", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(packageJson.dependencies["@monolythium/core-sdk"], "0.6.8");
  assert.equal(packageJson.dependencies["@github/keytar"], "7.10.6");
  assert.equal(lock.packages[""].dependencies["@monolythium/core-sdk"], "0.6.8");
  assert.equal(lock.packages[""].dependencies["@github/keytar"], "7.10.6");
  assert.equal(lock.packages["node_modules/@monolythium/core-sdk"].version, "0.6.8");
  assert.equal(lock.packages["node_modules/@github/keytar"].version, "7.10.6");
  assert.equal(packageJson.version, "0.3.0");
  assert.equal(lock.version, "0.3.0");
  assert.equal(lock.packages[""].version, "0.3.0");
  assert.equal(packageJson.engines.node, ">=22.22.0");
  assert.equal(lock.packages[""].engines.node, ">=22.22.0");
  assert.equal(packageJson.bin["lyth-stele-mcp"], "dist/stele_index.js");
  assert.equal(packageJson.bin["lyth-stele-auth"], "dist/stele_oauth_index.js");
  assert.equal(packageJson.bin["lyth-stele-wallet"], "dist/stele_wallet_index.js");
});

test("public OAuth guidance states registration and compensation boundaries", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  for (const required of [
    "issue time is within 60 seconds",
    "expiry is still strictly in the future",
    "lifetime is no more than 31,536,000 seconds",
    "retain the valid replacement as `reauth_required`",
    "refuses both the original commit and that compensating retention",
  ]) {
    assert.equal(readme.includes(required), true, `README is missing ${required}`);
  }
});

test("local and internal material is ignored at both root and nested paths", async () => {
  const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
  for (const rule of [
    ".local/",
    ".internal/",
    "**/.local/",
    "**/.internal/",
    "docs/internal/",
    "docs/private/",
    "*.internal.*",
    "*_INTERNAL.md",
  ]) {
    assert.equal(ignore.split("\n").includes(rule), true, `missing ignore rule ${rule}`);
  }
});

test("cross-platform native smoke covers the isolated OAuth record lifecycle", async () => {
  const smoke = await readFile(resolve(root, ".github/scripts/native-keyring-smoke.mjs"), "utf8");
  const ci = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  for (const required of [
    "NativeSteleOAuthCredentialStore",
    "createSteleOAuthCredentialRecord",
    "rotateSteleOAuthCredentialRecord",
    "com.monolythium.stele.oauth-session",
    "hosted-mcp-v1:production",
    "oauth.write(first)",
    "oauth.write(replacement)",
    "oauth.delete()",
    "oauthPhysicalAccount",
    "oauthKeytar",
    "logicalService === oauthService && logicalAccount === oauthAccount",
    "keytar.deletePassword(oauthService, oauthPhysicalAccount)",
  ]) {
    assert.equal(smoke.includes(required), true, `native smoke is missing ${required}`);
  }
  assert.doesNotMatch(
    smoke,
    /keytar\.(?:getPassword|setPassword|deletePassword)\(oauthService,\s*oauthAccount\s*[,)]/u,
  );
  assert.equal(smoke.includes("console.log"), false);
  for (const required of [
    "ubuntu-24.04",
    "macos-14",
    "windows-2022",
    "test/stele/oauth-session.test.mjs",
    "node .github/scripts/native-keyring-smoke.mjs",
  ]) {
    assert.equal(ci.includes(required), true, `native matrix is missing ${required}`);
  }
});

test("npm packing exactly matches the reviewed public package allowlist", async () => {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const report = JSON.parse(output)[0];
  const paths = report.files.map((entry) => entry.path);
  const expectedPaths = (await readFile(
    resolve(root, ".github/package-files.allowlist.txt"),
    "utf8",
  ))
    .trim()
    .split("\n");

  assert.deepEqual([...paths].sort(), expectedPaths);
  assert.equal(paths.includes("scripts/smoke.mjs"), false);

  for (const required of [
    "npm-shrinkwrap.json",
    ...steleRuntimeModules,
    ...steleRuntimeModules.map((path) => path.replace(/\.js$/u, ".d.ts")),
  ]) {
    assert.equal(paths.includes(required), true, `packed artifact is missing ${required}`);
  }

  const forbiddenPath = /(?:^|\/)(?:\.local|\.internal|internal|private|secrets?)(?:\/|$)|\.internal\./iu;
  assert.deepEqual(paths.filter((path) => forbiddenPath.test(path)), []);
  assert.equal(paths.some((path) => path.startsWith("src/") || path.startsWith("test/")), false);

  for (const path of paths) {
    const contents = await readFile(resolve(root, path), "utf8").catch(() => "");
    assert.equal(contents.includes(homedir()), false, `${path} contains an absolute home path`);
  }
});

test("the installed package has a deterministic closure and only three Stele tools", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "lyth-stele-pack-"));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  const output = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const report = JSON.parse(output)[0];
  const archive = resolve(temporary, report.filename);
  const installA = await installArchive(resolve(temporary, "install-a"), archive);
  const installB = await installArchive(resolve(temporary, "install-b"), archive);
  assert.deepEqual(installA.tree, installB.tree);
  assert.equal(installA.inventory.length >= 100, true);
  for (const expected of [
    "@github/keytar@7.10.6",
    "@modelcontextprotocol/sdk@1.29.0",
    "@monolythium/core-sdk@0.6.8",
    "lyth-mcp@0.3.0",
    "node-addon-api@8.9.0",
    "zod@3.25.76",
  ]) {
    assert.equal(installA.inventory.includes(expected), true, `installed closure is missing ${expected}`);
  }

  const sourceShrinkwrap = JSON.parse(
    await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"),
  );
  const packedShrinkwrap = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/npm-shrinkwrap.json"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  assert.deepEqual(packedShrinkwrap, sourceShrinkwrap);

  const packedRoot = resolve(installA.root, "node_modules/lyth-mcp");
  const walletHelp = execFileSync(
    process.execPath,
    [resolve(packedRoot, "dist/stele_wallet_index.js"), "--help"],
    { cwd: packedRoot, encoding: "utf8" },
  );
  assert.match(walletHelp, /lyth-stele-wallet <create\|repair>/u);
  assert.match(walletHelp, /Signing and submission are disabled/u);
  const oauthHelp = execFileSync(
    process.execPath,
    [resolve(packedRoot, "dist/stele_oauth_index.js"), "--help"],
    { cwd: packedRoot, encoding: "utf8" },
  );
  assert.match(oauthHelp, /lyth-stele-auth <login\|status\|logout>/u);
  assert.match(oauthHelp, /Tokens are never accepted on the command line/u);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(packedRoot, "dist/stele_index.js")],
    cwd: packedRoot,
    env: { NODE_NO_WARNINGS: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stele-packed-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), [
      "stele_connection_status",
      "stele_search_services",
      "stele_agent_wallet_status",
    ]);
  } finally {
    await client.close();
  }
});

async function installArchive(installRoot, archive) {
  await mkdir(installRoot);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const installed = JSON.parse(
    execFileSync("npm", ["ls", "--prefix", installRoot, "--all", "--omit=dev", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  const tree = canonicalDependencyTree(installed.dependencies);
  return { root: installRoot, tree, inventory: dependencyInventory(tree) };
}

function canonicalDependencyTree(dependencies = {}) {
  return Object.fromEntries(
    Object.entries(dependencies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        {
          version: value.version,
          dependencies: canonicalDependencyTree(value.dependencies),
        },
      ]),
  );
}

function dependencyInventory(tree) {
  const inventory = [];
  for (const [name, value] of Object.entries(tree)) {
    inventory.push(`${name}@${value.version}`);
    inventory.push(...dependencyInventory(value.dependencies));
  }
  return inventory.sort();
}
