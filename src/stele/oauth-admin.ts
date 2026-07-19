import {
  OAuthClientRegistrationSchema,
  STELE_OAUTH_ISSUER,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
  buildSteleAuthorizationUrl,
  createSteleOAuthPkce,
  type OAuthClientRegistration,
  type SteleOAuthPkce,
} from "./oauth-contract.js";
import {
  createDefaultSteleOAuthCredentialStore,
  createSteleOAuthCredentialRecord,
  credentialRecordsEqual,
  markSteleOAuthReauthenticationRequired,
  rotateSteleOAuthCredentialRecord,
  type SteleOAuthCredentialRecord,
  type SteleOAuthCredentialStore,
} from "./oauth-credential-store.js";
import { openSteleAuthorizationInBrowser } from "./oauth-browser.js";
import {
  SteleOAuthHttpClient,
  SteleOAuthHttpError,
  type SteleOAuthProtocol,
} from "./oauth-http.js";
import {
  startSteleOAuthLoopback,
  type SteleOAuthCallback,
  type SteleOAuthLoopback,
} from "./oauth-loopback.js";
import {
  KernelSteleOAuthRefreshLock,
  type SteleOAuthRefreshCoordinator,
} from "./oauth-refresh-lock.js";
import type { SteleOAuthPublicStatus } from "./oauth-session-broker.js";

const CLIENT_VERSION = "0.3.0";
const ACCESS_TOKEN_SAFETY_WINDOW_MS = 30_000;
// DCR timestamps are whole seconds; tolerate only ordinary local/server clock skew.
const REGISTRATION_CLOCK_SKEW_SECONDS = 60;

export type SteleOAuthAdminErrorCode =
  | "cancelled"
  | "busy"
  | "credential_store_unavailable"
  | "unavailable";

export class SteleOAuthAdminError extends Error {
  override readonly name = "SteleOAuthAdminError";

  constructor(readonly code: SteleOAuthAdminErrorCode) {
    super("Stele OAuth administration failed");
  }
}

export interface SteleOAuthAdminResult {
  readonly action: "authenticated" | "already_authenticated" | "refreshed" | "logged_out" | "none";
  readonly session: SteleOAuthPublicStatus;
}

export interface SteleOAuthAdminDependencies {
  readonly store: SteleOAuthCredentialStore;
  readonly protocol: SteleOAuthProtocol;
  readonly refresh: SteleOAuthRefreshCoordinator;
  readonly startLoopback?: () => Promise<SteleOAuthLoopback>;
  readonly openBrowser?: (url: URL) => Promise<void>;
  readonly createPkce?: () => SteleOAuthPkce;
  readonly now?: () => number;
}

export class SteleOAuthAdmin {
  readonly #store: SteleOAuthCredentialStore;
  readonly #protocol: SteleOAuthProtocol;
  readonly #refresh: SteleOAuthRefreshCoordinator;
  readonly #startLoopback: () => Promise<SteleOAuthLoopback>;
  readonly #openBrowser: (url: URL) => Promise<void>;
  readonly #createPkce: () => SteleOAuthPkce;
  readonly #now: () => number;

  constructor(dependencies: SteleOAuthAdminDependencies) {
    this.#store = dependencies.store;
    this.#protocol = dependencies.protocol;
    this.#refresh = dependencies.refresh;
    this.#startLoopback = dependencies.startLoopback ?? (() => startSteleOAuthLoopback());
    this.#openBrowser = dependencies.openBrowser ?? openSteleAuthorizationInBrowser;
    this.#createPkce = dependencies.createPkce ?? createSteleOAuthPkce;
    this.#now = dependencies.now ?? Date.now;
  }

  async status(): Promise<SteleOAuthAdminResult> {
    try {
      const record = await this.#store.read();
      const state = record === null
        ? "signed_out"
        : record.sessionState === "reauth_required" ||
            record.registration.expiresAt * 1_000 <= checkedNow(this.#now())
          ? "reauth_required"
          : "authenticated";
      return {
        action: "none",
        session: publicStatus(state),
      };
    } catch {
      throw new SteleOAuthAdminError("credential_store_unavailable");
    }
  }

  async login(): Promise<SteleOAuthAdminResult> {
    try {
      return await this.#refresh.runExclusive(async () => {
        await this.#protocol.verifyMetadata();
        const current = await this.#store.read();
        const now = checkedNow(this.#now());
        if (
          current !== null &&
          current.sessionState === "active" &&
          current.registration.expiresAt * 1_000 > now &&
          current.tokens.accessExpiresAt - ACCESS_TOKEN_SAFETY_WINDOW_MS > now
        ) {
          return { action: "already_authenticated", session: publicStatus("authenticated") };
        }

        if (
          current !== null &&
          current.sessionState === "active" &&
          current.registration.expiresAt * 1_000 > now
        ) {
          try {
            const tokens = await this.#protocol.refresh({
              refreshToken: current.tokens.refreshToken,
              clientId: current.registration.clientId,
            });
            let replacement: SteleOAuthCredentialRecord;
            try {
              replacement = rotateSteleOAuthCredentialRecord(current, tokens, now);
            } catch (error) {
              await this.#protocol.revoke({
                refreshToken: tokens.refresh_token,
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
              await compensateFailedRefreshCommit(
                this.#store,
                this.#protocol,
                current,
                replacement,
              );
              throw error;
            }
            return { action: "refreshed", session: publicStatus("authenticated") };
          } catch (error) {
            if (!isReauthenticationError(error)) throw error;
          }
        }

        // Never overwrite a retained refresh family with an interactive login.
        // Revocation is idempotent, so a locally retained but already-revoked
        // family remains safe to retry after an interrupted earlier attempt.
        if (current !== null) {
          await this.#protocol.revoke({
            refreshToken: current.tokens.refreshToken,
            clientId: current.registration.clientId,
          });
        }

        let invalidClientRetries = 0;
        while (true) {
          try {
            const authenticated = await this.#interactiveAttempt();
            try {
              await this.#store.write(authenticated.record);
            } catch (error) {
              await compensateFailedInteractiveCommit(
                this.#store,
                this.#protocol,
                current,
                authenticated.record,
                authenticated.revoke,
              );
              throw error;
            }
            return { action: "authenticated", session: publicStatus("authenticated") };
          } catch (error) {
            if (error instanceof InteractiveInvalidClient && invalidClientRetries === 0) {
              invalidClientRetries += 1;
              continue;
            }
            throw error;
          }
        }
      });
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async logout(): Promise<SteleOAuthAdminResult> {
    try {
      return await this.#refresh.runExclusive(async () => {
        const current = await this.#store.read();
        if (current === null) {
          return { action: "none", session: publicStatus("signed_out") };
        }
        // Preserve the local credential unless the server accepts idempotent
        // token-family revocation. A retry can safely complete after failure.
        await this.#protocol.revoke({
          refreshToken: current.tokens.refreshToken,
          clientId: current.registration.clientId,
        });
        if (!(await this.#store.delete()) || (await this.#store.read()) !== null) {
          throw new SteleOAuthAdminError("credential_store_unavailable");
        }
        return { action: "logged_out", session: publicStatus("signed_out") };
      });
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async #interactiveAttempt() {
    const loopback = await this.#startLoopback();
    try {
      const registration = validateInteractiveRegistration(
        await this.#protocol.register(loopback.redirectUri),
        loopback.redirectUri,
        checkedNow(this.#now()),
      );
      const pkce = this.#createPkce();
      const callbackPromise = loopback.waitForCallback(pkce.state);
      void callbackPromise.catch(() => undefined);
      const authorizationUrl = buildSteleAuthorizationUrl(
        registration,
        loopback.redirectUri,
        pkce,
      );
      await this.#openBrowser(authorizationUrl);
      const callback = await callbackPromise;
      handleAuthorizationError(callback);
      let tokens;
      try {
        tokens = await this.#protocol.exchangeAuthorizationCode({
          code: callback.code,
          verifier: pkce.verifier,
          redirectUri: loopback.redirectUri,
          clientId: registration.client_id,
        });
      } catch (error) {
        if (isInvalidClient(error)) throw new InteractiveInvalidClient();
        throw error;
      }
      let record: SteleOAuthCredentialRecord;
      try {
        record = createSteleOAuthCredentialRecord(registration, tokens, checkedNow(this.#now()));
      } catch (error) {
        await this.#protocol.revoke({
          refreshToken: tokens.refresh_token,
          clientId: registration.client_id,
        }).catch(() => undefined);
        throw error;
      }
      return {
        record,
        revoke: {
          refreshToken: tokens.refresh_token,
          clientId: registration.client_id,
        },
      };
    } finally {
      await loopback.close().catch(() => undefined);
    }
  }
}

export async function createDefaultSteleOAuthAdmin(): Promise<SteleOAuthAdmin> {
  return new SteleOAuthAdmin({
    store: await createDefaultSteleOAuthCredentialStore(),
    protocol: new SteleOAuthHttpClient({ clientVersion: CLIENT_VERSION }),
    refresh: new KernelSteleOAuthRefreshLock(),
  });
}

export function safeSteleOAuthAdminErrorCode(error: unknown): SteleOAuthAdminErrorCode {
  return error instanceof SteleOAuthAdminError ? error.code : "unavailable";
}

class InteractiveInvalidClient extends Error {}

function handleAuthorizationError(
  callback: SteleOAuthCallback,
): asserts callback is Extract<SteleOAuthCallback, { kind: "code" }> {
  if (callback.kind === "code") return;
  if (callback.error === "access_denied") throw new SteleOAuthAdminError("cancelled");
  if (callback.error === "invalid_client") throw new InteractiveInvalidClient();
  throw new SteleOAuthAdminError("unavailable");
}

function isInvalidClient(error: unknown): boolean {
  return (
    error instanceof SteleOAuthHttpError &&
    error.code === "protocol" &&
    error.protocolCode === "invalid_client"
  );
}

function isReauthenticationError(error: unknown): boolean {
  return (
    error instanceof SteleOAuthHttpError &&
    error.code === "protocol" &&
    ["invalid_client", "invalid_grant", "invalid_scope"].includes(error.protocolCode ?? "")
  );
}

function normalizeAdminError(error: unknown): SteleOAuthAdminError {
  if (error instanceof SteleOAuthAdminError) return error;
  if (error instanceof InteractiveInvalidClient) return new SteleOAuthAdminError("unavailable");
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "busy"
  ) {
    return new SteleOAuthAdminError("busy");
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String(error.name) === "SteleOAuthCredentialStoreError"
  ) {
    return new SteleOAuthAdminError("credential_store_unavailable");
  }
  return new SteleOAuthAdminError("unavailable");
}

function publicStatus(
  state: "signed_out" | "authenticated" | "reauth_required",
): SteleOAuthPublicStatus {
  return { state, issuer: STELE_OAUTH_ISSUER, resource: STELE_OAUTH_RESOURCE, scope: STELE_OAUTH_SCOPE };
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SteleOAuthAdminError("unavailable");
  return value;
}

function validateInteractiveRegistration(
  value: OAuthClientRegistration,
  redirectUri: string,
  nowMs: number,
): OAuthClientRegistration {
  const parsed = OAuthClientRegistrationSchema.safeParse(value);
  if (!parsed.success) throw new SteleOAuthAdminError("unavailable");
  const registration = parsed.data;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    registration.software_version !== CLIENT_VERSION ||
    registration.redirect_uris[0] !== redirectUri ||
    registration.client_id_issued_at < nowSeconds - REGISTRATION_CLOCK_SKEW_SECONDS ||
    registration.client_id_issued_at > nowSeconds + REGISTRATION_CLOCK_SKEW_SECONDS ||
    registration.client_id_expires_at <= nowSeconds
  ) {
    throw new SteleOAuthAdminError("unavailable");
  }
  return registration;
}

async function compensateFailedRefreshCommit(
  store: SteleOAuthCredentialStore,
  protocol: SteleOAuthProtocol,
  current: SteleOAuthCredentialRecord,
  replacement: SteleOAuthCredentialRecord,
): Promise<void> {
  const revoked = await protocol.revoke({
    refreshToken: replacement.tokens.refreshToken,
    clientId: replacement.registration.clientId,
  }).then(() => true, () => false);
  const stored = await readForCompensation(store);
  if (stored === undefined || !isSafeCompensationState(stored, current, replacement)) return;

  const retained = revoked
    ? credentialRecordsEqual(stored, replacement)
      ? replacement
      : current
    : replacement;
  await store.write(markSteleOAuthReauthenticationRequired(retained)).catch(() => undefined);
}

async function compensateFailedInteractiveCommit(
  store: SteleOAuthCredentialStore,
  protocol: SteleOAuthProtocol,
  prior: SteleOAuthCredentialRecord | null,
  replacement: SteleOAuthCredentialRecord,
  revoke: { readonly refreshToken: string; readonly clientId: string },
): Promise<void> {
  const revoked = await protocol.revoke(revoke).then(() => true, () => false);
  const stored = await readForCompensation(store);
  if (stored === undefined || !isSafeCompensationState(stored, prior, replacement)) return;

  if (!revoked) {
    await store.write(
      markSteleOAuthReauthenticationRequired(replacement),
    ).catch(() => undefined);
    return;
  }
  if (prior !== null) {
    await store.write(
      markSteleOAuthReauthenticationRequired(prior),
    ).catch(() => undefined);
  } else if (credentialRecordsEqual(stored, replacement)) {
    await store.delete().catch(() => false);
  }
}

async function readForCompensation(
  store: SteleOAuthCredentialStore,
): Promise<SteleOAuthCredentialRecord | null | undefined> {
  try {
    return await store.read();
  } catch {
    return undefined;
  }
}

function isSafeCompensationState(
  stored: SteleOAuthCredentialRecord | null,
  prior: SteleOAuthCredentialRecord | null,
  replacement: SteleOAuthCredentialRecord,
): boolean {
  return (
    stored === null ||
    credentialRecordsEqual(stored, prior) ||
    credentialRecordsEqual(stored, replacement)
  );
}
