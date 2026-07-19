#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredNodeEngine = ">=22.22.0";
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const shrinkwrap = JSON.parse(fs.readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
const nodeVersion = process.versions.node.split(".").map(Number);

if (
  packageJson.engines?.node !== requiredNodeEngine ||
  shrinkwrap.packages?.[""]?.engines?.node !== requiredNodeEngine ||
  nodeVersion.length !== 3 ||
  nodeVersion.some((part) => !Number.isSafeInteger(part) || part < 0) ||
  nodeVersion[0] < 22 ||
  (nodeVersion[0] === 22 && nodeVersion[1] < 22)
) {
  console.error(`lyth-mcp requires Node.js ${requiredNodeEngine}.`);
  process.exit(1);
}

const requiredFiles = [
  "dist/addressbook.js",
  "dist/addressbook.d.ts",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/stele_index.js",
  "dist/stele_index.d.ts",
  "dist/stele_oauth_index.js",
  "dist/stele_oauth_index.d.ts",
  "dist/stele_wallet_index.js",
  "dist/stele_wallet_index.d.ts",
  "dist/stele/agent-keystore.js",
  "dist/stele/agent-keystore.d.ts",
  "dist/stele/agent-wallet-admin.js",
  "dist/stele/agent-wallet-admin.d.ts",
  "dist/stele/api-client.js",
  "dist/stele/api-client.d.ts",
  "dist/stele/execution-gate.js",
  "dist/stele/execution-gate.d.ts",
  "dist/stele/network-identity.js",
  "dist/stele/network-identity.d.ts",
  "dist/stele/operator-fetch.js",
  "dist/stele/operator-fetch.d.ts",
  "dist/stele/os-credential-store.js",
  "dist/stele/os-credential-store.d.ts",
  "dist/stele/oauth-admin.js",
  "dist/stele/oauth-admin.d.ts",
  "dist/stele/oauth-browser.js",
  "dist/stele/oauth-browser.d.ts",
  "dist/stele/oauth-cli.js",
  "dist/stele/oauth-cli.d.ts",
  "dist/stele/oauth-contract.js",
  "dist/stele/oauth-contract.d.ts",
  "dist/stele/oauth-credential-store.js",
  "dist/stele/oauth-credential-store.d.ts",
  "dist/stele/oauth-http.js",
  "dist/stele/oauth-http.d.ts",
  "dist/stele/oauth-loopback.js",
  "dist/stele/oauth-loopback.d.ts",
  "dist/stele/oauth-refresh-lock.js",
  "dist/stele/oauth-refresh-lock.d.ts",
  "dist/stele/oauth-runtime-http.js",
  "dist/stele/oauth-runtime-http.d.ts",
  "dist/stele/oauth-session-broker.js",
  "dist/stele/oauth-session-broker.d.ts",
  "dist/stele/privacy.js",
  "dist/stele/privacy.d.ts",
  "dist/stele/server.js",
  "dist/stele/server.d.ts",
  "dist/stele/wallet-cli.js",
  "dist/stele/wallet-cli.d.ts",
  "dist/stele/wallet-state.js",
  "dist/stele/wallet-state.d.ts",
  "dist/wallet.js",
  "dist/wallet.d.ts",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length > 0) {
  console.error("lyth-mcp install requires committed build artifacts:");
  for (const file of missing) {
    console.error(`  - ${file}`);
  }
  console.error("Run `npm run build` before installing from this git checkout.");
  process.exit(1);
}
