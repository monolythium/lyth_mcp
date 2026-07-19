import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import {
  SteleWalletAdmin,
  SteleWalletAdminError,
  safeSteleWalletAdminErrorCode,
} from "../../dist/stele/agent-wallet-admin.js";
import {
  NativeSteleSeedCustody,
  SteleCredentialStoreError,
  credentialBackendForPlatform,
  keytarApiFromModule,
} from "../../dist/stele/os-credential-store.js";
import { runSteleWalletCli } from "../../dist/stele/wallet-cli.js";
import {
  FileSteleWalletStateStore,
  SteleWalletStateError,
} from "../../dist/stele/wallet-state.js";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class FakeCustody {
  backend = "linux_secret_service";
  records = new Map();
  writes = 0;
  capturedReference = null;
  lastReadReference = null;
  createFailure = null;
  afterStoreFailure = null;
  entered = null;
  release = null;

  get seed() {
    return this.records.values().next().value?.seed ?? null;
  }

  async listSeedIds() {
    return [...this.records.keys()].sort();
  }

  async readSeed(credentialId) {
    const record = this.records.get(credentialId);
    if (record === undefined) return null;
    this.lastReadReference = Uint8Array.from(record.seed);
    return { credentialId, address: record.address, seed: this.lastReadReference };
  }

  async createSeed(credentialId, address, seed) {
    this.writes += 1;
    this.capturedReference = seed;
    this.entered?.();
    if (this.createFailure) throw this.createFailure;
    if (this.release) await this.release;
    if (this.records.has(credentialId)) throw new SteleCredentialStoreError("already_exists");
    this.records.set(credentialId, { address, seed: Uint8Array.from(seed) });
    if (this.afterStoreFailure) throw this.afterStoreFailure;
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lyth-stele-wallet-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "private", "wallet.json");
  const state = new FileSteleWalletStateStore(statePath);
  const custody = new FakeCustody();
  const admin = new SteleWalletAdmin({
    state,
    custody,
    fillRandom(seed) { seed.fill(7); },
    operationId() { return OPERATION_ID; },
  });
  return { root, statePath, state, custody, admin };
}

test("public status is not configured without creating files or opening custody", async (t) => {
  const { root, state } = await fixture(t);
  const status = await state.readStatus();
  assert.deepEqual(
    { state: status.state, address: status.address, generation: status.generation },
    { state: "not_configured", address: null, generation: null },
  );
  await assert.rejects(stat(join(root, "private")), { code: "ENOENT" });
});

test("creation commits only public locked metadata and wipes the mutable seed", async (t) => {
  const { statePath, state, custody, admin } = await fixture(t);
  const result = await admin.create();
  assert.equal(result.action, "created");
  assert.equal(result.wallet.state, "configured_locked");
  assert.match(result.wallet.address, /^mono1/u);
  assert.equal(result.wallet.generation, 1);
  assert.equal(custody.writes, 1);
  assert.equal(custody.capturedReference.every((byte) => byte === 0), true);
  assert.deepEqual(await state.readStatus(), result.wallet);

  const publicState = await readFile(statePath, "utf8");
  const encodedSeed = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(publicState.includes(encodedSeed), false);
  assert.equal(publicState.includes("mnemonic"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o077, 0);
    assert.equal((await stat(join(statePath, ".."))).mode & 0o077, 0);
  }
});

test("duplicate creation never overwrites the dedicated seed", async (t) => {
  const { custody, admin } = await fixture(t);
  await admin.create();
  const before = Uint8Array.from(custody.seed);
  await assert.rejects(admin.create(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "already_configured");
    return true;
  });
  assert.equal(custody.writes, 1);
  assert.deepEqual(custody.seed, before);
  before.fill(0);
});

test("a pre-store failure remains provisioning until repair clears it", async (t) => {
  const { state, custody, admin } = await fixture(t);
  custody.createFailure = new SteleCredentialStoreError("unavailable");
  await assert.rejects(admin.create(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "credential_store_unavailable");
    return true;
  });
  await assert.rejects(state.readStatus(), SteleWalletStateError);
  assert.equal(custody.capturedReference.every((byte) => byte === 0), true);

  custody.createFailure = null;
  const repaired = await admin.repair();
  assert.equal(repaired.action, "cleared_incomplete");
  assert.equal(repaired.wallet.state, "not_configured");
});

test("a post-store failure preserves and recovers the same seed", async (t) => {
  const { state, custody, admin } = await fixture(t);
  custody.afterStoreFailure = new SteleCredentialStoreError("unavailable");
  await assert.rejects(admin.create(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "credential_store_unavailable");
    return true;
  });
  const storedBeforeRepair = Uint8Array.from(custody.seed);
  await assert.rejects(state.readStatus(), SteleWalletStateError);

  custody.afterStoreFailure = null;
  const repaired = await admin.repair();
  assert.equal(repaired.action, "recovered");
  assert.equal(repaired.wallet.state, "configured_locked");
  assert.deepEqual(custody.seed, storedBeforeRepair);
  storedBeforeRepair.fill(0);
});

test("repair refuses a configured address and seed mismatch", async (t) => {
  const { custody, admin } = await fixture(t);
  await admin.create();
  custody.seed.fill(9);
  await assert.rejects(admin.repair(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "manual_recovery_required");
    return true;
  });
});

test("repair verifies an intact configured wallet and wipes its read copy", async (t) => {
  const { custody, admin } = await fixture(t);
  const created = await admin.create();
  const repaired = await admin.repair();
  assert.equal(repaired.action, "verified");
  assert.deepEqual(repaired.wallet, created.wallet);
  assert.equal(custody.lastReadReference.every((byte) => byte === 0), true);
});

test("repair recovers one operation-scoped orphan without replacing it", async (t) => {
  const { custody, admin } = await fixture(t);
  custody.records.set(OPERATION_ID, {
    address: "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u",
    seed: new Uint8Array(32).fill(7),
  });
  const before = Uint8Array.from(custody.seed);
  const repaired = await admin.repair();
  assert.equal(repaired.action, "recovered");
  assert.equal(repaired.wallet.state, "configured_locked");
  assert.deepEqual(custody.seed, before);
  assert.equal(custody.writes, 0);
  before.fill(0);
});

test("configured metadata without its seed requires manual recovery", async (t) => {
  const { custody, admin } = await fixture(t);
  await admin.create();
  custody.records.clear();
  await assert.rejects(admin.repair(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "manual_recovery_required");
    return true;
  });
});

test("malformed state fails closed and is not presented as command-repairable", async (t) => {
  const { statePath, state, admin } = await fixture(t);
  await admin.create();
  await writeFile(statePath, "{\"schemaVersion\":1", { mode: 0o600 });
  await assert.rejects(state.readStatus(), (error) => {
    assert.equal(error.code, "corrupt");
    return true;
  });
  await assert.rejects(admin.repair(), (error) => {
    assert.equal(safeSteleWalletAdminErrorCode(error), "manual_recovery_required");
    return true;
  });
});

test("oversized and group-readable state files fail closed", { skip: process.platform === "win32" }, async (t) => {
  const { statePath, state, admin } = await fixture(t);
  await admin.create();
  await writeFile(statePath, "x".repeat(2_049), { mode: 0o600 });
  await assert.rejects(state.readStatus(), (error) => {
    assert.equal(error.code, "unavailable");
    return true;
  });
  await writeFile(statePath, "{}\n", { mode: 0o600 });
  await chmod(statePath, 0o640);
  await assert.rejects(state.readStatus(), (error) => {
    assert.equal(error.code, "unavailable");
    return true;
  });
});

test("a symlinked state file fails closed", { skip: process.platform === "win32" }, async (t) => {
  const { root, statePath, state, admin } = await fixture(t);
  await admin.create();
  const target = join(root, "public-target.json");
  await writeFile(target, await readFile(statePath));
  await unlink(statePath);
  await symlink(target, statePath);
  await assert.rejects(state.readStatus(), SteleWalletStateError);
});

test("SDK audit metadata remains readable across a routine SDK version migration", async (t) => {
  const { statePath, state, admin } = await fixture(t);
  const created = await admin.create();
  const record = JSON.parse(await readFile(statePath, "utf8"));
  record.createdWithSdkVersion = "0.7.0";
  await writeFile(statePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  assert.deepEqual(await state.readStatus(), created.wallet);
});

test("atomic provisioning rejects concurrent creation before a second write", { timeout: 5_000 }, async (t) => {
  const { state, custody, admin } = await fixture(t);
  let entered;
  const hasEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  custody.release = new Promise((resolve) => { release = resolve; });
  custody.entered = entered;

  const first = admin.create();
  await hasEntered;
  const second = new SteleWalletAdmin({
    state,
    custody,
    fillRandom(seed) { seed.fill(8); },
    operationId() { return "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"; },
  });
  try {
    await assert.rejects(second.create(), (error) => {
      assert.equal(safeSteleWalletAdminErrorCode(error), "busy");
      return true;
    });
    assert.equal(custody.writes, 1);
  } finally {
    release();
    await first;
  }
});

test("a symlinked lifecycle directory fails closed", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await fixture(t);
  const target = join(root, "target");
  const linked = join(root, "linked");
  await symlink(target, linked);
  const state = new FileSteleWalletStateStore(join(linked, "wallet.json"));
  await assert.rejects(state.readStatus(), SteleWalletStateError);
});

test("the native adapter stores a strict network-bound seed record once", async () => {
  const stored = new Map();
  const keytar = {
    async getPassword(_service, account) { return stored.get(account) ?? null; },
    async setPassword(_service, account, value) { stored.set(account, value); },
    async findCredentials() {
      return [...stored].map(([account, password]) => ({ account, password }));
    },
  };
  const custody = new NativeSteleSeedCustody(keytar, "linux_secret_service");
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
  const address = "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u";
  await custody.createSeed(OPERATION_ID, address, seed);
  assert.equal([...stored.values()][0].includes(seed.toString()), false);
  const readback = await custody.readSeed(OPERATION_ID);
  assert.deepEqual(readback.seed, seed);
  assert.equal(readback.address, address);
  readback.seed.fill(0);
  assert.deepEqual(await custody.listSeedIds(), [OPERATION_ID]);
  await assert.rejects(
    custody.createSeed(OPERATION_ID, address, seed),
    SteleCredentialStoreError,
  );
  seed.fill(0);
});

test("operation-scoped native accounts prevent two creations from overwriting", async () => {
  const stored = new Map();
  const keytar = {
    async getPassword(_service, account) { return stored.get(account) ?? null; },
    async setPassword(_service, account, value) {
      await Promise.resolve();
      stored.set(account, value);
    },
    async findCredentials() {
      return [...stored].map(([account, password]) => ({ account, password }));
    },
  };
  const custody = new NativeSteleSeedCustody(keytar, "linux_secret_service");
  const idA = OPERATION_ID;
  const idB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const address = "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u";
  const seedA = new Uint8Array(32).fill(7);
  const seedB = new Uint8Array(32).fill(8);
  await Promise.all([
    custody.createSeed(idA, address, seedA),
    custody.createSeed(idB, address, seedB),
  ]);
  assert.deepEqual(await custody.listSeedIds(), [idA, idB]);
  assert.equal(stored.size, 2);
  seedA.fill(0);
  seedB.fill(0);
});

test("the native adapter rejects malformed records and unsupported platforms", async () => {
  const custody = new NativeSteleSeedCustody(
    {
      async getPassword() { return "not-a-stele-seed"; },
      async setPassword() { throw new Error("not used"); },
      async findCredentials() { return []; },
    },
    "linux_secret_service",
  );
  await assert.rejects(custody.readSeed(OPERATION_ID), (error) => {
    assert.equal(error.code, "corrupt");
    return true;
  });
  assert.equal(credentialBackendForPlatform("darwin"), "macos_keychain");
  assert.equal(credentialBackendForPlatform("win32"), "windows_credential_manager");
  assert.equal(credentialBackendForPlatform("linux"), "linux_secret_service");
  assert.throws(() => credentialBackendForPlatform("aix"), SteleCredentialStoreError);
  const cjsDefault = {
    getPassword: async () => null,
    setPassword: async () => undefined,
    findCredentials: async () => [],
  };
  assert.equal(keytarApiFromModule({ default: cjsDefault }), cjsDefault);
  assert.throws(() => keytarApiFromModule({ getPassword: async () => null }), SteleCredentialStoreError);
});

test("native credential failures and invalid seed sizes fail closed", async () => {
  const address = "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u";
  const unavailable = new NativeSteleSeedCustody(
    {
      async getPassword() { throw new Error("raw native error"); },
      async setPassword() { throw new Error("raw native error"); },
      async findCredentials() { throw new Error("raw native error"); },
    },
    "linux_secret_service",
  );
  await assert.rejects(unavailable.readSeed(OPERATION_ID), (error) => error.code === "unavailable");
  await assert.rejects(unavailable.listSeedIds(), (error) => error.code === "unavailable");

  const absent = new NativeSteleSeedCustody(
    {
      async getPassword() { return null; },
      async setPassword() { throw new Error("raw native error"); },
      async findCredentials() { return []; },
    },
    "linux_secret_service",
  );
  await assert.rejects(
    absent.createSeed(OPERATION_ID, address, new Uint8Array(32)),
    (error) => error.code === "unavailable",
  );
  await assert.rejects(
    absent.createSeed(OPERATION_ID, address, new Uint8Array(31)),
    (error) => error.code === "corrupt",
  );
});

function io(tty = true) {
  let stdout = "";
  let stderr = "";
  return {
    value: {
      stdin: { isTTY: tty },
      stdout: { isTTY: tty, write(chunk) { stdout += String(chunk); return true; } },
      stderr: { isTTY: tty, write(chunk) { stderr += String(chunk); return true; } },
    },
    output() { return { stdout, stderr }; },
  };
}

test("the CLI rejects pipes, extra arguments, and cancellation before loading custody", async () => {
  let loads = 0;
  const loadAdmin = async () => { loads += 1; throw new Error("must not load"); };
  assert.equal(await runSteleWalletCli(["create"], io(false).value, { loadAdmin }), 2);
  assert.equal(await runSteleWalletCli(["create", "--seed=x"], io().value, { loadAdmin }), 2);
  assert.equal(
    await runSteleWalletCli(["create"], io().value, {
      loadAdmin,
      async confirm() { return "no"; },
    }),
    2,
  );
  assert.equal(loads, 0);
});

test("the TTY CLI emits only public creation status", async () => {
  const streams = io();
  const secret = "sentinel-seed-that-must-never-print";
  const status = {
    state: "configured_locked",
    provenance: "stele_dedicated_agent",
    keyStorage: "os_credential_store",
    address: "mono1publicaddress",
    generation: 1,
    import: "forbidden",
    export: "forbidden",
    signing: "disabled",
    execution: { signing: "disabled", submission: "disabled" },
  };
  const exitCode = await runSteleWalletCli(["create"], streams.value, {
    async confirm() { return "CREATE STELE TESTNET WALLET"; },
    async loadAdmin() {
      return {
        async createDefaultSteleWalletAdmin() {
          return {
            async create() { return { action: "created", wallet: status, secret }; },
          };
        },
        safeSteleWalletAdminErrorCode,
      };
    },
  });
  assert.equal(exitCode, 0);
  const output = JSON.stringify(streams.output());
  assert.equal(output.includes(status.address), true);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("Signing: disabled"), true);
  assert.equal(output.includes("Submission: disabled"), true);
});

test("raw admin errors never reach CLI output", async () => {
  const streams = io();
  const sentinel = "keychain path /home/private and seed alpha beta";
  const exitCode = await runSteleWalletCli(["repair"], streams.value, {
    async confirm() { return "REPAIR STELE TESTNET WALLET"; },
    async loadAdmin() {
      return {
        async createDefaultSteleWalletAdmin() {
          return { async repair() { throw new Error(sentinel); } };
        },
        safeSteleWalletAdminErrorCode,
      };
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.stringify(streams.output()).includes(sentinel), false);
});

test("manual recovery copy warns that an incomplete credential may exist", async () => {
  const streams = io();
  const exitCode = await runSteleWalletCli(["repair"], streams.value, {
    async confirm() { return "REPAIR STELE TESTNET WALLET"; },
    async loadAdmin() {
      return {
        async createDefaultSteleWalletAdmin() {
          return {
            async repair() {
              throw new SteleWalletAdminError("manual_recovery_required");
            },
          };
        },
        safeSteleWalletAdminErrorCode,
      };
    },
  });
  assert.equal(exitCode, 1);
  assert.match(streams.output().stderr, /incomplete credential may exist/u);
  assert.match(streams.output().stderr, /No existing credential was overwritten or deleted/u);
  assert.doesNotMatch(streams.output().stderr, /No key was changed/u);
});

test("credential-store factory failures retain the safe unavailable classification", async () => {
  const streams = io();
  const exitCode = await runSteleWalletCli(["create"], streams.value, {
    async confirm() { return "CREATE STELE TESTNET WALLET"; },
    async loadAdmin() {
      return {
        async createDefaultSteleWalletAdmin() {
          throw new SteleCredentialStoreError("unavailable");
        },
        safeSteleWalletAdminErrorCode,
      };
    },
  });
  assert.equal(exitCode, 1);
  assert.match(streams.output().stderr, /native OS credential store is unavailable or locked/u);
});
