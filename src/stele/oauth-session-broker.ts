import {
  STELE_OAUTH_ISSUER,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
} from "./oauth-contract.js";
import {
  createDefaultSteleOAuthCredentialStore,
  credentialRecordsEqual,
  markSteleOAuthReauthenticationRequired,
  rotateSteleOAuthCredentialRecord,
  type SteleOAuthCredentialRecord,
  type SteleOAuthCredentialStore,
} from "./oauth-credential-store.js";
import {
  SteleOAuthRuntimeHttpClient,
  SteleOAuthRuntimeHttpError,
  type SteleOAuthRuntimeTransport,
} from "./oauth-runtime-http.js";
import {
  KernelSteleOAuthRefreshLock,
  type SteleOAuthRefreshCoordinator,
} from "./oauth-refresh-lock.js";

const ACCESS_TOKEN_SAFETY_WINDOW_MS = 30_000;

export type SteleOAuthSessionErrorCode = "auth_required" | "unavailable";

export class SteleOAuthSessionError extends Error {
  override readonly name = "SteleOAuthSessionError";

  constructor(readonly code: SteleOAuthSessionErrorCode) {
    super("Stele OAuth session is unavailable");
  }
}

export type SteleOAuthPublicStatus =
  | {
      readonly state: "signed_out";
      readonly issuer: typeof STELE_OAUTH_ISSUER;
      readonly resource: typeof STELE_OAUTH_RESOURCE;
      readonly scope: typeof STELE_OAUTH_SCOPE;
    }
  | {
      readonly state: "authenticated";
      readonly issuer: typeof STELE_OAUTH_ISSUER;
      readonly resource: typeof STELE_OAUTH_RESOURCE;
      readonly scope: typeof STELE_OAUTH_SCOPE;
    }
  | {
      readonly state: "reauth_required";
      readonly issuer: typeof STELE_OAUTH_ISSUER;
      readonly resource: typeof STELE_OAUTH_RESOURCE;
      readonly scope: typeof STELE_OAUTH_SCOPE;
    };

export interface SteleOAuthSessionBrokerDependencies {
  readonly store: SteleOAuthCredentialStore;
  readonly transport: SteleOAuthRuntimeTransport;
  readonly refresh: SteleOAuthRefreshCoordinator;
  readonly now?: () => number;
}

/**
 * Runtime-only bearer broker. Its module graph has no browser, DCR, CLI,
 * wallet custody, SDK crypto, signing, or submission capability.
 */
export class SteleOAuthSessionBroker {
  readonly #store: SteleOAuthCredentialStore;
  readonly #transport: SteleOAuthRuntimeTransport;
  readonly #refresh: SteleOAuthRefreshCoordinator;
  readonly #now: () => number;

  constructor(dependencies: SteleOAuthSessionBrokerDependencies) {
    this.#store = dependencies.store;
    this.#transport = dependencies.transport;
    this.#refresh = dependencies.refresh;
    this.#now = dependencies.now ?? Date.now;
  }

  async status(): Promise<SteleOAuthPublicStatus> {
    try {
      const record = await this.#store.read();
      if (record === null) return publicStatus("signed_out");
      const now = checkedNow(this.#now());
      return publicStatus(
        record.sessionState === "reauth_required" || record.registration.expiresAt * 1_000 <= now
          ? "reauth_required"
          : "authenticated",
      );
    } catch {
      throw new SteleOAuthSessionError("unavailable");
    }
  }

  async accessToken(): Promise<string> {
    try {
      return await this.#refresh.runExclusive(async () => {
        // Always reread only after obtaining the cross-process lock. A sibling
        // may have already rotated the one-use refresh token.
        const current = await this.#store.read();
        if (current === null) throw new SteleOAuthSessionError("auth_required");
        const now = checkedNow(this.#now());
        if (
          current.sessionState === "reauth_required" ||
          current.registration.expiresAt * 1_000 <= now
        ) {
          throw new SteleOAuthSessionError("auth_required");
        }
        if (current.tokens.accessExpiresAt - ACCESS_TOKEN_SAFETY_WINDOW_MS > now) {
          return current.tokens.accessToken;
        }

        let rotated;
        try {
          rotated = await this.#transport.refresh({
            refreshToken: current.tokens.refreshToken,
            clientId: current.registration.clientId,
          });
        } catch (error) {
          if (
            error instanceof SteleOAuthRuntimeHttpError &&
            error.code === "protocol" &&
            ["invalid_client", "invalid_grant", "invalid_scope"].includes(
              error.protocolCode ?? "",
            )
          ) {
            await this.#store.write(markSteleOAuthReauthenticationRequired(current));
            throw new SteleOAuthSessionError("auth_required");
          }
          throw new SteleOAuthSessionError("unavailable");
        }
        let replacement: SteleOAuthCredentialRecord;
        try {
          replacement = rotateSteleOAuthCredentialRecord(current, rotated, now);
        } catch (error) {
          await this.#transport.revoke({
            refreshToken: rotated.refresh_token,
            clientId: current.registration.clientId,
          }).catch(() => undefined);
          await this.#store.write(
            markSteleOAuthReauthenticationRequired(current),
          ).catch(() => undefined);
          throw error;
        }
        try {
          await this.#store.write(replacement);
        } catch (error) {
          await compensateFailedRuntimeCommit(
            this.#store,
            this.#transport,
            current,
            replacement,
          );
          throw error;
        }
        return replacement.tokens.accessToken;
      });
    } catch (error) {
      if (error instanceof SteleOAuthSessionError) throw error;
      throw new SteleOAuthSessionError("unavailable");
    }
  }
}

export async function createDefaultSteleOAuthSessionBroker(): Promise<SteleOAuthSessionBroker> {
  return new SteleOAuthSessionBroker({
    store: await createDefaultSteleOAuthCredentialStore(),
    transport: new SteleOAuthRuntimeHttpClient(),
    refresh: new KernelSteleOAuthRefreshLock(),
  });
}

export function safeSteleOAuthSessionErrorCode(error: unknown): SteleOAuthSessionErrorCode {
  return error instanceof SteleOAuthSessionError ? error.code : "unavailable";
}

function publicStatus(
  state: "signed_out" | "authenticated" | "reauth_required",
): SteleOAuthPublicStatus {
  return { state, issuer: STELE_OAUTH_ISSUER, resource: STELE_OAUTH_RESOURCE, scope: STELE_OAUTH_SCOPE };
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SteleOAuthSessionError("unavailable");
  return value;
}

async function compensateFailedRuntimeCommit(
  store: SteleOAuthCredentialStore,
  transport: SteleOAuthRuntimeTransport,
  current: SteleOAuthCredentialRecord,
  replacement: SteleOAuthCredentialRecord,
): Promise<void> {
  const revoked = await transport.revoke({
    refreshToken: replacement.tokens.refreshToken,
    clientId: replacement.registration.clientId,
  }).then(() => true, () => false);
  let stored: SteleOAuthCredentialRecord | null;
  try {
    stored = await store.read();
  } catch {
    return;
  }
  if (
    stored !== null &&
    !credentialRecordsEqual(stored, current) &&
    !credentialRecordsEqual(stored, replacement)
  ) {
    return;
  }
  const retained = revoked
    ? credentialRecordsEqual(stored, replacement)
      ? replacement
      : current
    : replacement;
  await store.write(markSteleOAuthReauthenticationRequired(retained)).catch(() => undefined);
}
