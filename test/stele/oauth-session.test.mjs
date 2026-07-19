import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SteleOAuthAdmin,
  SteleOAuthAdminError,
  safeSteleOAuthAdminErrorCode,
} from "../../dist/stele/oauth-admin.js";
import { runSteleOAuthCli } from "../../dist/stele/oauth-cli.js";
import {
  STELE_OAUTH_CREDENTIAL_ACCOUNT,
  STELE_OAUTH_CREDENTIAL_SERVICE,
  STELE_OAUTH_ISSUER,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
} from "../../dist/stele/oauth-contract.js";
import {
  NativeSteleOAuthCredentialStore,
  SteleOAuthCredentialStoreError,
  createSteleOAuthCredentialRecord,
  rotateSteleOAuthCredentialRecord,
} from "../../dist/stele/oauth-credential-store.js";
import { SteleOAuthHttpError } from "../../dist/stele/oauth-http.js";
import {
  KernelSteleOAuthRefreshLock,
  SteleOAuthRefreshLockError,
} from "../../dist/stele/oauth-refresh-lock.js";
import {
  SteleOAuthRuntimeHttpClient,
  SteleOAuthRuntimeHttpError,
} from "../../dist/stele/oauth-runtime-http.js";
import {
  SteleOAuthSessionBroker,
  SteleOAuthSessionError,
} from "../../dist/stele/oauth-session-broker.js";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "C".repeat(43);
const TOKEN_D = "D".repeat(43);
const PKCE_CHALLENGE_A = createHash("sha256").update(TOKEN_A, "ascii").digest("base64url");
const CLIENT_ID = `stc_${"E".repeat(32)}`;
const CALLBACK_ID = "F".repeat(43);
const REDIRECT_URI = `http://127.0.0.1:39147/callback/${CALLBACK_ID}`;
const NOW = 1_700_000_000_000;

function registration(redirectUri = REDIRECT_URI) {
  return {
    redirect_uris: [redirectUri],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Lyth Stele MCP",
    scope: STELE_OAUTH_SCOPE,
    software_id: "com.monolythium.lyth-mcp.stele",
    software_version: "0.3.0",
    client_id: CLIENT_ID,
    client_id_issued_at: NOW / 1_000,
    client_id_expires_at: NOW / 1_000 + 86_400,
  };
}

function tokens(access = TOKEN_A, refresh = TOKEN_B) {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 900,
    refresh_token: refresh,
    scope: STELE_OAUTH_SCOPE,
  };
}

function record(overrides = {}) {
  const created = createSteleOAuthCredentialRecord(registration(), tokens(), NOW);
  return {
    ...created,
    ...overrides,
    registration: { ...created.registration, ...(overrides.registration ?? {}) },
    tokens: { ...created.tokens, ...(overrides.tokens ?? {}) },
  };
}

test("OAuth response extensions are stripped before native persistence", () => {
  const created = createSteleOAuthCredentialRecord(
    { ...registration(), registration_extension: { private: "ignored" } },
    { ...tokens(), token_extension: TOKEN_D },
    NOW,
  );
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes("registration_extension"), false);
  assert.equal(serialized.includes("token_extension"), false);
  assert.equal(serialized.includes(TOKEN_D), false);
});

test("credential records reject same-response and cross-generation token collisions", () => {
  assert.throws(
    () => createSteleOAuthCredentialRecord(registration(), tokens(TOKEN_A, TOKEN_A), NOW),
    (error) => error instanceof SteleOAuthCredentialStoreError && error.code === "corrupt",
  );
  const current = record({ tokens: { accessExpiresAt: NOW - 1 } });
  for (const collided of [
    tokens(TOKEN_A, TOKEN_C),
    tokens(TOKEN_B, TOKEN_C),
    tokens(TOKEN_C, TOKEN_A),
    tokens(TOKEN_C, TOKEN_B),
    tokens(TOKEN_C, TOKEN_C),
  ]) {
    assert.throws(
      () => rotateSteleOAuthCredentialRecord(current, collided, NOW),
      (error) => error instanceof SteleOAuthCredentialStoreError && error.code === "corrupt",
    );
  }
  const replacement = rotateSteleOAuthCredentialRecord(current, tokens(TOKEN_C, TOKEN_D), NOW);
  assert.equal(replacement.tokens.accessToken, TOKEN_C);
  assert.equal(replacement.tokens.refreshToken, TOKEN_D);
});

test("native persistence rejects an access and refresh token collision before keychain I/O", async () => {
  let writes = 0;
  const store = new NativeSteleOAuthCredentialStore({
    async getPassword() { return null; },
    async setPassword() { writes += 1; },
    async deletePassword() { return false; },
  });
  await assert.rejects(
    store.write(record({ tokens: { refreshToken: TOKEN_A } })),
    (error) => error instanceof SteleOAuthCredentialStoreError && error.code === "corrupt",
  );
  assert.equal(writes, 0);
});

class MemoryStore {
  constructor(value = null) { this.value = value; }
  writes = 0;
  deletes = 0;
  async read() { return this.value === null ? null : structuredClone(this.value); }
  async write(value) { this.writes += 1; this.value = structuredClone(value); }
  async delete() { this.deletes += 1; const existed = this.value !== null; this.value = null; return existed; }
}

const immediate = { async runExclusive(operation) { return operation(); } };
const lockModuleUrl = new URL("../../dist/stele/oauth-refresh-lock.js", import.meta.url).href;

const lockChildScript = String.raw`
const [moduleUrl, portText, logPath, id, holdText] = process.argv.slice(1);
const { appendFile } = await import("node:fs/promises");
const { KernelSteleOAuthRefreshLock } = await import(moduleUrl);
const lock = new KernelSteleOAuthRefreshLock({
  port: Number(portText),
  waitTimeoutMs: 10_000,
  pollIntervalMs: 5,
});
await lock.runExclusive(async () => {
  await appendFile(logPath, "start " + id + " " + process.pid + "\n", "utf8");
  process.stdout.write("acquired " + process.pid + "\n");
  if (holdText === "forever") await new Promise(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, Number(holdText)));
  await appendFile(logPath, "end " + id + " " + process.pid + "\n", "utf8");
});
`;

function spawnLockChild(port, logPath, id, hold) {
  return spawn(
    process.execPath,
    ["--input-type=module", "--eval", lockChildScript, lockModuleUrl, String(port), logPath, id, String(hold)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function childSucceeded(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  return stdout;
}

async function waitForChildOutput(child, expected, timeoutMs = 5_000) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child output timeout"));
    }, timeoutMs);
    const onData = (value) => {
      output += value;
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("child exited before acquiring mutex"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function assertSerializedLog(contents, expectedCount) {
  const active = new Set();
  const pids = new Set();
  for (const line of contents.trim().split("\n")) {
    const [event, id, pid] = line.split(" ");
    pids.add(Number(pid));
    if (event === "start") {
      assert.equal(active.size, 0, `overlapping child entered: ${line}`);
      active.add(id);
    } else {
      assert.equal(event, "end");
      assert.equal(active.delete(id), true);
    }
  }
  assert.equal(active.size, 0);
  assert.equal(pids.size, expectedCount);
  assert.equal(pids.has(process.pid), false);
}

test("the native adapter stores one strict combined OAuth record under a separate exact service/account", async () => {
  const stored = new Map();
  const calls = [];
  const keytar = {
    async getPassword(service, account) { calls.push(["get", service, account]); return stored.get(`${service}\0${account}`) ?? null; },
    async setPassword(service, account, value) { calls.push(["set", service, account]); stored.set(`${service}\0${account}`, value); },
    async deletePassword(service, account) { calls.push(["delete", service, account]); return stored.delete(`${service}\0${account}`); },
  };
  const store = new NativeSteleOAuthCredentialStore(keytar);
  const expected = record();
  await store.write(expected);
  assert.deepEqual(await store.read(), expected);
  assert.equal(stored.size, 1);
  assert.equal([...stored.keys()][0], `${STELE_OAUTH_CREDENTIAL_SERVICE}\0${STELE_OAUTH_CREDENTIAL_ACCOUNT}`);
  const encoded = [...stored.values()][0];
  for (const field of ["registration", "accessToken", "refreshToken", CLIENT_ID, TOKEN_A, TOKEN_B]) {
    assert.equal(encoded.includes(field), true);
  }
  assert.equal(encoded.includes("agent-wallet"), false);
  assert.equal(await store.delete(), true);
  assert.equal(await store.read(), null);
  assert.equal(calls.every(([, service, account]) => service === STELE_OAUTH_CREDENTIAL_SERVICE && account === STELE_OAUTH_CREDENTIAL_ACCOUNT), true);
});

test("credential corruption and native failures fail closed without a file or environment fallback", async () => {
  const corrupt = new NativeSteleOAuthCredentialStore({
    async getPassword() { return JSON.stringify({ ...record(), clientId: "smuggled" }); },
    async setPassword() {},
    async deletePassword() { return false; },
  });
  await assert.rejects(corrupt.read(), (error) => error.code === "corrupt");
  const unavailable = new NativeSteleOAuthCredentialStore({
    async getPassword() { throw new Error("native sentinel"); },
    async setPassword() { throw new Error("native sentinel"); },
    async deletePassword() { throw new Error("native sentinel"); },
  });
  await assert.rejects(unavailable.read(), (error) => error instanceof SteleOAuthCredentialStoreError && error.code === "unavailable");
  await assert.rejects(unavailable.write(record()), (error) => error.code === "unavailable");
  await assert.rejects(unavailable.delete(), (error) => error.code === "unavailable");
});

test("kernel refresh mutex serializes real child processes for each complete operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lyth-oauth-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "mutex.log");
  const port = await unusedLoopbackPort();
  const children = Array.from({ length: 6 }, (_, index) =>
    spawnLockChild(port, logPath, `child-${index}`, 35));
  await Promise.all(children.map(childSucceeded));
  assertSerializedLog(await readFile(logPath, "utf8"), children.length);
});

test("kernel mutex destroys accepted sockets, closes promptly, and maps non-contention bind errors", async () => {
  const port = await unusedLoopbackPort();
  const lock = new KernelSteleOAuthRefreshLock({ port, waitTimeoutMs: 500, pollIntervalMs: 5 });
  let socketClosed;
  const started = Date.now();
  await lock.runExclusive(async () => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socketClosed = new Promise((resolve) => {
      socket.once("close", resolve);
      socket.once("error", resolve);
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  });
  await socketClosed;
  assert.equal(Date.now() - started < 1_000, true);

  const failingServer = new EventEmitter();
  failingServer.listening = false;
  failingServer.maxConnections = 0;
  failingServer.listen = () => {
    queueMicrotask(() => {
      const error = new Error("bind denied");
      error.code = "EACCES";
      failingServer.emit("error", error);
    });
  };
  const unavailable = new KernelSteleOAuthRefreshLock({
    port,
    serverFactory: () => failingServer,
  });
  let ran = false;
  await assert.rejects(
    unavailable.runExclusive(async () => { ran = true; }),
    (error) => error instanceof SteleOAuthRefreshLockError && error.code === "unavailable",
  );
  assert.equal(ran, false);
});

test("kernel mutex checks its monotonic deadline after an oversleep and before retrying bind", async () => {
  let now = 0;
  let bindAttempts = 0;
  const lock = new KernelSteleOAuthRefreshLock({
    port: 49_372,
    waitTimeoutMs: 50,
    pollIntervalMs: 5,
    monotonicNow: () => now,
    async delay() { now = 51; },
    serverFactory() {
      bindAttempts += 1;
      const server = new EventEmitter();
      server.listening = false;
      server.maxConnections = 0;
      server.listen = () => {
        queueMicrotask(() => {
          const error = new Error("occupied");
          error.code = "EADDRINUSE";
          server.emit("error", error);
        });
      };
      return server;
    },
  });
  await assert.rejects(
    lock.runExclusive(async () => undefined),
    (error) => error instanceof SteleOAuthRefreshLockError && error.code === "busy",
  );
  assert.equal(bindAttempts, 1);
});

test("kernel crash recovery admits simultaneous contenders only after a killed owner releases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lyth-oauth-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerLog = join(root, "owner.log");
  const contenderLog = join(root, "contenders.log");
  const port = await unusedLoopbackPort();
  const owner = spawnLockChild(port, ownerLog, "owner", "forever");
  owner.stderr.resume();
  t.after(() => { if (owner.exitCode === null) owner.kill("SIGKILL"); });
  const acquired = await waitForChildOutput(owner, "acquired ");
  assert.match(acquired, /acquired [1-9][0-9]*\n/u);

  const blocked = new KernelSteleOAuthRefreshLock({
    port,
    waitTimeoutMs: 75,
    pollIntervalMs: 5,
  });
  await assert.rejects(
    blocked.runExclusive(async () => undefined),
    (error) => error instanceof SteleOAuthRefreshLockError && error.code === "busy",
  );

  const ownerExited = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("exit", resolve);
  });
  assert.equal(owner.kill("SIGKILL"), true);
  await ownerExited;

  const contenders = Array.from({ length: 8 }, (_, index) =>
    spawnLockChild(port, contenderLog, `recovered-${index}`, 25));
  await Promise.all(contenders.map(childSucceeded));
  assertSerializedLog(await readFile(contenderLog, "utf8"), contenders.length);
});

test("mutex ownership is established before the runtime reads native credentials", async () => {
  const port = await unusedLoopbackPort();
  const owner = new KernelSteleOAuthRefreshLock({ port, waitTimeoutMs: 500, pollIntervalMs: 5 });
  let releaseOwner;
  let ownerEntered;
  const entered = new Promise((resolve) => { ownerEntered = resolve; });
  const held = owner.runExclusive(async () => {
    ownerEntered();
    await new Promise((resolve) => { releaseOwner = resolve; });
  });
  await entered;

  let reads = 0;
  const broker = new SteleOAuthSessionBroker({
    store: {
      async read() { reads += 1; return null; },
      async write() { throw new Error("forbidden"); },
      async delete() { throw new Error("forbidden"); },
    },
    transport: {
      async refresh() { throw new Error("forbidden"); },
      async revoke() { throw new Error("forbidden"); },
    },
    refresh: new KernelSteleOAuthRefreshLock({ port, waitTimeoutMs: 75, pollIntervalMs: 5 }),
  });
  await assert.rejects(broker.accessToken(), (error) => error.code === "unavailable");
  assert.equal(reads, 0);
  releaseOwner();
  await held;
});

test("runtime refresh is serialized, rereads after locking, and persists one rotation", async (t) => {
  const store = new MemoryStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  let refreshCalls = 0;
  const transport = {
    async revoke() { throw new Error("runtime must not revoke"); },
    async refresh() {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return tokens(TOKEN_C, TOKEN_D);
    },
  };
  const port = await unusedLoopbackPort();
  const broker = () => new SteleOAuthSessionBroker({
    store,
    transport,
    refresh: new KernelSteleOAuthRefreshLock({ port, waitTimeoutMs: 2_000, pollIntervalMs: 5 }),
    now: () => NOW,
  });
  assert.deepEqual(await Promise.all([broker().accessToken(), broker().accessToken()]), [TOKEN_C, TOKEN_C]);
  assert.equal(refreshCalls, 1);
  assert.equal(store.writes, 1);
  assert.equal(store.value.tokens.refreshToken, TOKEN_D);
  assert.equal(store.value.tokens.generation, 2);
});

test("runtime never launches recovery: invalid grants mark sanitized reauthentication required", async () => {
  const store = new MemoryStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  let refreshCalls = 0;
  const broker = new SteleOAuthSessionBroker({
    store,
    refresh: immediate,
    now: () => NOW,
    transport: {
      async revoke() { throw new Error("forbidden"); },
      async refresh() { refreshCalls += 1; throw new SteleOAuthRuntimeHttpError("protocol", "invalid_client"); },
    },
  });
  await assert.rejects(
    broker.accessToken(),
    (error) => error instanceof SteleOAuthSessionError && error.code === "auth_required",
  );
  assert.equal(refreshCalls, 1);
  assert.equal(store.value.sessionState, "reauth_required");
  const status = await broker.status();
  assert.deepEqual(status, {
    state: "reauth_required",
    issuer: STELE_OAUTH_ISSUER,
    resource: STELE_OAUTH_RESOURCE,
    scope: STELE_OAUTH_SCOPE,
  });
  const serialized = JSON.stringify(status);
  for (const secret of [
    CLIENT_ID,
    TOKEN_A,
    TOKEN_B,
    "expiresAt",
    "clientId",
    "callback",
    "verifier",
    "challenge",
    "authorizationCode",
    "accessToken",
    "refreshToken",
  ]) assert.equal(serialized.includes(secret), false);
});

test("runtime revokes a rotated family and marks exact partial state when persistence fails", async () => {
  class PartialStore extends MemoryStore {
    fail = true;
    async write(value) {
      this.value = structuredClone(value);
      if (this.fail) {
        this.fail = false;
        throw new SteleOAuthCredentialStoreError("unavailable");
      }
      this.writes += 1;
    }
  }
  const store = new PartialStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revoked = [];
  const broker = new SteleOAuthSessionBroker({
    store,
    refresh: immediate,
    now: () => NOW,
    transport: {
      async refresh() { return tokens(TOKEN_C, TOKEN_D); },
      async revoke(value) { revoked.push(value); },
    },
  });
  await assert.rejects(broker.accessToken(), (error) => error.code === "unavailable");
  assert.deepEqual(revoked, [{ refreshToken: TOKEN_D, clientId: CLIENT_ID }]);
  assert.equal(store.value.sessionState, "reauth_required");
  assert.equal((await broker.status()).state, "reauth_required");
});

test("runtime revokes a successful refresh when local rotation construction fails", async () => {
  const store = new MemoryStore(record({
    tokens: { accessExpiresAt: NOW - 1, generation: Number.MAX_SAFE_INTEGER },
  }));
  const revoked = [];
  const broker = new SteleOAuthSessionBroker({
    store,
    refresh: immediate,
    now: () => NOW,
    transport: {
      async refresh() { return tokens(TOKEN_C, TOKEN_D); },
      async revoke(value) { revoked.push(value); },
    },
  });
  await assert.rejects(broker.accessToken(), (error) => error.code === "unavailable");
  assert.equal(revoked.length, 1);
  assert.equal(
    revoked.every((value) => value.refreshToken === TOKEN_D && value.clientId === CLIENT_ID),
    true,
  );
  assert.equal(store.value.sessionState, "reauth_required");
});

test("runtime rejects a rotated access token that collides with the prior generation", async () => {
  const store = new MemoryStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revoked = [];
  const broker = new SteleOAuthSessionBroker({
    store,
    refresh: immediate,
    now: () => NOW,
    transport: {
      async refresh() { return tokens(TOKEN_A, TOKEN_C); },
      async revoke(value) { revoked.push(value); },
    },
  });
  await assert.rejects(broker.accessToken(), (error) => error.code === "unavailable");
  assert.deepEqual(revoked, [{ refreshToken: TOKEN_C, clientId: CLIENT_ID }]);
  assert.equal(store.value.tokens.accessToken, TOKEN_A);
  assert.equal(store.value.tokens.refreshToken, TOKEN_B);
  assert.equal(store.value.sessionState, "reauth_required");
});

test("runtime retains a valid replacement for logout when commit and revocation both fail", async () => {
  class CommitFailStore extends MemoryStore {
    attempts = 0;
    async write(value) {
      this.attempts += 1;
      if (this.attempts === 1) {
        this.value = structuredClone(value);
        throw new SteleOAuthCredentialStoreError("unavailable");
      }
      return super.write(value);
    }
  }
  const store = new CommitFailStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revocations = [];
  const broker = new SteleOAuthSessionBroker({
    store,
    refresh: immediate,
    now: () => NOW,
    transport: {
      async refresh() { return tokens(TOKEN_C, TOKEN_D); },
      async revoke(value) { revocations.push(value); throw new Error("offline"); },
    },
  });
  await assert.rejects(broker.accessToken(), (error) => error.code === "unavailable");
  assert.equal(store.value.sessionState, "reauth_required");
  assert.equal(store.value.tokens.accessToken, TOKEN_C);
  assert.equal(store.value.tokens.refreshToken, TOKEN_D);
  assert.equal(store.value.tokens.generation, 2);

  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {}, async register() {}, async exchangeAuthorizationCode() {}, async refresh() {},
      async revoke(value) { revocations.push(value); },
    },
  });
  assert.equal((await admin.logout()).action, "logged_out");
  assert.deepEqual(revocations, [
    { refreshToken: TOKEN_D, clientId: CLIENT_ID },
    { refreshToken: TOKEN_D, clientId: CLIENT_ID },
  ]);
  assert.equal(store.value, null);
});

test("missing and locally expired credentials report auth-required states without network recovery", async () => {
  let calls = 0;
  const transport = new Proxy({}, { get() { return async () => { calls += 1; throw new Error("forbidden"); }; } });
  const absent = new SteleOAuthSessionBroker({ store: new MemoryStore(), transport, refresh: immediate, now: () => NOW });
  await assert.rejects(absent.accessToken(), (error) => error.code === "auth_required");
  assert.equal((await absent.status()).state, "signed_out");
  const expired = new SteleOAuthSessionBroker({
    store: new MemoryStore(record({ registration: { expiresAt: NOW / 1_000 } })),
    transport,
    refresh: immediate,
    now: () => NOW,
  });
  assert.equal((await expired.status()).state, "reauth_required");
  await assert.rejects(expired.accessToken(), (error) => error.code === "auth_required");
  assert.equal(calls, 0);
});

function loopbackFixture(callback, redirectUri = REDIRECT_URI) {
  let closed = false;
  return {
    loopback: {
      redirectUri,
      async waitForCallback() { closed = true; return callback; },
      async close() { closed = true; },
    },
    isClosed() { return closed; },
  };
}

test("interactive login binds loopback before DCR, verifies metadata, and exchanges only after listener closure", async () => {
  const events = [];
  const store = new MemoryStore();
  const fixture = loopbackFixture({ kind: "code", code: TOKEN_C });
  const protocol = {
    async verifyMetadata() { events.push("metadata"); },
    async register(uri) { events.push("register"); assert.equal(uri, REDIRECT_URI); return registration(uri); },
    async exchangeAuthorizationCode(input) {
      events.push("exchange");
      assert.equal(fixture.isClosed(), true);
      assert.deepEqual(input, { code: TOKEN_C, verifier: TOKEN_A, redirectUri: REDIRECT_URI, clientId: CLIENT_ID });
      return tokens();
    },
    async refresh() { throw new Error("not used"); },
    async revoke() { throw new Error("not used"); },
  };
  const admin = new SteleOAuthAdmin({
    store,
    protocol,
    refresh: immediate,
    now: () => NOW,
    async startLoopback() { events.push("listen"); return fixture.loopback; },
    async openBrowser(url) {
      events.push("browser");
      assert.equal(url.searchParams.get("scope"), STELE_OAUTH_SCOPE);
      assert.equal(url.searchParams.getAll("resource").length, 1);
    },
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  const result = await admin.login();
  assert.equal(result.action, "authenticated");
  assert.deepEqual(events, ["metadata", "listen", "register", "browser", "exchange"]);
  assert.equal(store.value.tokens.refreshToken, TOKEN_B);
});

test("interactive DCR timestamps and fixed client version are correlated before browser or persistence", async (t) => {
  const nowSeconds = NOW / 1_000;
  for (const fixture of [
    {
      name: "past-issued skew boundary",
      dcr: { client_id_issued_at: nowSeconds - 60, client_id_expires_at: nowSeconds + 3_600 },
      accepted: true,
    },
    {
      name: "past-issued beyond skew",
      dcr: { client_id_issued_at: nowSeconds - 61, client_id_expires_at: nowSeconds + 3_600 },
      accepted: false,
    },
    {
      name: "future-issued skew boundary",
      dcr: { client_id_issued_at: nowSeconds + 60, client_id_expires_at: nowSeconds + 3_600 },
      accepted: true,
    },
    {
      name: "future-issued beyond skew",
      dcr: { client_id_issued_at: nowSeconds + 61, client_id_expires_at: nowSeconds + 3_600 },
      accepted: false,
    },
    {
      name: "expiry must be strictly in the future",
      dcr: { client_id_issued_at: nowSeconds - 1, client_id_expires_at: nowSeconds },
      accepted: false,
    },
    {
      name: "one-second future expiry",
      dcr: { client_id_issued_at: nowSeconds, client_id_expires_at: nowSeconds + 1 },
      accepted: true,
    },
    {
      name: "maximum one-year registration lifetime",
      dcr: { client_id_issued_at: nowSeconds, client_id_expires_at: nowSeconds + 31_536_000 },
      accepted: true,
    },
    {
      name: "registration lifetime over one year",
      dcr: { client_id_issued_at: nowSeconds, client_id_expires_at: nowSeconds + 31_536_001 },
      accepted: false,
    },
    {
      name: "wrong fixed client version",
      dcr: { software_version: "0.3.1" },
      accepted: false,
    },
  ]) {
    await t.test(fixture.name, async () => {
      const store = new MemoryStore();
      let browsers = 0;
      let exchanges = 0;
      const admin = new SteleOAuthAdmin({
        store,
        refresh: immediate,
        now: () => NOW,
        protocol: {
          async verifyMetadata() {},
          async register(uri) { return { ...registration(uri), ...fixture.dcr }; },
          async exchangeAuthorizationCode() { exchanges += 1; return tokens(); },
          async refresh() { throw new Error("not used"); },
          async revoke() { throw new Error("not used"); },
        },
        async startLoopback() {
          return loopbackFixture({ kind: "code", code: TOKEN_C }).loopback;
        },
        async openBrowser() { browsers += 1; },
        createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
      });
      if (fixture.accepted) {
        assert.equal((await admin.login()).action, "authenticated");
        assert.equal(browsers, 1);
        assert.equal(exchanges, 1);
        assert.equal(store.writes, 1);
      } else {
        await assert.rejects(
          admin.login(),
          (error) => safeSteleOAuthAdminErrorCode(error) === "unavailable",
        );
        assert.equal(browsers, 0);
        assert.equal(exchanges, 0);
        assert.equal(store.writes, 0);
        assert.equal(store.value, null);
      }
    });
  }
});

test("interactive replacement aborts without changing retained credentials when prior-family revocation fails", async (t) => {
  for (const fixture of [
    {
      name: "invalid_scope refresh response",
      value: record({ tokens: { accessExpiresAt: NOW - 1 } }),
      refreshExpected: true,
    },
    {
      name: "preexisting reauthentication state",
      value: record({ sessionState: "reauth_required" }),
      refreshExpected: false,
    },
    {
      name: "expired client registration",
      value: record({
        registration: { issuedAt: NOW / 1_000 - 86_400, expiresAt: NOW / 1_000 },
      }),
      refreshExpected: false,
    },
  ]) {
    await t.test(fixture.name, async () => {
      const store = new MemoryStore(fixture.value);
      const exactPrior = structuredClone(store.value);
      let refreshes = 0;
      let registrations = 0;
      let listeners = 0;
      const revoked = [];
      const admin = new SteleOAuthAdmin({
        store,
        refresh: immediate,
        now: () => NOW,
        protocol: {
          async verifyMetadata() {},
          async refresh() {
            refreshes += 1;
            throw new SteleOAuthHttpError("protocol", "invalid_scope");
          },
          async revoke(value) {
            revoked.push(value);
            throw new SteleOAuthHttpError("unavailable");
          },
          async register() { registrations += 1; throw new Error("must not register"); },
          async exchangeAuthorizationCode() { throw new Error("must not exchange"); },
        },
        async startLoopback() { listeners += 1; throw new Error("must not listen"); },
      });
      await assert.rejects(admin.login(), (error) => error.code === "unavailable");
      assert.equal(refreshes, fixture.refreshExpected ? 1 : 0);
      assert.equal(registrations, 0);
      assert.equal(listeners, 0);
      assert.equal(store.writes, 0);
      assert.deepEqual(store.value, exactPrior);
      assert.deepEqual(revoked, [{ refreshToken: TOKEN_B, clientId: CLIENT_ID }]);
    });
  }
});

test("successful prior-family revocation happens before interactive replacement", async () => {
  const store = new MemoryStore(record({ sessionState: "reauth_required" }));
  const events = [];
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() { events.push("metadata"); },
      async revoke(value) {
        events.push("revoke");
        assert.deepEqual(value, { refreshToken: TOKEN_B, clientId: CLIENT_ID });
      },
      async register(uri) { events.push("register"); return registration(uri); },
      async exchangeAuthorizationCode() { events.push("exchange"); return tokens(TOKEN_C, TOKEN_D); },
      async refresh() { throw new Error("must not refresh"); },
    },
    async startLoopback() {
      events.push("listen");
      return loopbackFixture({ kind: "code", code: TOKEN_A }).loopback;
    },
    async openBrowser() { events.push("browser"); },
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  assert.equal((await admin.login()).action, "authenticated");
  assert.deepEqual(events, ["metadata", "revoke", "listen", "register", "browser", "exchange"]);
  assert.equal(store.value.tokens.accessToken, TOKEN_C);
  assert.equal(store.value.tokens.refreshToken, TOKEN_D);
});

test("interactive admin performs at most one fresh-registration invalid_client recovery", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  let registrations = 0;
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {},
      async register(uri) { registrations += 1; return registration(uri); },
      async exchangeAuthorizationCode() {
        attempts += 1;
        if (attempts === 1) throw new SteleOAuthHttpError("protocol", "invalid_client");
        return tokens();
      },
      async refresh() { throw new Error("not used"); },
      async revoke() { throw new Error("not used"); },
    },
    async startLoopback() { return loopbackFixture({ kind: "code", code: TOKEN_C }).loopback; },
    async openBrowser() {},
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  assert.equal((await admin.login()).action, "authenticated");
  assert.equal(attempts, 2);
  assert.equal(registrations, 2);
});

test("admin rejects a rotated token that collides with the prior generation", async () => {
  const store = new MemoryStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revoked = [];
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {},
      async refresh() { return tokens(TOKEN_A, TOKEN_C); },
      async revoke(value) { revoked.push(value); },
      async register() { throw new Error("must not register"); },
      async exchangeAuthorizationCode() { throw new Error("must not exchange"); },
    },
  });
  await assert.rejects(admin.login(), (error) => error.code === "credential_store_unavailable");
  assert.deepEqual(revoked, [{ refreshToken: TOKEN_C, clientId: CLIENT_ID }]);
  assert.equal(store.value.tokens.accessToken, TOKEN_A);
  assert.equal(store.value.tokens.refreshToken, TOKEN_B);
  assert.equal(store.value.sessionState, "reauth_required");
});

test("admin refresh retains a valid replacement for logout when commit and revocation both fail", async () => {
  class CommitFailStore extends MemoryStore {
    attempts = 0;
    async write(value) {
      this.attempts += 1;
      if (this.attempts === 1) throw new SteleOAuthCredentialStoreError("unavailable");
      return super.write(value);
    }
  }
  const store = new CommitFailStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revocations = [];
  let revocationFails = true;
  const protocol = {
    async verifyMetadata() {},
    async refresh() { return tokens(TOKEN_C, TOKEN_D); },
    async revoke(value) {
      revocations.push(value);
      if (revocationFails) throw new SteleOAuthHttpError("unavailable");
    },
    async register() { throw new Error("must not register"); },
    async exchangeAuthorizationCode() { throw new Error("must not exchange"); },
  };
  const admin = new SteleOAuthAdmin({ store, protocol, refresh: immediate, now: () => NOW });
  await assert.rejects(admin.login(), (error) => error.code === "credential_store_unavailable");
  assert.equal(store.value.sessionState, "reauth_required");
  assert.equal(store.value.tokens.accessToken, TOKEN_C);
  assert.equal(store.value.tokens.refreshToken, TOKEN_D);
  assert.equal(store.value.tokens.generation, 2);

  revocationFails = false;
  assert.equal((await admin.logout()).action, "logged_out");
  assert.deepEqual(revocations, [
    { refreshToken: TOKEN_D, clientId: CLIENT_ID },
    { refreshToken: TOKEN_D, clientId: CLIENT_ID },
  ]);
});

test("interactive login retains a newly issued family when commit and revocation both fail", async () => {
  class CommitFailStore extends MemoryStore {
    attempts = 0;
    async write(value) {
      this.attempts += 1;
      if (this.attempts === 1) throw new SteleOAuthCredentialStoreError("unavailable");
      return super.write(value);
    }
  }
  const store = new CommitFailStore();
  const revocations = [];
  let revocationFails = true;
  const protocol = {
    async verifyMetadata() {},
    async register(uri) { return registration(uri); },
    async exchangeAuthorizationCode() { return tokens(); },
    async refresh() { throw new Error("must not refresh"); },
    async revoke(value) {
      revocations.push(value);
      if (revocationFails) throw new SteleOAuthHttpError("unavailable");
    },
  };
  const admin = new SteleOAuthAdmin({
    store,
    protocol,
    refresh: immediate,
    now: () => NOW,
    async startLoopback() { return loopbackFixture({ kind: "code", code: TOKEN_C }).loopback; },
    async openBrowser() {},
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  await assert.rejects(admin.login(), (error) => error.code === "credential_store_unavailable");
  assert.equal(store.value.sessionState, "reauth_required");
  assert.equal(store.value.tokens.accessToken, TOKEN_A);
  assert.equal(store.value.tokens.refreshToken, TOKEN_B);

  revocationFails = false;
  assert.equal((await admin.logout()).action, "logged_out");
  assert.deepEqual(revocations, [
    { refreshToken: TOKEN_B, clientId: CLIENT_ID },
    { refreshToken: TOKEN_B, clientId: CLIENT_ID },
  ]);
});

test("interactive login revokes a refresh rotation and marks reauth when its write fails", async () => {
  class PartialStore extends MemoryStore {
    fail = true;
    async write(value) {
      this.value = structuredClone(value);
      if (this.fail) {
        this.fail = false;
        throw new SteleOAuthCredentialStoreError("unavailable");
      }
      this.writes += 1;
    }
  }
  const store = new PartialStore(record({ tokens: { accessExpiresAt: NOW - 1 } }));
  const revoked = [];
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {},
      async register() { throw new Error("interactive must not start after a store failure"); },
      async exchangeAuthorizationCode() { throw new Error("not used"); },
      async refresh() { return tokens(TOKEN_C, TOKEN_D); },
      async revoke(value) { revoked.push(value); },
    },
  });
  await assert.rejects(admin.login(), (error) => error.code === "credential_store_unavailable");
  assert.deepEqual(revoked, [{ refreshToken: TOKEN_D, clientId: CLIENT_ID }]);
  assert.equal(store.value.sessionState, "reauth_required");
});

test("a failed credential write revokes the newly issued token family and removes only exact partial state", async () => {
  class PartialStore extends MemoryStore {
    async write(value) { this.value = structuredClone(value); throw new SteleOAuthCredentialStoreError("unavailable"); }
  }
  const store = new PartialStore();
  const revoked = [];
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {},
      async register(uri) { return registration(uri); },
      async exchangeAuthorizationCode() { return tokens(); },
      async refresh() { throw new Error("not used"); },
      async revoke(value) { revoked.push(value); },
    },
    async startLoopback() { return loopbackFixture({ kind: "code", code: TOKEN_C }).loopback; },
    async openBrowser() {},
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  await assert.rejects(admin.login(), (error) => safeSteleOAuthAdminErrorCode(error) === "credential_store_unavailable");
  assert.deepEqual(revoked, [{ refreshToken: TOKEN_B, clientId: CLIENT_ID }]);
  assert.equal(store.value, null);
});

test("interactive exchange revokes its token family when local record construction fails", async () => {
  const store = new MemoryStore();
  const revoked = [];
  let nowCalls = 0;
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now() { nowCalls += 1; return nowCalls <= 2 ? NOW : Number.MAX_SAFE_INTEGER; },
    protocol: {
      async verifyMetadata() {},
      async register(uri) { return registration(uri); },
      async exchangeAuthorizationCode() { return tokens(); },
      async refresh() { throw new Error("not used"); },
      async revoke(value) { revoked.push(value); },
    },
    async startLoopback() { return loopbackFixture({ kind: "code", code: TOKEN_C }).loopback; },
    async openBrowser() {},
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  await assert.rejects(
    admin.login(),
    (error) => safeSteleOAuthAdminErrorCode(error) === "credential_store_unavailable",
  );
  assert.equal(revoked.length, 1);
  assert.equal(
    revoked.every((value) => value.refreshToken === TOKEN_B && value.clientId === CLIENT_ID),
    true,
  );
  assert.equal(store.value, null);
});

test("browser-launch failure closes and observes the pending callback rejection", async () => {
  let rejectCallback;
  let closed = false;
  const pending = new Promise((_resolve, reject) => { rejectCallback = reject; });
  const admin = new SteleOAuthAdmin({
    store: new MemoryStore(),
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {},
      async register(uri) { return registration(uri); },
      async exchangeAuthorizationCode() { throw new Error("not used"); },
      async refresh() { throw new Error("not used"); },
      async revoke() { throw new Error("not used"); },
    },
    async startLoopback() {
      return {
        redirectUri: REDIRECT_URI,
        waitForCallback() { return pending; },
        async close() { closed = true; rejectCallback(new Error("closed callback sentinel")); },
      };
    },
    async openBrowser() { throw new Error("browser sentinel"); },
    createPkce() { return { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_D }; },
  });
  await assert.rejects(admin.login(), (error) => error.code === "unavailable");
  assert.equal(closed, true);
  await new Promise((resolve) => setImmediate(resolve));
});

test("logout deletes only after accepted revocation and preserves the credential on failure", async () => {
  const store = new MemoryStore(record());
  let fail = true;
  const events = [];
  const admin = new SteleOAuthAdmin({
    store,
    refresh: immediate,
    now: () => NOW,
    protocol: {
      async verifyMetadata() {}, async register() {}, async exchangeAuthorizationCode() {}, async refresh() {},
      async revoke(value) { events.push(["revoke", value]); if (fail) throw new SteleOAuthHttpError("unavailable"); },
    },
  });
  await assert.rejects(admin.logout(), (error) => error.code === "unavailable");
  assert.notEqual(store.value, null);
  assert.equal(store.deletes, 0);
  fail = false;
  assert.equal((await admin.logout()).action, "logged_out");
  assert.equal(store.value, null);
  assert.equal(store.deletes, 1);
  assert.equal(events.length, 2);
});

function cliIo(tty = true) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: { isTTY: tty },
      stdout: { isTTY: tty, write(value) { stdout += String(value); return true; } },
      stderr: { isTTY: tty, write(value) { stderr += String(value); return true; } },
    },
    output() { return { stdout, stderr }; },
  };
}

test("CLI requires a real TTY for login/logout, accepts piped status, and never prints credential fields", async () => {
  let loads = 0;
  const loadAdmin = async () => {
    loads += 1;
    return {
      async createDefaultSteleOAuthAdmin() {
        return {
          async login() { throw new Error("not used"); },
          async logout() { throw new Error("not used"); },
          async status() {
            return {
              action: "none",
              session: { state: "authenticated", issuer: STELE_OAUTH_ISSUER, resource: STELE_OAUTH_RESOURCE, scope: STELE_OAUTH_SCOPE },
              clientId: CLIENT_ID,
              accessToken: TOKEN_A,
            };
          },
        };
      },
      safeSteleOAuthAdminErrorCode,
    };
  };
  assert.equal(await runSteleOAuthCli(["login"], cliIo(false).io, { loadAdmin }), 2);
  assert.equal(loads, 0);
  const status = cliIo(false);
  assert.equal(await runSteleOAuthCli(["status"], status.io, { loadAdmin }), 0);
  const output = JSON.stringify(status.output());
  assert.equal(output.includes("authenticated"), true);
  assert.equal(output.includes(CLIENT_ID), false);
  assert.equal(output.includes(TOKEN_A), false);
  assert.equal(await runSteleOAuthCli(["status", `--token=${TOKEN_A}`], cliIo().io, { loadAdmin }), 2);
  assert.equal(loads, 1);
});

test("CLI logout requires an exact confirmation and raw failures remain redacted", async () => {
  const cancelled = cliIo();
  let loads = 0;
  assert.equal(await runSteleOAuthCli(["logout"], cancelled.io, {
    async confirm() { return "yes"; },
    async loadAdmin() { loads += 1; throw new Error("must not load"); },
  }), 2);
  assert.equal(loads, 0);

  const failed = cliIo();
  const sentinel = `secret ${TOKEN_A} /home/private`;
  assert.equal(await runSteleOAuthCli(["logout"], failed.io, {
    async confirm() { return "LOG OUT STELE"; },
    async loadAdmin() {
      return {
        async createDefaultSteleOAuthAdmin() {
          return { async logout() { throw new Error(sentinel); } };
        },
        safeSteleOAuthAdminErrorCode,
      };
    },
  }), 1);
  assert.equal(JSON.stringify(failed.output()).includes(sentinel), false);
});

test("runtime OAuth graph is recursively isolated from admin, custody, crypto, signing, and submission", async () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(SteleOAuthRuntimeHttpClient.prototype).sort(),
    ["constructor", "refresh", "revoke"],
  );
  const entry = fileURLToPath(new URL("../../dist/stele/oauth-session-broker.js", import.meta.url));
  const graph = await localModuleGraph(entry);
  for (const forbidden of [
    "oauth-http.js",
    "oauth-admin.js",
    "oauth-browser.js",
    "oauth-cli.js",
    "oauth-loopback.js",
    "agent-wallet-admin.js",
    "agent-keystore.js",
    "os-credential-store.js",
    "wallet.js",
    "outbox.js",
    "connectors.js",
  ]) {
    assert.equal([...graph].some((path) => path.endsWith(`/${forbidden}`)), false, `runtime reaches ${forbidden}`);
  }
  for (const path of graph) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("@monolythium/core-sdk"), false, `${path} reaches the SDK`);
    assert.equal(/(?:sign|submit|broadcast)(?:Transaction|Payload)?\s*\(/iu.test(source), false, `${path} exposes execution`);
  }
  const runtimeTransport = await readFile(
    fileURLToPath(new URL("../../dist/stele/oauth-runtime-http.js", import.meta.url)),
    "utf8",
  );
  for (const forbiddenCapability of [
    "verifyMetadata",
    "register(redirectUri",
    "exchangeAuthorizationCode",
    "authorization_code",
  ]) {
    assert.equal(runtimeTransport.includes(forbiddenCapability), false);
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
