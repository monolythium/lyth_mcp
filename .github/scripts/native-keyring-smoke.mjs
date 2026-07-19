import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { addressToBech32 } from "@monolythium/core-sdk";
import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import keytar from "@github/keytar";
import { createDefaultSteleSeedCustody } from "../../dist/stele/os-credential-store.js";
import {
  NativeSteleOAuthCredentialStore,
  credentialRecordsEqual,
  createSteleOAuthCredentialRecord,
  rotateSteleOAuthCredentialRecord,
} from "../../dist/stele/oauth-credential-store.js";

const service = "com.monolythium.stele.agent-wallet";
const oauthService = "com.monolythium.stele.oauth-session";
const oauthAccount = "hosted-mcp-v1:production";
const credentialId = randomBytes(32).toString("base64url");
const account = `dedicated-seed-v1:${credentialId}`;
const oauthPhysicalAccount = `${oauthAccount}:smoke:${credentialId}`;
const seed = randomBytes(32);
const backend = MlDsa65Backend.fromSeed(seed);
const addressBytes = backend.addressBytes();
const address = addressToBech32(addressBytes);
const watchdog = setTimeout(() => {
  process.stderr.write("Native credential-store smoke timed out.\n");
  process.exit(124);
}, 30_000);

try {
  const custody = await createDefaultSteleSeedCustody();
  assert.equal((await custody.listSeedIds()).includes(credentialId), false);
  await custody.createSeed(credentialId, address, seed);
  const readback = await custody.readSeed(credentialId);
  assert.notEqual(readback, null);
  try {
    assert.equal(readback.address, address);
    assert.equal(timingSafeEqual(readback.seed, seed), true);
  } finally {
    readback.seed.fill(0);
  }
  assert.equal((await custody.listSeedIds()).includes(credentialId), true);

  const seedCredentialBefore = await keytar.getPassword(service, account);
  assert.notEqual(seedCredentialBefore, null);
  const now = Date.now();
  const issuedAt = Math.floor(now / 1_000);
  const redirectUri = `http://127.0.0.1:39147/callback/${randomBytes(32).toString("base64url")}`;
  const oauthKeytar = {
    async getPassword(logicalService, logicalAccount) {
      assert.equal(
        logicalService === oauthService && logicalAccount === oauthAccount,
        true,
      );
      return keytar.getPassword(oauthService, oauthPhysicalAccount);
    },
    async setPassword(logicalService, logicalAccount, value) {
      assert.equal(
        logicalService === oauthService && logicalAccount === oauthAccount,
        true,
      );
      return keytar.setPassword(oauthService, oauthPhysicalAccount, value);
    },
    async deletePassword(logicalService, logicalAccount) {
      assert.equal(
        logicalService === oauthService && logicalAccount === oauthAccount,
        true,
      );
      return keytar.deletePassword(oauthService, oauthPhysicalAccount);
    },
  };
  const oauth = new NativeSteleOAuthCredentialStore(oauthKeytar);
  const registration = {
    redirect_uris: [redirectUri],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Lyth Stele MCP",
    scope: "stele:public:read",
    software_id: "com.monolythium.lyth-mcp.stele",
    software_version: "0.3.0",
    client_id: `stc_${randomBytes(24).toString("base64url")}`,
    client_id_issued_at: issuedAt,
    client_id_expires_at: issuedAt + 86_400,
  };
  const first = createSteleOAuthCredentialRecord(
    registration,
    {
      access_token: randomBytes(32).toString("base64url"),
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: randomBytes(32).toString("base64url"),
      scope: "stele:public:read",
    },
    now,
  );
  await oauth.write(first);
  assert.equal(credentialRecordsEqual(await oauth.read(), first), true);
  const replacement = rotateSteleOAuthCredentialRecord(
    first,
    {
      access_token: randomBytes(32).toString("base64url"),
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: randomBytes(32).toString("base64url"),
      scope: "stele:public:read",
    },
    now + 1,
  );
  await oauth.write(replacement);
  assert.equal(credentialRecordsEqual(await oauth.read(), replacement), true);
  assert.equal(replacement.tokens.generation, 2);
  assert.equal(await oauth.delete(), true);
  assert.equal(await oauth.read(), null);
  const seedCredentialAfter = await keytar.getPassword(service, account);
  assert.notEqual(seedCredentialAfter, null);
  const seedBeforeBytes = Buffer.from(seedCredentialBefore, "utf8");
  const seedAfterBytes = Buffer.from(seedCredentialAfter, "utf8");
  try {
    assert.equal(
      seedBeforeBytes.length === seedAfterBytes.length &&
        timingSafeEqual(seedBeforeBytes, seedAfterBytes),
      true,
    );
  } finally {
    seedBeforeBytes.fill(0);
    seedAfterBytes.fill(0);
  }
  process.stdout.write(`Production credential-store adapter smoke passed on ${process.platform}.\n`);
} finally {
  addressBytes.fill(0);
  backend.dispose();
  seed.fill(0);
  try {
    await Promise.all([
      keytar.deletePassword(service, account).catch(() => false),
      keytar.deletePassword(oauthService, oauthPhysicalAccount).catch(() => false),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}
