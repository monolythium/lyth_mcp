import assert from "node:assert/strict";
import test from "node:test";

import {
  SteleOperatorFetchBoundary,
  STELE_OPERATOR_ENDPOINTS,
} from "../../dist/stele/operator-fetch.js";
import {
  probeTrustedOperator,
  sdkNetworkIdentity,
} from "../../dist/stele/network-identity.js";

const endpoint = STELE_OPERATOR_ENDPOINTS[0];

function request(method = "eth_chainId", id = 1) {
  return {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "application/json",
      ...(init.headers ?? {}),
    },
  });
}

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

test("operator discovery fetch permits only exact pinned registry endpoints", async () => {
  let fetchCalls = 0;
  const boundary = new SteleOperatorFetchBoundary({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x10f2c" });
    },
  });
  try {
    for (const untrusted of [
      `${endpoint}/`,
      `${endpoint}?next=https://evil.example`,
      endpoint.replace("http://", "https://"),
      "http://127.0.0.1:8545",
      new URL(endpoint),
    ]) {
      await assert.rejects(boundary.fetch(untrusted, request()));
    }
    assert.equal(fetchCalls, 0);
  } finally {
    boundary.close();
  }
});

test("operator discovery fetch enforces redirect, credentials, status, and content type", async (t) => {
  await t.test("redirect policy and credential omission are fixed", async () => {
    let observed;
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: async (_input, init) => {
        observed = init;
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example", "content-type": "application/json" },
        });
      },
    });
    try {
      await assert.rejects(boundary.fetch(endpoint, request()));
      assert.equal(observed.redirect, "error");
      assert.equal(observed.credentials, "omit");
      assert.equal(observed.referrerPolicy, "no-referrer");
      assert.equal(observed.cache, "no-store");
      const headers = new Headers(observed.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.get("accept-encoding"), "identity");
    } finally {
      boundary.close();
    }
  });

  for (const [label, response] of [
    ["non-200 status", jsonResponse({ error: "no" }, { status: 503 })],
    ["non-JSON content type", jsonResponse({ ok: true }, { contentType: "text/plain" })],
    ["JSON suffix content type", jsonResponse({ ok: true }, { contentType: "application/problem+json" })],
    ["encoded response", jsonResponse({ ok: true }, { headers: { "content-encoding": "gzip" } })],
  ]) {
    await t.test(label, async () => {
      const boundary = new SteleOperatorFetchBoundary({ fetchImpl: async () => response.clone() });
      try {
        await assert.rejects(boundary.fetch(endpoint, request()));
      } finally {
        boundary.close();
      }
    });
  }
});

test("operator request JSON must be the exact unambiguous SDK encoding", async () => {
  let fetchCalls = 0;
  const boundary = new SteleOperatorFetchBoundary({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x10f2c" });
    },
  });
  try {
    for (const body of [
      '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[],"method":"lyth_chainStats"}',
      '{ "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [] }',
      '{"id":1,"jsonrpc":"2.0","method":"eth_chainId","params":[]}',
      '{"jsonrpc":"2.0","id":1.0,"method":"eth_chainId","params":[]}',
    ]) {
      await assert.rejects(boundary.fetch(endpoint, { method: "POST", body }));
    }
    assert.equal(fetchCalls, 0);
  } finally {
    boundary.close();
  }
});

test("operator discovery fetch bounds declared and streamed response bytes", async (t) => {
  await t.test("declared oversize", async () => {
    const boundary = new SteleOperatorFetchBoundary({
      maxResponseBytes: 64,
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "65" },
      }),
    });
    try {
      await assert.rejects(boundary.fetch(endpoint, request()));
    } finally {
      boundary.close();
    }
  });

  await t.test("chunked oversize", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40).fill(0x20));
        controller.enqueue(new Uint8Array(40).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const boundary = new SteleOperatorFetchBoundary({
      maxResponseBytes: 64,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      await assert.rejects(boundary.fetch(endpoint, request()));
      assert.equal(cancelled, true);
    } finally {
      boundary.close();
    }
  });
});

test("operator discovery fetch has independent per-request and overall deadlines", async (t) => {
  const hangingFetch = async (_input, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  await t.test("per-request deadline", async () => {
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: hangingFetch,
      perRequestTimeoutMs: 20,
      overallTimeoutMs: 500,
    });
    const started = Date.now();
    try {
      await assert.rejects(boundary.fetch(endpoint, request()));
      assert.ok(Date.now() - started < 400);
    } finally {
      boundary.close();
    }
  });

  await t.test("overall deadline wins even if fetch ignores abort", async () => {
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: async () => await new Promise(() => undefined),
      perRequestTimeoutMs: 1_000,
      overallTimeoutMs: 25,
    });
    const started = Date.now();
    try {
      await assert.rejects(boundary.fetch(endpoint, request()));
      assert.ok(Date.now() - started < 500);
    } finally {
      boundary.close();
    }
  });
});

test("pre-aborted, expired, and closed boundaries make zero fetch calls", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x10f2c" });
  };

  const preAborted = new AbortController();
  preAborted.abort();
  const callerBoundary = new SteleOperatorFetchBoundary({ fetchImpl });
  try {
    await assert.rejects(boundaryCall(callerBoundary, preAborted.signal));
    assert.equal(fetchCalls, 0);
  } finally {
    callerBoundary.close();
  }

  const expiredBoundary = new SteleOperatorFetchBoundary({
    fetchImpl,
    overallTimeoutMs: 10,
  });
  await delay(30);
  try {
    await assert.rejects(expiredBoundary.fetch(endpoint, request()));
    assert.equal(fetchCalls, 0);
  } finally {
    expiredBoundary.close();
  }

  const closedBoundary = new SteleOperatorFetchBoundary({ fetchImpl });
  closedBoundary.close();
  await assert.rejects(closedBoundary.fetch(endpoint, request()));
  assert.equal(fetchCalls, 0);
});

test("synchronous fetch failure is contained at the safe boundary", async () => {
  const boundary = new SteleOperatorFetchBoundary({
    fetchImpl: () => {
      throw new Error("upstream-secret");
    },
  });
  try {
    await assert.rejects(boundary.fetch(endpoint, request()), (error) => {
      assert.equal(error.message.includes("upstream-secret"), false);
      return true;
    });
  } finally {
    boundary.close();
  }
});

test("deadline failure cancels late bodies and never waits for or leaks cancellation", async (t) => {
  await t.test("late fetch response is cancelled", async () => {
    let resolveFetch;
    let cancelled = false;
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
      perRequestTimeoutMs: 20,
      overallTimeoutMs: 500,
    });
    try {
      await captureUnhandled(async () => {
        const started = Date.now();
        await assert.rejects(boundary.fetch(endpoint, request()));
        assert.ok(Date.now() - started < 400);
        resolveFetch(new Response(new ReadableStream({
          cancel() {
            cancelled = true;
            return Promise.reject(new Error("late cancel rejection"));
          },
        }), { headers: { "content-type": "application/json" } }));
      });
      assert.equal(cancelled, true);
    } finally {
      boundary.close();
    }
  });

  await t.test("hung body and never-settling cancellation remain bounded", async () => {
    let cancelled = false;
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise(() => undefined);
        },
      }), { headers: { "content-type": "application/json" } }),
      perRequestTimeoutMs: 20,
      overallTimeoutMs: 500,
    });
    try {
      const started = Date.now();
      await assert.rejects(boundary.fetch(endpoint, request()));
      assert.ok(Date.now() - started < 400);
      assert.equal(cancelled, true);
    } finally {
      boundary.close();
    }
  });

  await t.test("reader cancellation rejection is handled", async () => {
    let cancelled = false;
    const boundary = new SteleOperatorFetchBoundary({
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
          return Promise.reject(new Error("reader cancel rejection"));
        },
      }), { headers: { "content-type": "application/json" } }),
      perRequestTimeoutMs: 20,
      overallTimeoutMs: 500,
    });
    try {
      await captureUnhandled(async () => {
        await assert.rejects(boundary.fetch(endpoint, request()));
      });
      assert.equal(cancelled, true);
    } finally {
      boundary.close();
    }
  });
});

test("trusted selection cancels losing probes and does not re-probe the winner", async () => {
  const expected = sdkNetworkIdentity();
  const winner = STELE_OPERATOR_ENDPOINTS[0];
  const winnerMethods = [];
  const methodsByEndpoint = new Map(STELE_OPERATOR_ENDPOINTS.map((value) => [value, []]));
  const loserEndpoints = new Set();
  const abortedLosers = new Set();

  const fetchImpl = async (input, init) => {
    const payload = JSON.parse(init.body);
    methodsByEndpoint.get(input)?.push(payload.method);
    if (input === winner) {
      winnerMethods.push(payload.method);
      const result = payload.method === "eth_chainId"
        ? `0x${BigInt(expected.chainId).toString(16)}`
        : { genesisHash: expected.genesisHash };
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result });
    }

    loserEndpoints.add(input);
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        abortedLosers.add(input);
        reject(new Error("cancelled losing probe"));
      }, { once: true });
    });
  };

  assert.deepEqual(
    await probeTrustedOperator(expected, {
      fetchImpl,
      perRequestTimeoutMs: 1_000,
      overallTimeoutMs: 2_000,
    }),
    { chainId: expected.chainId, genesisHash: expected.genesisHash },
  );
  assert.deepEqual(winnerMethods, ["eth_chainId", "lyth_chainStats"]);
  for (const operatorEndpoint of STELE_OPERATOR_ENDPOINTS) {
    assert.deepEqual(
      methodsByEndpoint.get(operatorEndpoint),
      operatorEndpoint === winner ? ["eth_chainId", "lyth_chainStats"] : ["eth_chainId"],
    );
  }
  assert.equal(loserEndpoints.size, STELE_OPERATOR_ENDPOINTS.length - 1);
  assert.deepEqual(abortedLosers, loserEndpoints);
});

function boundaryCall(boundary, signal) {
  return boundary.fetch(endpoint, { ...request(), signal });
}
