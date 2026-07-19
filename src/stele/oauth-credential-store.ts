import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  OAuthClientRegistrationSchema,
  OAuthClientIdSchema,
  OAuthTokenResponseSchema,
  OpaqueOAuthTokenSchema,
  STELE_OAUTH_CREDENTIAL_ACCOUNT,
  STELE_OAUTH_CREDENTIAL_SERVICE,
  STELE_OAUTH_CLIENT_REGISTRATION_MAX_LIFETIME_SECONDS,
  STELE_OAUTH_ISSUER,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
  type OAuthClientRegistration,
  type OAuthTokenResponse,
} from "./oauth-contract.js";

const SESSION_RECORD_VERSION = 1 as const;
const MAX_CREDENTIAL_RECORD_BYTES = 4_096;

const SteleOAuthCredentialRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECORD_VERSION),
    issuer: z.literal(STELE_OAUTH_ISSUER),
    resource: z.literal(STELE_OAUTH_RESOURCE),
    scope: z.literal(STELE_OAUTH_SCOPE),
    sessionState: z.enum(["active", "reauth_required"]),
    registration: z
      .object({
        clientId: OAuthClientIdSchema,
        issuedAt: z.number().int().nonnegative().safe().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
        expiresAt: z.number().int().positive().safe().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
      })
      .strict(),
    tokens: z
      .object({
        accessToken: OpaqueOAuthTokenSchema,
        accessExpiresAt: z.number().int().positive().safe(),
        refreshToken: OpaqueOAuthTokenSchema,
        generation: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.registration.expiresAt <= value.registration.issuedAt) {
      context.addIssue({ code: "custom", path: ["registration", "expiresAt"], message: "invalid lifetime" });
    } else if (
      value.registration.expiresAt - value.registration.issuedAt >
      STELE_OAUTH_CLIENT_REGISTRATION_MAX_LIFETIME_SECONDS
    ) {
      context.addIssue({ code: "custom", path: ["registration", "expiresAt"], message: "lifetime too long" });
    }
    if (value.tokens.accessToken === value.tokens.refreshToken) {
      context.addIssue({ code: "custom", path: ["tokens", "refreshToken"], message: "token collision" });
    }
  });

export type SteleOAuthCredentialRecord = z.infer<typeof SteleOAuthCredentialRecordSchema>;

export type SteleOAuthCredentialStoreErrorCode = "unavailable" | "corrupt";

export class SteleOAuthCredentialStoreError extends Error {
  override readonly name = "SteleOAuthCredentialStoreError";

  constructor(readonly code: SteleOAuthCredentialStoreErrorCode) {
    super("Stele OAuth credential store is unavailable");
  }
}

export interface SteleOAuthCredentialStore {
  read(): Promise<SteleOAuthCredentialRecord | null>;
  write(record: SteleOAuthCredentialRecord): Promise<void>;
  delete(): Promise<boolean>;
}

export interface OAuthKeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export class NativeSteleOAuthCredentialStore implements SteleOAuthCredentialStore {
  readonly #keytar: OAuthKeytarApi;

  constructor(keytar: OAuthKeytarApi) {
    this.#keytar = keytar;
  }

  async read(): Promise<SteleOAuthCredentialRecord | null> {
    let stored: string | null;
    try {
      stored = await this.#keytar.getPassword(
        STELE_OAUTH_CREDENTIAL_SERVICE,
        STELE_OAUTH_CREDENTIAL_ACCOUNT,
      );
    } catch {
      throw new SteleOAuthCredentialStoreError("unavailable");
    }
    if (stored === null) return null;
    try {
      if (Buffer.byteLength(stored, "utf8") > MAX_CREDENTIAL_RECORD_BYTES) {
        throw new SteleOAuthCredentialStoreError("corrupt");
      }
      const parsed: unknown = JSON.parse(stored);
      const validated = SteleOAuthCredentialRecordSchema.safeParse(parsed);
      if (!validated.success || encodeCredentialRecord(validated.data) !== stored) {
        throw new SteleOAuthCredentialStoreError("corrupt");
      }
      return validated.data;
    } catch (error) {
      if (error instanceof SteleOAuthCredentialStoreError) throw error;
      throw new SteleOAuthCredentialStoreError("corrupt");
    }
  }

  async write(record: SteleOAuthCredentialRecord): Promise<void> {
    const parsed = SteleOAuthCredentialRecordSchema.safeParse(record);
    if (!parsed.success) throw new SteleOAuthCredentialStoreError("corrupt");
    const encoded = encodeCredentialRecord(parsed.data);
    if (Buffer.byteLength(encoded, "utf8") > MAX_CREDENTIAL_RECORD_BYTES) {
      throw new SteleOAuthCredentialStoreError("corrupt");
    }
    try {
      await this.#keytar.setPassword(
        STELE_OAUTH_CREDENTIAL_SERVICE,
        STELE_OAUTH_CREDENTIAL_ACCOUNT,
        encoded,
      );
    } catch {
      throw new SteleOAuthCredentialStoreError("unavailable");
    }
    const readback = await this.read();
    if (readback === null || !credentialRecordsEqual(readback, parsed.data)) {
      throw new SteleOAuthCredentialStoreError("corrupt");
    }
  }

  async delete(): Promise<boolean> {
    try {
      return await this.#keytar.deletePassword(
        STELE_OAUTH_CREDENTIAL_SERVICE,
        STELE_OAUTH_CREDENTIAL_ACCOUNT,
      );
    } catch {
      throw new SteleOAuthCredentialStoreError("unavailable");
    }
  }
}

export function createSteleOAuthCredentialRecord(
  registration: OAuthClientRegistration,
  tokens: OAuthTokenResponse,
  nowMs: number,
  generation = 1,
): SteleOAuthCredentialRecord {
  const parsedRegistration = OAuthClientRegistrationSchema.safeParse(registration);
  const parsedTokens = OAuthTokenResponseSchema.safeParse(tokens);
  if (
    !parsedRegistration.success ||
    !parsedTokens.success ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new SteleOAuthCredentialStoreError("corrupt");
  }
  const validRegistration = parsedRegistration.data;
  const validTokens = parsedTokens.data;
  const accessExpiresAt = nowMs + validTokens.expires_in * 1_000;
  if (!Number.isSafeInteger(accessExpiresAt) || accessExpiresAt <= nowMs) {
    throw new SteleOAuthCredentialStoreError("corrupt");
  }
  const value: SteleOAuthCredentialRecord = {
    schemaVersion: SESSION_RECORD_VERSION,
    issuer: STELE_OAUTH_ISSUER,
    resource: STELE_OAUTH_RESOURCE,
    scope: STELE_OAUTH_SCOPE,
    sessionState: "active",
    registration: {
      clientId: validRegistration.client_id,
      issuedAt: validRegistration.client_id_issued_at,
      expiresAt: validRegistration.client_id_expires_at,
    },
    tokens: {
      accessToken: validTokens.access_token,
      accessExpiresAt,
      refreshToken: validTokens.refresh_token,
      generation,
    },
  };
  const parsed = SteleOAuthCredentialRecordSchema.safeParse(value);
  if (!parsed.success) throw new SteleOAuthCredentialStoreError("corrupt");
  return parsed.data;
}

export function rotateSteleOAuthCredentialRecord(
  current: SteleOAuthCredentialRecord,
  tokens: OAuthTokenResponse,
  nowMs: number,
): SteleOAuthCredentialRecord {
  const parsedCurrent = SteleOAuthCredentialRecordSchema.safeParse(current);
  const parsedTokens = OAuthTokenResponseSchema.safeParse(tokens);
  if (
    !parsedCurrent.success ||
    !parsedTokens.success ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    parsedCurrent.data.tokens.generation >= Number.MAX_SAFE_INTEGER ||
    parsedTokens.data.access_token === parsedCurrent.data.tokens.accessToken ||
    parsedTokens.data.access_token === parsedCurrent.data.tokens.refreshToken ||
    parsedTokens.data.refresh_token === parsedCurrent.data.tokens.accessToken ||
    parsedTokens.data.refresh_token === parsedCurrent.data.tokens.refreshToken
  ) {
    throw new SteleOAuthCredentialStoreError("corrupt");
  }
  const accessExpiresAt = nowMs + parsedTokens.data.expires_in * 1_000;
  if (!Number.isSafeInteger(accessExpiresAt) || accessExpiresAt <= nowMs) {
    throw new SteleOAuthCredentialStoreError("corrupt");
  }
  const rotated: SteleOAuthCredentialRecord = {
    ...parsedCurrent.data,
    sessionState: "active",
    tokens: {
      accessToken: parsedTokens.data.access_token,
      accessExpiresAt,
      refreshToken: parsedTokens.data.refresh_token,
      generation: parsedCurrent.data.tokens.generation + 1,
    },
  };
  const parsed = SteleOAuthCredentialRecordSchema.safeParse(rotated);
  if (!parsed.success) throw new SteleOAuthCredentialStoreError("corrupt");
  return parsed.data;
}

export function markSteleOAuthReauthenticationRequired(
  current: SteleOAuthCredentialRecord,
): SteleOAuthCredentialRecord {
  const parsed = SteleOAuthCredentialRecordSchema.safeParse({
    ...current,
    sessionState: "reauth_required",
  });
  if (!parsed.success) throw new SteleOAuthCredentialStoreError("corrupt");
  return parsed.data;
}

export async function createDefaultSteleOAuthCredentialStore(): Promise<SteleOAuthCredentialStore> {
  try {
    const imported: unknown = await import("@github/keytar");
    return new NativeSteleOAuthCredentialStore(oauthKeytarApiFromModule(imported));
  } catch (error) {
    if (error instanceof SteleOAuthCredentialStoreError) throw error;
    throw new SteleOAuthCredentialStoreError("unavailable");
  }
}

export function oauthKeytarApiFromModule(imported: unknown): OAuthKeytarApi {
  if (isOAuthKeytarApi(imported)) return imported;
  if (
    typeof imported === "object" &&
    imported !== null &&
    "default" in imported &&
    isOAuthKeytarApi(imported.default)
  ) {
    return imported.default;
  }
  throw new SteleOAuthCredentialStoreError("unavailable");
}

export function credentialRecordsEqual(
  left: SteleOAuthCredentialRecord | null,
  right: SteleOAuthCredentialRecord | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftBytes = Buffer.from(encodeCredentialRecord(left), "utf8");
  const rightBytes = Buffer.from(encodeCredentialRecord(right), "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function encodeCredentialRecord(record: SteleOAuthCredentialRecord): string {
  return JSON.stringify(record);
}

function isOAuthKeytarApi(value: unknown): value is OAuthKeytarApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "getPassword" in value &&
    typeof value.getPassword === "function" &&
    "setPassword" in value &&
    typeof value.setPassword === "function" &&
    "deletePassword" in value &&
    typeof value.deletePassword === "function"
  );
}
