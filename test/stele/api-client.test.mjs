import assert from "node:assert/strict";
import test from "node:test";

import {
  STELE_PRODUCTION_ORIGIN,
  SteleApiBoundaryError,
  SteleApiClient,
  SteleApiConfigurationError,
  StelePublicServiceOutputSchema,
  exactSteleOrigin,
  steleApiClientFromEnvironment,
} from "../../dist/stele/api-client.js";

const GENESIS = "0xe22733f4d7e013b93f0f825667fcf852cbf7ad1ca31a42a1bfcf1ab6d79c89a3";
const PRIVATE_LAN_ORIGIN = "http://10.23.45.67";
const SECOND_PRIVATE_LAN_ORIGIN = "http://172.20.30.40";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function captureUnhandled(action, settleMilliseconds = 30) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await action();
    await delay(settleMilliseconds);
    assert.deepEqual(reasons, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function metadata(overrides = {}) {
  return {
    product: "stele",
    stage: "data-auth",
    network: "testnet",
    chainId: "69420",
    genesisHash: GENESIS,
    walletAuthEnabled: true,
    oauthEnabled: true,
    economicWritesEnabled: false,
    hostedSigningEnabled: false,
    ...overrides,
  };
}

test("production and canonical opted-in RFC1918 port-80 origins are accepted", () => {
  assert.equal(exactSteleOrigin(STELE_PRODUCTION_ORIGIN, false).origin, STELE_PRODUCTION_ORIGIN);
  for (const [value, expected] of [
    [PRIVATE_LAN_ORIGIN, PRIVATE_LAN_ORIGIN],
    [`${PRIVATE_LAN_ORIGIN}:80`, PRIVATE_LAN_ORIGIN],
    ["http://172.16.0.1", "http://172.16.0.1"],
    ["http://172.31.255.254:80", "http://172.31.255.254"],
    ["http://192.168.50.60", "http://192.168.50.60"],
  ]) {
    assert.equal(exactSteleOrigin(value, true).origin, expected);
    assert.throws(() => exactSteleOrigin(value, false), SteleApiConfigurationError);
  }
});

test("LAN origin parsing rejects every non-canonical or non-private alternative", () => {
  for (const value of [
    `${PRIVATE_LAN_ORIGIN}:81`,
    `https://${new URL(PRIVATE_LAN_ORIGIN).hostname}`,
    `http://user:secret@${new URL(PRIVATE_LAN_ORIGIN).hostname}`,
    `${PRIVATE_LAN_ORIGIN}/`,
    `${PRIVATE_LAN_ORIGIN}/api`,
    `${PRIVATE_LAN_ORIGIN}?token=secret`,
    `${PRIVATE_LAN_ORIGIN}#fragment`,
    "http://010.23.45.67",
    "http://10.23.45",
    "http://167772161",
    "http://0x0a000001",
    "http://lan.internal",
    "http://[fd00::1]",
    "http://127.0.0.1",
    "http://169.254.10.20",
    "http://100.64.0.1",
    "http://8.8.8.8",
    "http://192.0.2.1",
    "http://172.15.255.255",
    "http://172.32.0.1",
    "http://192.167.1.1",
    "http://256.1.1.1",
    "https://example.com",
    "https://stele.monolythium.com.evil.example",
    "https://user:secret@stele.monolythium.com",
    "https://stele.monolythium.com:443",
    "https://stele.monolythium.com/",
    "https://stele.monolythium.com/api",
    "https://stele.monolythium.com/?token=secret",
  ]) {
    assert.throws(() => exactSteleOrigin(value, true), SteleApiConfigurationError);
  }
});

test("environment configuration requires opt-in and exactly matching injected LAN origins", () => {
  assert.throws(
    () => steleApiClientFromEnvironment({
      LYTH_MCP_STELE_API_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_PUBLIC_ORIGIN: PRIVATE_LAN_ORIGIN,
    }),
    SteleApiConfigurationError,
  );
  assert.doesNotThrow(() =>
    steleApiClientFromEnvironment({
      LYTH_MCP_STELE_API_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_PUBLIC_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_ALLOW_INSECURE_LAN: "1",
    }),
  );
  for (const environment of [
    {
      LYTH_MCP_STELE_API_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_ALLOW_INSECURE_LAN: "1",
    },
    {
      LYTH_MCP_STELE_PUBLIC_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_ALLOW_INSECURE_LAN: "1",
    },
    {
      LYTH_MCP_STELE_API_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_PUBLIC_ORIGIN: SECOND_PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_ALLOW_INSECURE_LAN: "1",
    },
    {
      LYTH_MCP_STELE_API_ORIGIN: `${PRIVATE_LAN_ORIGIN}:80`,
      LYTH_MCP_STELE_PUBLIC_ORIGIN: PRIVATE_LAN_ORIGIN,
      LYTH_MCP_STELE_ALLOW_INSECURE_LAN: "1",
    },
  ]) {
    assert.throws(() => steleApiClientFromEnvironment(environment), SteleApiConfigurationError);
  }
  assert.throws(
    () => steleApiClientFromEnvironment({ LYTH_MCP_STELE_TIMEOUT_MS: "not-a-number" }),
    SteleApiConfigurationError,
  );
});

test("metadata reads use a bounded, credential-free, no-redirect request", async () => {
  let observed;
  const client = new SteleApiClient({}, async (url, init) => {
    observed = { url: url.toString(), init };
    return jsonResponse(metadata());
  });

  assert.deepEqual(await client.getMeta(), metadata());
  assert.equal(observed.url, "https://stele.monolythium.com/api/v1/meta");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.credentials, "omit");
  assert.equal(observed.init.cache, "no-store");
  assert.equal(observed.init.referrerPolicy, "no-referrer");
  assert.equal(new Headers(observed.init.headers).get("accept-encoding"), "identity");
  assert.equal(observed.init.headers.authorization, undefined);
  assert.equal(observed.init.headers.cookie, undefined);
});

test("service search validates both input and the complete upstream response", async () => {
  let observedUrl;
  const service = {
    id: "018f1f7a-7b1c-7a2d-8e3f-123456789abc",
    slug: "contract-review",
    title: "Contract review",
    providerDisplayName: "mono1qqqqqqqq",
    category: "legal",
    workflowKind: "project",
    startingPrice: {
      assetId: "lyth",
      atomicAmount: "1000",
      displayAmount: "10.00",
      assetSymbol: "LYTH",
      assetVerification: "verified",
    },
  };
  const client = new SteleApiClient({}, async (url) => {
    observedUrl = url;
    return jsonResponse({ items: [service], nextCursor: "next_page" });
  });

  const page = await client.searchServices({
    query: "contract review",
    category: "legal",
    cursor: "page_1",
    limit: 10,
  });
  assert.equal(observedUrl.searchParams.get("q"), "contract review");
  assert.equal(observedUrl.searchParams.get("category"), "legal");
  assert.equal(observedUrl.searchParams.get("cursor"), "page_1");
  assert.equal(
    page.items[0].publicUrl,
    "https://stele.monolythium.com/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review",
  );
  assert.equal(page.nextCursor, "next_page");

  await assert.rejects(
    () => client.searchServices({ query: "bad\u0000query", limit: 10 }),
    SteleApiBoundaryError,
  );

  const extraFieldClient = new SteleApiClient({}, async () =>
    jsonResponse({ items: [{ ...service, secret: "must-not-cross" }] }),
  );
  await assert.rejects(
    () => extraFieldClient.searchServices({ limit: 10 }),
    SteleApiBoundaryError,
  );

  const aboveUint256 =
    "115792089237316195423570985008687907853269984665640564039457584007913129639936";
  const oversizedAmountClient = new SteleApiClient({}, async () =>
    jsonResponse({
      items: [{ ...service, startingPrice: { ...service.startingPrice, atomicAmount: aboveUint256 } }],
    }),
  );
  await assert.rejects(
    () => oversizedAmountClient.searchServices({ limit: 10 }),
    SteleApiBoundaryError,
  );

  const oversizedChainClient = new SteleApiClient({}, async () =>
    jsonResponse(metadata({ chainId: aboveUint256 })),
  );
  await assert.rejects(() => oversizedChainClient.getMeta(), SteleApiBoundaryError);

  const lanClient = new SteleApiClient(
    {
      apiOrigin: PRIVATE_LAN_ORIGIN,
      publicOrigin: PRIVATE_LAN_ORIGIN,
      allowInsecureLan: true,
    },
    async () => jsonResponse({ items: [service] }),
  );
  const lanPage = await lanClient.searchServices({ limit: 1 });
  assert.equal(
    lanPage.items[0].publicUrl,
    `${PRIVATE_LAN_ORIGIN}/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review`,
  );

  assert.equal(StelePublicServiceOutputSchema.safeParse(lanPage.items[0]).success, true);
  for (const publicUrl of [
    "http://8.8.8.8/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review",
    "http://167772161/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review",
    `${PRIVATE_LAN_ORIGIN}:8080/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review`,
    `${PRIVATE_LAN_ORIGIN}/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review?token=secret`,
    `${PRIVATE_LAN_ORIGIN}/services/contract-review`,
    `${PRIVATE_LAN_ORIGIN}/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/contract-review/extra`,
    `${PRIVATE_LAN_ORIGIN}/services/018f1f7a-7b1c-7a2d-8e3f-123456789abd/contract-review`,
    `${PRIVATE_LAN_ORIGIN}/services/018f1f7a-7b1c-7a2d-8e3f-123456789abc/different-slug`,
  ]) {
    assert.equal(
      StelePublicServiceOutputSchema.safeParse({ ...lanPage.items[0], publicUrl }).success,
      false,
    );
  }
});

test("oversized, redirected, malformed, and secret-bearing failures collapse to one safe error", async () => {
  const oversized = new SteleApiClient(
    { maxResponseBytes: 1_024 },
    async () => jsonResponse({ padding: "x".repeat(2_000) }),
  );
  await assert.rejects(() => oversized.getMeta(), SteleApiBoundaryError);

  const redirected = new SteleApiClient({}, async () => jsonResponse({}, { status: 302 }));
  await assert.rejects(() => redirected.getMeta(), SteleApiBoundaryError);

  const malformed = new SteleApiClient({}, async () =>
    new Response("not-json", { headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(() => malformed.getMeta(), SteleApiBoundaryError);

  const upstreamSecret = "bearer-super-secret-value";
  const failed = new SteleApiClient({}, async () => {
    throw new Error(upstreamSecret);
  });
  await assert.rejects(
    () => failed.getMeta(),
    (error) => error instanceof SteleApiBoundaryError && !error.message.includes(upstreamSecret),
  );
});

test("encoded API responses are rejected even when their decoded bytes look valid", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(metadata())));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new SteleApiClient({}, async () => new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
  }));
  await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
  assert.equal(cancelled, true);
});

test("the API-owned deadline covers headers and the complete response body", async (t) => {
  await t.test("fetch that ignores abort still rejects on the owned deadline", async () => {
    const client = new SteleApiClient(
      { timeoutMs: 100 },
      async () => await new Promise(() => undefined),
    );
    const started = Date.now();
    await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
    assert.ok(Date.now() - started < 500);
  });

  await t.test("a body that never completes still rejects on the same deadline", async () => {
    let cancelled = false;
    const client = new SteleApiClient(
      { timeoutMs: 100 },
      async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise(() => undefined);
        },
      }), { headers: { "content-type": "application/json" } }),
    );
    const started = Date.now();
    await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
    assert.ok(Date.now() - started < 500);
    assert.equal(cancelled, true);
  });

  await t.test("reader cancellation rejection is handled", async () => {
    let cancelled = false;
    const client = new SteleApiClient(
      { timeoutMs: 100 },
      async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
          return Promise.reject(new Error("API reader cancel rejection"));
        },
      }), { headers: { "content-type": "application/json" } }),
    );
    await captureUnhandled(async () => {
      await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
    });
    assert.equal(cancelled, true);
  });
});

test("late API responses are cancelled and rejected cancellation never leaks", async () => {
  let resolveFetch;
  let cancelled = false;
  const client = new SteleApiClient(
    { timeoutMs: 100 },
    () => new Promise((resolve) => { resolveFetch = resolve; }),
  );

  await captureUnhandled(async () => {
    const started = Date.now();
    await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
    assert.ok(Date.now() - started < 500);
    resolveFetch(new Response(new ReadableStream({
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("late API cancel rejection"));
      },
    }), { headers: { "content-type": "application/json" } }));
  });
  assert.equal(cancelled, true);
});

test("invalid API responses never wait for hostile body cancellation", async () => {
  let cancelled = false;
  const client = new SteleApiClient({}, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x7b, 0x7d]));
    },
    cancel() {
      cancelled = true;
      return Promise.reject(new Error("invalid response cancel rejection"));
    },
  }), { status: 503, headers: { "content-type": "application/json" } }));

  await captureUnhandled(async () => {
    const started = Date.now();
    await assert.rejects(() => client.getMeta(), SteleApiBoundaryError);
    assert.ok(Date.now() - started < 500);
  });
  assert.equal(cancelled, true);
});

test("synchronous API fetch failure is normalized without its details", async () => {
  const client = new SteleApiClient({}, () => {
    throw new Error("credential=do-not-leak");
  });
  await assert.rejects(
    () => client.getMeta(),
    (error) => error instanceof SteleApiBoundaryError && !error.message.includes("do-not-leak"),
  );
});
