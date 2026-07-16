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
  "dist/stele/agent-keystore.js",
  "dist/stele/api-client.js",
  "dist/stele/execution-gate.js",
  "dist/stele/network-identity.js",
  "dist/stele/operator-fetch.js",
  "dist/stele/privacy.js",
  "dist/stele/server.js",
];

test("the public package exact-pins the reviewed SDK release", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(packageJson.dependencies["@monolythium/core-sdk"], "0.6.8");
  assert.equal(lock.packages[""].dependencies["@monolythium/core-sdk"], "0.6.8");
  assert.equal(lock.packages["node_modules/@monolythium/core-sdk"].version, "0.6.8");
  assert.equal(packageJson.bin["lyth-stele-mcp"], "dist/stele_index.js");
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

test("npm packing includes the Stele runtime but no source, tests, or private/internal paths", async () => {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const report = JSON.parse(output)[0];
  const paths = report.files.map((entry) => entry.path);

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
    "@modelcontextprotocol/sdk@1.29.0",
    "@monolythium/core-sdk@0.6.8",
    "lyth-mcp@0.1.0",
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
