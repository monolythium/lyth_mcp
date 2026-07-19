import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { addressToBech32 } from "@monolythium/core-sdk";
import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import keytar from "@github/keytar";
import { createDefaultSteleSeedCustody } from "../../dist/stele/os-credential-store.js";

const service = "com.monolythium.stele.agent-wallet";
const credentialId = randomBytes(32).toString("base64url");
const account = `dedicated-seed-v1:${credentialId}`;
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
  process.stdout.write(`Production credential-store adapter smoke passed on ${process.platform}.\n`);
} finally {
  addressBytes.fill(0);
  backend.dispose();
  seed.fill(0);
  try {
    await keytar.deletePassword(service, account).catch(() => false);
  } finally {
    clearTimeout(watchdog);
  }
}
