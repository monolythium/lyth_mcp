#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "dist/addressbook.js",
  "dist/addressbook.d.ts",
  "dist/index.js",
  "dist/index.d.ts",
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
