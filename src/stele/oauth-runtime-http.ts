import {
  OAuthClientIdSchema,
  OpaqueOAuthTokenSchema,
  OAuthProtocolErrorSchema,
  OAuthTokenResponseSchema,
  STELE_OAUTH_ENDPOINTS,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
  type OAuthProtocolErrorCode,
  type OAuthTokenResponse,
} from "./oauth-contract.js";

const MAX_JSON_BYTES = 65_536;
const MAX_RESPONSE_CHUNKS = 4_096;
const CANONICAL_LENGTH = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export class SteleOAuthRuntimeHttpError extends Error {
  override readonly name = "SteleOAuthRuntimeHttpError";

  constructor(
    readonly code: "boundary" | "unavailable" | "protocol",
    readonly protocolCode?: OAuthProtocolErrorCode,
  ) {
    super("Stele OAuth request failed");
  }
}

export interface SteleOAuthRuntimeHttpClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clientVersion?: string;
}

export interface SteleOAuthRuntimeTransport {
  refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
  }): Promise<OAuthTokenResponse>;
  revoke(input: { readonly refreshToken: string; readonly clientId: string }): Promise<void>;
}

/** Runtime transport with exactly refresh and revoke capabilities. */
export class SteleOAuthRuntimeHttpClient implements SteleOAuthRuntimeTransport {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #clientVersion: string;

  constructor(options: SteleOAuthRuntimeHttpClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 100, 30_000);
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? MAX_JSON_BYTES,
      1_024,
      262_144,
    );
    if (!CANONICAL_SEMVER.test(options.clientVersion ?? "0.3.0")) {
      throw new SteleOAuthRuntimeHttpError("boundary");
    }
    this.#clientVersion = options.clientVersion ?? "0.3.0";
  }

  async refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
  }): Promise<OAuthTokenResponse> {
    if (
      !OpaqueOAuthTokenSchema.safeParse(input.refreshToken).success ||
      !OAuthClientIdSchema.safeParse(input.clientId).success
    ) {
      throw new SteleOAuthRuntimeHttpError("boundary");
    }
    const value = await this.#jsonRequest(
      STELE_OAUTH_ENDPOINTS.token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
          client_id: input.clientId,
          resource: STELE_OAUTH_RESOURCE,
          scope: STELE_OAUTH_SCOPE,
        }).toString(),
      },
      200,
    );
    const parsed = OAuthTokenResponseSchema.safeParse(value);
    if (!parsed.success) throw new SteleOAuthRuntimeHttpError("boundary");
    return parsed.data;
  }

  async revoke(input: {
    readonly refreshToken: string;
    readonly clientId: string;
  }): Promise<void> {
    if (
      !OpaqueOAuthTokenSchema.safeParse(input.refreshToken).success ||
      !OAuthClientIdSchema.safeParse(input.clientId).success
    ) {
      throw new SteleOAuthRuntimeHttpError("boundary");
    }
    await this.#withResponse(
      STELE_OAUTH_ENDPOINTS.revoke,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: input.refreshToken,
          client_id: input.clientId,
          token_type_hint: "refresh_token",
        }).toString(),
      },
      async (response, signal) => {
        if (response.status !== 200) {
          await throwResponseError(response, this.#maxResponseBytes, signal);
        }
        const bytes = await readBoundedBody(response, this.#maxResponseBytes, signal);
        try {
          if (bytes.length !== 0) throw new SteleOAuthRuntimeHttpError("boundary");
        } finally {
          bytes.fill(0);
        }
      },
    );
  }

  async #jsonRequest(url: string, init: RequestInit, expectedStatus: number): Promise<unknown> {
    return this.#withResponse(url, init, async (response, signal) => {
      if (response.status !== expectedStatus) {
        await throwResponseError(response, this.#maxResponseBytes, signal);
      }
      if (!isJsonContentType(response.headers.get("content-type"))) {
        cancelBody(response);
        throw new SteleOAuthRuntimeHttpError("boundary");
      }
      const bytes = await readBoundedBody(response, this.#maxResponseBytes, signal);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(text) as unknown;
      } catch {
        throw new SteleOAuthRuntimeHttpError("boundary");
      } finally {
        bytes.fill(0);
      }
    });
  }

  async #withResponse<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await startWithAbort(
        () =>
          this.#fetch(url, {
            ...init,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              "user-agent": `lyth-stele-auth/${this.#clientVersion}`,
              ...init.headers,
            },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          }),
        controller.signal,
      );
      if (
        response.redirected ||
        response.url !== url ||
        response.headers.get("content-encoding") !== null ||
        response.headers.get("set-cookie") !== null ||
        !hasNoStore(response.headers.get("cache-control"))
      ) {
        cancelBody(response);
        throw new SteleOAuthRuntimeHttpError("boundary");
      }
      validateDeclaredLength(response, this.#maxResponseBytes);
      return await consume(response, controller.signal);
    } catch (error) {
      if (error instanceof SteleOAuthRuntimeHttpError) throw error;
      throw new SteleOAuthRuntimeHttpError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function throwResponseError(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<never> {
  if (!isJsonContentType(response.headers.get("content-type"))) {
    cancelBody(response);
    throw new SteleOAuthRuntimeHttpError("boundary");
  }
  const bytes = await readBoundedBody(response, maximum, signal);
  try {
    const parsed = OAuthProtocolErrorSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
    if (!parsed.success) throw new SteleOAuthRuntimeHttpError("boundary");
    throw new SteleOAuthRuntimeHttpError("protocol", parsed.data.error);
  } catch (error) {
    if (error instanceof SteleOAuthRuntimeHttpError) throw error;
    throw new SteleOAuthRuntimeHttpError("boundary");
  } finally {
    bytes.fill(0);
  }
}

function validateDeclaredLength(response: Response, maximum: number): void {
  const value = response.headers.get("content-length");
  if (value === null) return;
  if (!CANONICAL_LENGTH.test(value)) {
    cancelBody(response);
    throw new SteleOAuthRuntimeHttpError("boundary");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) {
    cancelBody(response);
    throw new SteleOAuthRuntimeHttpError("boundary");
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (response.body === null) {
    if (
      response.headers.get("content-length") !== null &&
      response.headers.get("content-length") !== "0"
    ) {
      throw new SteleOAuthRuntimeHttpError("boundary");
    }
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      if (next.value.byteLength === 0 || chunks.length >= MAX_RESPONSE_CHUNKS) {
        next.value.fill(0);
        throw new SteleOAuthRuntimeHttpError("boundary");
      }
      total += next.value.byteLength;
      chunks.push(next.value);
      if (total > maximum) throw new SteleOAuthRuntimeHttpError("boundary");
    }
    const result = Buffer.concat(chunks, total);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== result.length) {
      result.fill(0);
      throw new SteleOAuthRuntimeHttpError("boundary");
    }
    return result;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof SteleOAuthRuntimeHttpError) throw error;
    throw new SteleOAuthRuntimeHttpError("unavailable");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // An adversarial stream may retain the lock while cancellation stalls.
    }
  }
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

function hasNoStore(value: string | null): boolean {
  if (value === null || /[\r\n]/u.test(value)) return false;
  const directives = value
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  const allowed = new Set(["no-store", "max-age=0", "no-transform"]);
  return (
    directives.length > 0 &&
    directives.includes("no-store") &&
    directives.every((directive) => allowed.has(directive))
  );
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SteleOAuthRuntimeHttpError("boundary");
  }
  return value;
}

function startWithAbort(start: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(new SteleOAuthRuntimeHttpError("unavailable"));
  return new Promise((resolve, reject) => {
    let finished = false;
    const aborted = () => {
      if (finished) return;
      finished = true;
      reject(new SteleOAuthRuntimeHttpError("unavailable"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    let pending: Promise<Response>;
    try {
      pending = start();
    } catch {
      signal.removeEventListener("abort", aborted);
      reject(new SteleOAuthRuntimeHttpError("unavailable"));
      return;
    }
    pending.then(
      (response) => {
        signal.removeEventListener("abort", aborted);
        if (finished) {
          cancelBody(response);
          return;
        }
        finished = true;
        resolve(response);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        if (finished) return;
        finished = true;
        reject(new SteleOAuthRuntimeHttpError("unavailable"));
      },
    );
  });
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new SteleOAuthRuntimeHttpError("unavailable"));
  return new Promise((resolve, reject) => {
    let finished = false;
    const aborted = () => {
      if (finished) return;
      finished = true;
      void reader.cancel().catch(() => undefined);
      reject(new SteleOAuthRuntimeHttpError("unavailable"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (finished) {
          if (!value.done) value.value.fill(0);
          return;
        }
        finished = true;
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        if (finished) return;
        finished = true;
        reject(new SteleOAuthRuntimeHttpError("unavailable"));
      },
    );
  });
}
