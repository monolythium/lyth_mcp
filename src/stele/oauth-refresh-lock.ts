import { createServer, type Server, type Socket } from "node:net";

export const STELE_OAUTH_REFRESH_MUTEX_PORT = 49_371 as const;
const LOOPBACK_HOST = "127.0.0.1" as const;

export class SteleOAuthRefreshLockError extends Error {
  override readonly name = "SteleOAuthRefreshLockError";

  constructor(readonly code: "busy" | "unavailable") {
    super("Stele OAuth refresh serialization is unavailable");
  }
}

export interface SteleOAuthRefreshCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface KernelSteleOAuthRefreshLockOptions {
  /** Test-only injection. Production always uses the pinned exported port. */
  readonly port?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly monotonicNow?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  /** Test-only bind failure seam. */
  readonly serverFactory?: () => Server;
}

/**
 * Cross-process mutex backed by an exclusive kernel-owned IPv4 listener.
 * The kernel releases ownership on process death, so there is no stale file,
 * lease, PID-reuse, or compare/read/rename recovery window.
 */
export class KernelSteleOAuthRefreshLock implements SteleOAuthRefreshCoordinator {
  readonly #port: number;
  readonly #waitTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #monotonicNow: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #serverFactory: () => Server;

  constructor(options: KernelSteleOAuthRefreshLockOptions = {}) {
    this.#port = boundedInteger(
      options.port ?? STELE_OAUTH_REFRESH_MUTEX_PORT,
      1_024,
      65_535,
    );
    this.#waitTimeoutMs = boundedInteger(options.waitTimeoutMs ?? 20_000, 50, 60_000);
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 25, 5, 1_000);
    this.#monotonicNow = options.monotonicNow ?? monotonicMilliseconds;
    this.#delay = options.delay ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#serverFactory = options.serverFactory ?? (() => createServer({ pauseOnConnect: true }));
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = checkedMonotonic(this.#monotonicNow());
    const deadline = startedAt + this.#waitTimeoutMs;
    if (!Number.isSafeInteger(deadline)) {
      throw new SteleOAuthRefreshLockError("unavailable");
    }
    let previous = startedAt;
    let initialAttempt = true;
    while (true) {
      if (!initialAttempt) {
        const beforeRetry = checkedMonotonic(this.#monotonicNow());
        if (beforeRetry < previous) throw new SteleOAuthRefreshLockError("unavailable");
        previous = beforeRetry;
        if (beforeRetry >= deadline) throw new SteleOAuthRefreshLockError("busy");
      }
      initialAttempt = false;
      const listener = await tryBindExclusiveLoopback(this.#port, this.#serverFactory);
      if (listener !== null) {
        try {
          return await operation();
        } finally {
          await closeExclusiveLoopback(listener);
        }
      }

      const current = checkedMonotonic(this.#monotonicNow());
      if (current < previous) throw new SteleOAuthRefreshLockError("unavailable");
      previous = current;
      if (current >= deadline) throw new SteleOAuthRefreshLockError("busy");
      await this.#delay(Math.min(this.#pollIntervalMs, Math.max(0, deadline - current)));
    }
  }
}

interface ExclusiveLoopbackListener {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

async function tryBindExclusiveLoopback(
  port: number,
  serverFactory: () => Server,
): Promise<ExclusiveLoopbackListener | null> {
  const sockets = new Set<Socket>();
  let server: Server;
  try {
    server = serverFactory();
  } catch {
    throw new SteleOAuthRefreshLockError("unavailable");
  }
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  server.maxConnections = 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const socket of sockets) socket.destroy();
      if (error.code === "EADDRINUSE") {
        resolve(null);
      } else {
        reject(new SteleOAuthRefreshLockError("unavailable"));
      }
    };
    const onListening = () => {
      if (settled) return;
      const address = server.address();
      if (
        typeof address !== "object" ||
        address === null ||
        address.address !== LOOPBACK_HOST ||
        address.port !== port
      ) {
        settled = true;
        cleanup();
        void closeExclusiveLoopback({ server, sockets }).finally(() => {
          reject(new SteleOAuthRefreshLockError("unavailable"));
        });
        return;
      }
      settled = true;
      cleanup();
      // An error after a successful bind must be observed. The listening file
      // descriptor remains the ownership primitive until close in finally.
      server.on("error", () => undefined);
      resolve({ server, sockets });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
    } catch {
      settled = true;
      cleanup();
      reject(new SteleOAuthRefreshLockError("unavailable"));
    }
  });
}

async function closeExclusiveLoopback(listener: ExclusiveLoopbackListener): Promise<void> {
  for (const socket of listener.sockets) socket.destroy();
  if (!listener.server.listening) return;
  await new Promise<void>((resolve, reject) => {
    try {
      listener.server.close((error) => {
        for (const socket of listener.sockets) socket.destroy();
        if (error !== undefined) reject(new SteleOAuthRefreshLockError("unavailable"));
        else resolve();
      });
    } catch {
      reject(new SteleOAuthRefreshLockError("unavailable"));
    }
  });
}

function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function checkedMonotonic(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SteleOAuthRefreshLockError("unavailable");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SteleOAuthRefreshLockError("unavailable");
  }
  return value;
}
