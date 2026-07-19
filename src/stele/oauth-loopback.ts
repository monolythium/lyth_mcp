import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { OAuthLoopbackRedirectSchema, OpaqueOAuthTokenSchema, oauthStateMatches } from "./oauth-contract.js";

const MAX_CALLBACK_TARGET_BYTES = 12_288;

export type SteleOAuthCallback =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: "access_denied" | "invalid_client" | "authorization_failed" };

export class SteleOAuthLoopbackError extends Error {
  override readonly name = "SteleOAuthLoopbackError";

  constructor(readonly code: "invalid_callback" | "timeout" | "unavailable") {
    super("Stele OAuth callback failed");
  }
}

export interface SteleOAuthLoopback {
  readonly redirectUri: string;
  waitForCallback(expectedState: string): Promise<SteleOAuthCallback>;
  close(): Promise<void>;
}

export interface SteleOAuthLoopbackOptions {
  readonly timeoutMs?: number;
  readonly callbackId?: string;
}

export async function startSteleOAuthLoopback(
  options: SteleOAuthLoopbackOptions = {},
): Promise<SteleOAuthLoopback> {
  const timeoutMs = bounded(options.timeoutMs ?? 180_000, 50, 300_000);
  const callbackId = options.callbackId ?? randomBytes(32).toString("base64url");
  OpaqueOAuthTokenSchema.parse(callbackId);
  const callbackPath = `/callback/${callbackId}`;
  const server = createServer({ maxHeaderSize: 8_192, requireHostHeader: true });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1;

  await listenOnLiteralLoopback(server);
  const address = server.address();
  if (typeof address !== "object" || address === null || address.address !== "127.0.0.1") {
    await closeServer(server);
    throw new SteleOAuthLoopbackError("unavailable");
  }
  const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
  if (!OAuthLoopbackRedirectSchema.safeParse(redirectUri).success) {
    await closeServer(server);
    throw new SteleOAuthLoopbackError("unavailable");
  }

  let expectedState: string | undefined;
  let consumed = false;
  let settled = false;
  let resolveCallback: ((value: SteleOAuthCallback) => void) | undefined;
  let rejectCallback: ((error: SteleOAuthLoopbackError) => void) | undefined;
  const callbackPromise = new Promise<SteleOAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  void callbackPromise.catch(() => undefined);

  const finish = async (
    result: SteleOAuthCallback | SteleOAuthLoopbackError,
    response?: ServerResponse,
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (response !== undefined) {
      response.shouldKeepAlive = false;
      response.setHeader("cache-control", "no-store, max-age=0");
      response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      response.setHeader("connection", "close");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("x-content-type-options", "nosniff");
      response.statusCode = result instanceof SteleOAuthLoopbackError ? 400 : 200;
      response.end("Stele authorization is complete. You may close this window.\n");
    }
    await closeServer(server);
    if (result instanceof SteleOAuthLoopbackError) rejectCallback?.(result);
    else resolveCallback?.(result);
  };

  server.on("request", (request, response) => {
    if (consumed) {
      response.destroy();
      return;
    }
    consumed = true;
    let result: SteleOAuthCallback | SteleOAuthLoopbackError;
    try {
      if (expectedState === undefined) throw new SteleOAuthLoopbackError("invalid_callback");
      result = parseCallback(request, redirectUri, callbackPath, expectedState);
    } catch (error) {
      result = error instanceof SteleOAuthLoopbackError
        ? error
        : new SteleOAuthLoopbackError("invalid_callback");
    }
    void finish(result, response);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
    if (!consumed) {
      consumed = true;
      void finish(new SteleOAuthLoopbackError("invalid_callback"));
    }
  });

  const timer = setTimeout(() => {
    void finish(new SteleOAuthLoopbackError("timeout"));
  }, timeoutMs);

  return {
    redirectUri,
    waitForCallback(state: string) {
      if (expectedState !== undefined || !OpaqueOAuthTokenSchema.safeParse(state).success) {
        return Promise.reject(new SteleOAuthLoopbackError("invalid_callback"));
      }
      expectedState = state;
      return callbackPromise;
    },
    async close() {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        await closeServer(server);
        rejectCallback?.(new SteleOAuthLoopbackError("unavailable"));
      } else {
        await closeServer(server);
      }
    },
  };
}

function parseCallback(
  request: IncomingMessage,
  redirectUri: string,
  callbackPath: string,
  expectedState: string,
): SteleOAuthCallback {
  if (
    request.method !== "GET" ||
    !isLiteralLoopbackPeer(request.socket.remoteAddress) ||
    request.url === undefined ||
    !request.url.startsWith("/") ||
    request.url.startsWith("//") ||
    Buffer.byteLength(request.url, "utf8") > MAX_CALLBACK_TARGET_BYTES ||
    request.headers.authorization !== undefined ||
    request.headers.cookie !== undefined ||
    request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  const expected = new URL(redirectUri);
  const hosts = rawHeaderValues(request, "host");
  if (hosts.length !== 1 || hosts[0] !== expected.host) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  let callback: URL;
  try {
    callback = new URL(request.url, expected.origin);
  } catch {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== callbackPath ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  const keys = [...callback.searchParams.keys()];
  if (new Set(keys).size !== keys.length || !hasExactlyOne(callback.searchParams, "state")) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  const state = callback.searchParams.get("state") ?? "";
  if (!oauthStateMatches(state, expectedState)) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }

  if (hasExactlyOne(callback.searchParams, "code")) {
    if (keys.length !== 2 || !keys.every((key) => key === "code" || key === "state")) {
      throw new SteleOAuthLoopbackError("invalid_callback");
    }
    const code = callback.searchParams.get("code") ?? "";
    if (!OpaqueOAuthTokenSchema.safeParse(code).success) {
      throw new SteleOAuthLoopbackError("invalid_callback");
    }
    return { kind: "code", code };
  }

  if (!hasExactlyOne(callback.searchParams, "error")) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  if (
    !keys.every((key) => key === "error" || key === "error_description" || key === "state") ||
    (callback.searchParams.has("error_description") &&
      !hasExactlyOne(callback.searchParams, "error_description"))
  ) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  const description = callback.searchParams.get("error_description");
  if (description !== null && (description.length > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(description))) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  const error = callback.searchParams.get("error");
  if (error === "access_denied") return { kind: "error", error: "access_denied" };
  if (error === "invalid_client") return { kind: "error", error: "invalid_client" };
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(error ?? "")) {
    throw new SteleOAuthLoopbackError("invalid_callback");
  }
  return { kind: "error", error: "authorization_failed" };
}

function hasExactlyOne(parameters: URLSearchParams, name: string): boolean {
  return parameters.getAll(name).length === 1;
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function isLiteralLoopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

async function listenOnLiteralLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new SteleOAuthLoopbackError("unavailable"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SteleOAuthLoopbackError("unavailable");
  }
  return value;
}
