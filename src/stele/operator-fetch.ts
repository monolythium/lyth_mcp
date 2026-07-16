import { TESTNET_69420 } from "@monolythium/core-sdk";

export const STELE_OPERATOR_ENDPOINTS = Object.freeze(
  TESTNET_69420.rpc.map((endpoint) => endpoint.url),
);

const ALLOWED_RPC_METHODS = new Set(["eth_chainId", "lyth_chainStats"]);
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/u;

export interface SteleOperatorFetchBoundaryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly perRequestTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class SteleOperatorFetchBoundaryError extends Error {
  override readonly name = "SteleOperatorFetchBoundaryError";

  constructor() {
    super("trusted operator request failed");
  }
}

/**
 * A single-use, fail-closed fetch boundary for the SDK's trusted-operator
 * selector. It can only issue the two identity reads to the exact endpoints
 * bundled in the pinned SDK registry. Closing it aborts every in-flight probe.
 */
export class SteleOperatorFetchBoundary {
  readonly fetch: typeof fetch;

  readonly #fetchImpl: typeof fetch;
  readonly #allowedEndpoints = new Set(STELE_OPERATOR_ENDPOINTS);
  readonly #overallController = new AbortController();
  readonly #perRequestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #overallTimer: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(options: SteleOperatorFetchBoundaryOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#perRequestTimeoutMs = boundedInteger(
      options.perRequestTimeoutMs ?? 2_000,
      10,
      10_000,
    );
    const overallTimeoutMs = boundedInteger(options.overallTimeoutMs ?? 5_000, 10, 30_000);
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 65_536,
      64,
      1_048_576,
    );
    this.fetch = this.#request.bind(this) as typeof fetch;
    this.#overallTimer = setTimeout(() => this.#overallController.abort(), overallTimeoutMs);
  }

  isAllowedEndpoint(endpoint: string): boolean {
    return this.#allowedEndpoints.has(endpoint);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#overallTimer);
    this.#overallController.abort();
  }

  async #request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.#closed || typeof input !== "string" || !this.#allowedEndpoints.has(input)) {
      throw new SteleOperatorFetchBoundaryError();
    }
    assertIdentityRpcRequest(init);

    // Do not start an upstream operation when either the caller or the
    // single-use discovery budget is already exhausted.
    if (this.#overallController.signal.aborted || init?.signal?.aborted === true) {
      throw new SteleOperatorFetchBoundaryError();
    }

    const requestController = new AbortController();
    const requestTimer = setTimeout(
      () => requestController.abort(),
      this.#perRequestTimeoutMs,
    );
    const signals = [this.#overallController.signal, requestController.signal];
    if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
    const combined = combineAbortSignals(signals);

    let response: Response | undefined;
    try {
      response = await startWithAbort(
        () => this.#fetchImpl(input, {
          method: "POST",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            "content-type": "application/json",
            "user-agent": "lyth-stele-mcp/0.1.0",
          },
          body: init!.body,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: combined.signal,
        }),
        combined.signal,
        () => undefined,
        cancelResponseBody,
      );

      if (
        response.status !== 200 ||
        !isJsonContentType(response.headers.get("content-type")) ||
        response.headers.get("content-encoding") !== null
      ) {
        cancelResponseBody(response);
        throw new SteleOperatorFetchBoundaryError();
      }
      assertPermittedContentLength(response, this.#maxResponseBytes);

      const bytes = await readBoundedBody(response, this.#maxResponseBytes, combined.signal);
      const text = decodeJson(bytes);
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch {
      cancelResponseBody(response);
      throw new SteleOperatorFetchBoundaryError();
    } finally {
      clearTimeout(requestTimer);
      combined.dispose();
    }
  }
}

function assertIdentityRpcRequest(init: RequestInit | undefined): void {
  if (init?.method !== "POST" || typeof init.body !== "string") {
    throw new SteleOperatorFetchBoundaryError();
  }
  if (Buffer.byteLength(init.body, "utf8") > 4_096) {
    throw new SteleOperatorFetchBoundaryError();
  }

  let body: unknown;
  try {
    body = JSON.parse(init.body) as unknown;
  } catch {
    throw new SteleOperatorFetchBoundaryError();
  }
  if (!isRecord(body) || !hasExactKeys(body, ["jsonrpc", "id", "method", "params"])) {
    throw new SteleOperatorFetchBoundaryError();
  }
  if (
    body.jsonrpc !== "2.0" ||
    !Number.isSafeInteger(body.id) ||
    (body.id as number) < 1 ||
    typeof body.method !== "string" ||
    !ALLOWED_RPC_METHODS.has(body.method) ||
    !Array.isArray(body.params) ||
    body.params.length !== 0
  ) {
    throw new SteleOperatorFetchBoundaryError();
  }

  // The pinned SDK emits this exact JSON.stringify representation. Requiring
  // it prevents duplicate keys, alternate number spellings, and parser-
  // differential whitespace/order from changing the request after validation.
  const canonicalBody = JSON.stringify({
    jsonrpc: body.jsonrpc,
    id: body.id,
    method: body.method,
    params: body.params,
  });
  if (init.body !== canonicalBody) throw new SteleOperatorFetchBoundaryError();
}

function assertPermittedContentLength(response: Response, maximumBytes: number): void {
  const declared = response.headers.get("content-length");
  if (declared === null) return;
  if (!CANONICAL_UINT.test(declared)) throw new SteleOperatorFetchBoundaryError();
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new SteleOperatorFetchBoundaryError();
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) throw new SteleOperatorFetchBoundaryError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await startWithAbort(
        () => reader.read(),
        signal,
        () => cancelReader(reader),
        () => cancelReader(reader),
      );
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        throw new SteleOperatorFetchBoundaryError();
      }
      chunks.push(next.value);
    }
  } catch {
    cancelReader(reader);
    throw new SteleOperatorFetchBoundaryError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may reject release; the boundary still fails closed.
    }
  }

  if (total === 0) throw new SteleOperatorFetchBoundaryError();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeJson(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
    return text;
  } catch {
    throw new SteleOperatorFetchBoundaryError();
  }
}

function combineAbortSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    },
  };
}

async function startWithAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  onAbort: () => void = () => undefined,
  onLateValue: (value: T) => void = () => undefined,
): Promise<T> {
  if (signal.aborted) {
    safelyInvoke(onAbort);
    throw new SteleOperatorFetchBoundaryError();
  }

  let promise: Promise<T>;
  try {
    promise = Promise.resolve(start());
  } catch {
    throw new SteleOperatorFetchBoundaryError();
  }

  return await new Promise<T>((resolve, reject) => {
    let finished = false;
    const aborted = () => {
      if (finished) return;
      finished = true;
      safelyInvoke(onAbort);
      reject(new SteleOperatorFetchBoundaryError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    // The operation itself can synchronously abort a caller-owned signal.
    if (signal.aborted) aborted();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (finished || signal.aborted) {
          finished = true;
          safelyInvoke(() => onLateValue(value));
          reject(new SteleOperatorFetchBoundaryError());
          return;
        }
        finished = true;
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        if (finished) return;
        finished = true;
        reject(new SteleOperatorFetchBoundaryError());
      },
    );
  });
}

function cancelResponseBody(response: Response | undefined): void {
  if (response?.body === null || response?.body === undefined) return;
  safelyIgnorePromise(() => response.body!.cancel());
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  safelyIgnorePromise(() => reader.cancel());
}

function safelyIgnorePromise(start: () => Promise<unknown>): void {
  try {
    void Promise.resolve(start()).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never mask the bounded failure.
  }
}

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Cleanup hooks are best-effort and never cross the public boundary.
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SteleOperatorFetchBoundaryError();
  }
  return value;
}
