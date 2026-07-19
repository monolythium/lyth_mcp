import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  STELE_OAUTH_ENDPOINTS,
  STELE_OAUTH_ISSUER,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
  buildSteleAuthorizationUrl,
  createSteleOAuthPkce,
} from "../../dist/stele/oauth-contract.js";
import {
  browserCommand,
  openSteleAuthorizationInBrowser,
} from "../../dist/stele/oauth-browser.js";
import {
  SteleOAuthHttpClient,
  SteleOAuthHttpError,
} from "../../dist/stele/oauth-http.js";
import { SteleOAuthRuntimeHttpClient } from "../../dist/stele/oauth-runtime-http.js";
import {
  SteleOAuthLoopbackError,
  startSteleOAuthLoopback,
} from "../../dist/stele/oauth-loopback.js";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "C".repeat(43);
const PKCE_CHALLENGE_A = createHash("sha256").update(TOKEN_A, "ascii").digest("base64url");
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const NONCANONICAL_PKCE_CHALLENGE_A = `${PKCE_CHALLENGE_A.slice(0, -1)}${
  BASE64URL_ALPHABET[BASE64URL_ALPHABET.indexOf(PKCE_CHALLENGE_A.at(-1)) + 1]
}`;
const CLIENT_ID = `stc_${"D".repeat(32)}`;
const CALLBACK_ID = "E".repeat(43);
const REDIRECT_URI = `http://127.0.0.1:39147/callback/${CALLBACK_ID}`;

const serverMetadata = {
  issuer: STELE_OAUTH_ISSUER,
  authorization_endpoint: STELE_OAUTH_ENDPOINTS.authorize,
  token_endpoint: STELE_OAUTH_ENDPOINTS.token,
  registration_endpoint: STELE_OAUTH_ENDPOINTS.register,
  revocation_endpoint: STELE_OAUTH_ENDPOINTS.revoke,
  introspection_endpoint: STELE_OAUTH_ENDPOINTS.introspect,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["stele:public:read", "stele:drafts:write"],
};
const resourceMetadata = {
  resource: STELE_OAUTH_RESOURCE,
  authorization_servers: [STELE_OAUTH_ISSUER],
  scopes_supported: ["stele:public:read", "stele:drafts:write"],
  bearer_methods_supported: ["header"],
};
const registration = {
  redirect_uris: [REDIRECT_URI],
  application_type: "native",
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "Lyth Stele MCP",
  scope: STELE_OAUTH_SCOPE,
  software_id: "com.monolythium.lyth-mcp.stele",
  software_version: "0.3.0",
  client_id: CLIENT_ID,
  client_id_issued_at: 1_700_000_000,
  client_id_expires_at: 1_700_086_400,
};
const tokenResponse = {
  access_token: TOKEN_A,
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: TOKEN_B,
  scope: STELE_OAUTH_SCOPE,
};

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function responseAt(response, url) {
  Object.defineProperty(response, "url", { configurable: true, value: String(url) });
  return response;
}

function assertExactForm(body, expected) {
  assert.equal(typeof body, "string");
  const parameters = new URLSearchParams(body);
  const keys = [...parameters.keys()];
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(parameters.getAll(key), [value]);
  }
}

test("PKCE is canonical S256 and the authorization request has one exact pinned tuple", () => {
  const pkce = createSteleOAuthPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    pkce.challenge,
    createHash("sha256").update(pkce.verifier, "ascii").digest("base64url"),
  );
  assert.match(pkce.state, /^[A-Za-z0-9_-]{43}$/u);

  const url = buildSteleAuthorizationUrl(
    registration,
    REDIRECT_URI,
    { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_C },
  );
  assert.equal(url.origin, STELE_OAUTH_ISSUER);
  assert.equal(url.pathname, "/oauth/authorize");
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "resource",
    "response_type",
    "scope",
    "state",
  ]);
  assert.equal(url.searchParams.getAll("resource").length, 1);
  assert.equal(url.searchParams.get("resource"), STELE_OAUTH_RESOURCE);
  assert.equal(url.searchParams.get("scope"), STELE_OAUTH_SCOPE);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.throws(
    () => buildSteleAuthorizationUrl(
      registration,
      REDIRECT_URI,
      { verifier: TOKEN_A, challenge: TOKEN_B, state: TOKEN_C },
    ),
    /PKCE challenge mismatch/u,
  );
  assert.deepEqual(
    Buffer.from(NONCANONICAL_PKCE_CHALLENGE_A, "base64url"),
    Buffer.from(PKCE_CHALLENGE_A, "base64url"),
  );
  assert.throws(
    () => buildSteleAuthorizationUrl(
      registration,
      REDIRECT_URI,
      {
        verifier: TOKEN_A,
        challenge: NONCANONICAL_PKCE_CHALLENGE_A,
        state: TOKEN_C,
      },
    ),
    /PKCE challenge mismatch/u,
  );

  let clientIdReads = 0;
  const changingRegistration = new Proxy(registration, {
    get(target, property, receiver) {
      if (property === "client_id") {
        clientIdReads += 1;
        return clientIdReads === 1 ? CLIENT_ID : "attacker";
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const parsedUrl = buildSteleAuthorizationUrl(
    changingRegistration,
    REDIRECT_URI,
    { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_C },
  );
  assert.equal(parsedUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(clientIdReads, 1);
});

test("loopback redirect registration rejects noncanonical URL spellings", () => {
  const noncanonical = `http://127.0.0.1:039147/callback/${CALLBACK_ID}`;
  assert.throws(() => buildSteleAuthorizationUrl(
    { ...registration, redirect_uris: [noncanonical] },
    noncanonical,
    { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_C },
  ));
});

test("the HTTP boundary verifies exact metadata and emits strict native public-client shapes", async () => {
  const calls = [];
  const client = new SteleOAuthHttpClient({
    clientVersion: "0.3.0",
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init });
      if (url === STELE_OAUTH_ENDPOINTS.metadata) return responseAt(json({ ...serverMetadata, metadata_extension: true }), url);
      if (url === STELE_OAUTH_ENDPOINTS.protectedResource) return responseAt(json({ ...resourceMetadata, resource_extension: true }), url);
      if (url === STELE_OAUTH_ENDPOINTS.register) return responseAt(json({ ...registration, registration_extension: "ignored" }, 201), url);
      if (url === STELE_OAUTH_ENDPOINTS.token) return responseAt(json({ ...tokenResponse, token_extension: "ignored" }), url);
      if (url === STELE_OAUTH_ENDPOINTS.revoke) {
        return responseAt(new Response(null, { status: 200, headers: { "cache-control": "no-store" } }), url);
      }
      throw new Error("unexpected URL");
    },
  });

  await client.verifyMetadata();
  assert.deepEqual(await client.register(REDIRECT_URI), registration);
  assert.deepEqual(
    await client.exchangeAuthorizationCode({
      code: TOKEN_C,
      verifier: TOKEN_A,
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
    }),
    tokenResponse,
  );
  assert.deepEqual(
    await client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    tokenResponse,
  );
  await client.revoke({ refreshToken: TOKEN_B, clientId: CLIENT_ID });

  const registrationCall = calls.find(({ url }) => url === STELE_OAUTH_ENDPOINTS.register);
  assert.deepEqual(JSON.parse(registrationCall.init.body), {
    redirect_uris: [REDIRECT_URI],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Lyth Stele MCP",
    scope: STELE_OAUTH_SCOPE,
    software_id: "com.monolythium.lyth-mcp.stele",
    software_version: "0.3.0",
  });
  for (const { init } of calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(new Headers(init.headers).has("authorization"), false);
  }
  const tokenCalls = calls.filter(({ url }) => url === STELE_OAUTH_ENDPOINTS.token);
  assert.equal(tokenCalls.length, 2);
  assertExactForm(tokenCalls[0].init.body, {
    grant_type: "authorization_code",
    code: TOKEN_C,
    code_verifier: TOKEN_A,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    resource: STELE_OAUTH_RESOURCE,
  });
  assertExactForm(tokenCalls[1].init.body, {
    grant_type: "refresh_token",
    refresh_token: TOKEN_B,
    client_id: CLIENT_ID,
    resource: STELE_OAUTH_RESOURCE,
    scope: STELE_OAUTH_SCOPE,
  });
  const revocationCall = calls.find(({ url }) => url === STELE_OAUTH_ENDPOINTS.revoke);
  assertExactForm(revocationCall.init.body, {
    token: TOKEN_B,
    client_id: CLIENT_ID,
    token_type_hint: "refresh_token",
  });
});

test("admin and runtime HTTP token boundaries reject identical access and refresh tokens", async () => {
  for (const Client of [SteleOAuthHttpClient, SteleOAuthRuntimeHttpClient]) {
    const client = new Client({
      async fetchImpl(url) {
        return responseAt(json({
          ...tokenResponse,
          access_token: TOKEN_A,
          refresh_token: TOKEN_A,
        }), url);
      },
    });
    await assert.rejects(
      client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
      (error) => error.code === "boundary",
    );
  }
});

test("HTTP construction accepts only canonical numeric semantic client versions", () => {
  assert.doesNotThrow(() => new SteleOAuthHttpClient({ clientVersion: "0.3.0" }));
  assert.doesNotThrow(() => new SteleOAuthRuntimeHttpClient({ clientVersion: "0.3.0" }));
  for (const clientVersion of ["", "v0.3.0", "00.3.0", "0.03.0", "0.3", "0.3.0+local", "0.3.0-beta"]) {
    assert.throws(
      () => new SteleOAuthHttpClient({ clientVersion }),
      (error) => error instanceof SteleOAuthHttpError && error.code === "boundary",
    );
    assert.throws(
      () => new SteleOAuthRuntimeHttpClient({ clientVersion }),
      (error) => error.code === "boundary",
    );
  }
});

test("HTTP inputs are validated before serialization and no arbitrary origin can be supplied", async () => {
  let calls = 0;
  const client = new SteleOAuthHttpClient({
    async fetchImpl() { calls += 1; throw new Error("must not fetch"); },
  });
  await assert.rejects(
    client.register("http://localhost:1234/callback"),
    (error) => error instanceof SteleOAuthHttpError && error.code === "boundary",
  );
  await assert.rejects(
    client.exchangeAuthorizationCode({
      code: "short",
      verifier: TOKEN_A,
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
    }),
    (error) => error.code === "boundary",
  );
  await assert.rejects(
    client.refresh({ refreshToken: TOKEN_B, clientId: "attacker" }),
    (error) => error.code === "boundary",
  );
  await assert.rejects(
    client.revoke({ refreshToken: "https://attacker.invalid", clientId: CLIENT_ID }),
    (error) => error.code === "boundary",
  );
  assert.equal(calls, 0);
});

test("protocol errors retain only their machine code and response policy failures collapse safely", async () => {
  const sentinel = "raw server description with token secret";
  const invalidClient = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      return responseAt(json({ error: "invalid_client", error_description: sentinel, error_extension: "ignored" }, 400), url);
    },
  });
  await assert.rejects(
    invalidClient.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    (error) => {
      assert.equal(error.code, "protocol");
      assert.equal(error.protocolCode, "invalid_client");
      assert.equal(String(error).includes(sentinel), false);
      return true;
    },
  );

  for (const response of [
    json(tokenResponse, 200, { "cache-control": "max-age=60" }),
    json(tokenResponse, 200, { "cache-control": "no-store, public" }),
    json(tokenResponse, 200, { "cache-control": "no-store, max-age=60" }),
    json(tokenResponse, 200, { "content-encoding": "gzip" }),
    new Response("redirect", { status: 302, headers: { location: "https://attacker.invalid", "cache-control": "no-store" } }),
    json(tokenResponse, 200, { "content-length": "999999" }),
  ]) {
    const client = new SteleOAuthHttpClient({ async fetchImpl(url) { return responseAt(response, url); } });
    await assert.rejects(
      client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
      (error) => error.code === "boundary",
    );
  }
});

test("DCR correlates the configured software version and approved duplicate no-store directives", async () => {
  const mismatched = new SteleOAuthHttpClient({
    clientVersion: "0.3.0",
    async fetchImpl(url) { return responseAt(json({ ...registration, software_version: "9.9.9" }, 201), url); },
  });
  await assert.rejects(mismatched.register(REDIRECT_URI), (error) => error.code === "boundary");

  const duplicateNoStore = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      return responseAt(json(tokenResponse, 200, { "cache-control": "no-store, no-store, max-age=0" }), url);
    },
  });
  assert.deepEqual(
    await duplicateNoStore.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    tokenResponse,
  );
});

test("discovery and token responses require a nonempty exact transport URL", async () => {
  for (const mode of ["empty", "mismatch"]) {
    const tokenClient = new SteleOAuthHttpClient({
      async fetchImpl() {
        const response = json(tokenResponse);
        return mode === "empty" ? response : responseAt(response, "https://attacker.invalid/oauth/token");
      },
    });
    await assert.rejects(
      tokenClient.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
      (error) => error.code === "boundary",
    );

    const discoveryClient = new SteleOAuthHttpClient({
      async fetchImpl(url) {
        const response = json(
          url === STELE_OAUTH_ENDPOINTS.metadata ? serverMetadata : resourceMetadata,
        );
        if (url !== STELE_OAUTH_ENDPOINTS.metadata) return responseAt(response, url);
        return mode === "empty" ? response : responseAt(response, "https://attacker.invalid/metadata");
      },
    });
    await assert.rejects(discoveryClient.verifyMetadata(), (error) => error.code === "boundary");
  }
});

test("one deadline covers a streamed body even when a custom body and cancellation ignore abort", async () => {
  const never = new ReadableStream({
    pull() { return new Promise(() => undefined); },
    cancel() { return new Promise(() => undefined); },
  });
  const client = new SteleOAuthHttpClient({
    timeoutMs: 100,
    async fetchImpl(url) {
      return responseAt(new Response(never, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }), url);
    },
  });
  const started = Date.now();
  await assert.rejects(
    client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    (error) => error.code === "unavailable",
  );
  assert.equal(Date.now() - started < 1_000, true);
});

test("a stream chunk delivered after timeout is wiped before it is discarded", async () => {
  for (const request of [
    (client) => client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    (client) => client.exchangeAuthorizationCode({
      code: TOKEN_C,
      verifier: TOKEN_A,
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
    }),
  ]) {
    const late = new TextEncoder().encode(JSON.stringify(tokenResponse));
    let resolveRead;
    const reader = {
      read() { return new Promise((resolve) => { resolveRead = resolve; }); },
      cancel() { return new Promise(() => undefined); },
      releaseLock() {},
    };
    const client = new SteleOAuthHttpClient({
      timeoutMs: 100,
      async fetchImpl(url) {
        return {
          body: { getReader() { return reader; }, cancel() { return Promise.resolve(); } },
          headers: new Headers({ "cache-control": "no-store", "content-type": "application/json" }),
          redirected: false,
          status: 200,
          url: String(url),
        };
      },
    });
    await assert.rejects(request(client), (error) => error.code === "unavailable");
    resolveRead({ done: false, value: late });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(late.every((value) => value === 0), true);
  }
});

test("declared lengths must equal decoded bytes and consumed token chunks are wiped", async () => {
  const wrongLength = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      return responseAt(json(tokenResponse, 200, { "content-length": "1" }), url);
    },
  });
  await assert.rejects(
    wrongLength.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
    (error) => error.code === "boundary",
  );

  const bytes = new TextEncoder().encode(JSON.stringify(tokenResponse));
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  const wiping = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      return responseAt(new Response(stream, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(bytes.length),
          "content-type": "application/json",
        },
      }), url);
    },
  });
  assert.deepEqual(await wiping.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }), tokenResponse);
  assert.equal(bytes.every((value) => value === 0), true);
});

test("zero-byte and excessive-chunk response streams are bounded", async () => {
  const streams = [
    new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(0)); controller.close(); },
    }),
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < 4_097; index += 1) controller.enqueue(Uint8Array.of(0x20));
        controller.close();
      },
    }),
  ];
  for (const stream of streams) {
    const client = new SteleOAuthHttpClient({
      async fetchImpl(url) {
        return responseAt(new Response(stream, {
          status: 200,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }), url);
      },
    });
    await assert.rejects(
      client.refresh({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
      (error) => error.code === "boundary",
    );
  }
});

test("revocation accepts only an exactly empty no-store 200 response", async () => {
  for (const body of ["{}", " "]) {
    const client = new SteleOAuthHttpClient({
      async fetchImpl(url) {
        return responseAt(new Response(body, { status: 200, headers: { "cache-control": "no-store" } }), url);
      },
    });
    await assert.rejects(
      client.revoke({ refreshToken: TOKEN_B, clientId: CLIENT_ID }),
      (error) => error.code === "boundary",
    );
  }
  const accepted = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      return responseAt(new Response(null, { status: 200, headers: { "cache-control": "no-store" } }), url);
    },
  });
  await accepted.revoke({ refreshToken: TOKEN_B, clientId: CLIENT_ID });
});

test("metadata tuples, order, keys, and origins are fail-closed", async () => {
  const client = new SteleOAuthHttpClient({
    async fetchImpl(url) {
      if (url === STELE_OAUTH_ENDPOINTS.metadata) {
        return responseAt(json({ ...serverMetadata, scopes_supported: [...serverMetadata.scopes_supported].reverse() }), url);
      }
      return responseAt(json(resourceMetadata), url);
    },
  });
  await assert.rejects(client.verifyMetadata(), (error) => error.code === "boundary");
});

test("the loopback uses a literal ephemeral IPv4 listener and closes before yielding one code", async () => {
  const loopback = await startSteleOAuthLoopback({ timeoutMs: 2_000, callbackId: CALLBACK_ID });
  const parsed = new URL(loopback.redirectUri);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.match(parsed.port, /^[1-9][0-9]{0,4}$/u);
  assert.equal(parsed.pathname, `/callback/${CALLBACK_ID}`);
  const waiting = loopback.waitForCallback(TOKEN_A);
  const response = await fetch(`${loopback.redirectUri}?code=${TOKEN_B}&state=${TOKEN_A}`, {
    redirect: "error",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await waiting, { kind: "code", code: TOKEN_B });
  await assert.rejects(fetch(loopback.redirectUri));
});

test("wrong state consumes the single callback and cannot be replayed", async () => {
  const loopback = await startSteleOAuthLoopback({ timeoutMs: 2_000, callbackId: CALLBACK_ID });
  const waiting = loopback.waitForCallback(TOKEN_A);
  void waiting.catch(() => undefined);
  const response = await fetch(`${loopback.redirectUri}?code=${TOKEN_B}&state=${TOKEN_C}`);
  assert.equal(response.status, 400);
  await assert.rejects(waiting, (error) => error.code === "invalid_callback");
  await assert.rejects(fetch(`${loopback.redirectUri}?code=${TOKEN_B}&state=${TOKEN_A}`));
});

test("absolute-form proxy request targets are rejected even at the exact loopback origin", async () => {
  const loopback = await startSteleOAuthLoopback({ timeoutMs: 2_000, callbackId: CALLBACK_ID });
  const waiting = loopback.waitForCallback(TOKEN_A);
  void waiting.catch(() => undefined);
  const target = new URL(loopback.redirectUri);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: Number(target.port),
      method: "GET",
      path: `${target.origin}${target.pathname}?code=${TOKEN_B}&state=${TOKEN_A}`,
      headers: { host: target.host, connection: "close" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(status, 400);
  await assert.rejects(waiting, (error) => error.code === "invalid_callback");
});

test("denial is correlated, descriptions are not reflected, and timeout is bounded", async () => {
  const denied = await startSteleOAuthLoopback({ timeoutMs: 2_000, callbackId: CALLBACK_ID });
  const waiting = denied.waitForCallback(TOKEN_A);
  const response = await fetch(
    `${denied.redirectUri}?error=access_denied&error_description=${encodeURIComponent("private wallet text")}&state=${TOKEN_A}`,
  );
  assert.equal((await response.text()).includes("private wallet text"), false);
  assert.deepEqual(await waiting, { kind: "error", error: "access_denied" });

  const timed = await startSteleOAuthLoopback({ timeoutMs: 50, callbackId: CALLBACK_ID });
  await assert.rejects(
    timed.waitForCallback(TOKEN_A),
    (error) => error instanceof SteleOAuthLoopbackError && error.code === "timeout",
  );
});

test("browser launching is shell-free and rejects altered or duplicated authorization queries", async () => {
  const url = buildSteleAuthorizationUrl(
    registration,
    REDIRECT_URI,
    { verifier: TOKEN_A, challenge: PKCE_CHALLENGE_A, state: TOKEN_C },
  );
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => undefined;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await openSteleAuthorizationInBrowser(url, "linux", spawn);
  assert.deepEqual(calls[0], {
    command: "xdg-open",
    args: [url.toString()],
    options: { shell: false, stdio: "ignore", windowsHide: true, detached: true },
  });
  assert.deepEqual(browserCommand("darwin", url.toString()), { executable: "open", args: [url.toString()] });
  assert.deepEqual(browserCommand("win32", url.toString()).args[0], "url.dll,FileProtocolHandler");

  const duplicated = new URL(url);
  duplicated.searchParams.append("resource", STELE_OAUTH_RESOURCE);
  await assert.rejects(openSteleAuthorizationInBrowser(duplicated, "linux", spawn));
  const extra = new URL(url);
  extra.searchParams.set("origin", "https://attacker.invalid");
  await assert.rejects(openSteleAuthorizationInBrowser(extra, "linux", spawn));
  assert.equal(calls.length, 1);
});
