import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const STELE_OAUTH_ISSUER = "https://stele.monolythium.com" as const;
export const STELE_OAUTH_RESOURCE = "https://stele.monolythium.com/mcp" as const;
export const STELE_OAUTH_SCOPE = "stele:public:read" as const;
export const STELE_OAUTH_CREDENTIAL_SERVICE = "com.monolythium.stele.oauth-session" as const;
export const STELE_OAUTH_CREDENTIAL_ACCOUNT = "hosted-mcp-v1:production" as const;
export const STELE_OAUTH_CLIENT_REGISTRATION_MAX_LIFETIME_SECONDS = 31_536_000 as const;

export const STELE_OAUTH_ENDPOINTS = Object.freeze({
  metadata: `${STELE_OAUTH_ISSUER}/.well-known/oauth-authorization-server`,
  protectedResource: `${STELE_OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp`,
  authorize: `${STELE_OAUTH_ISSUER}/oauth/authorize`,
  token: `${STELE_OAUTH_ISSUER}/oauth/token`,
  register: `${STELE_OAUTH_ISSUER}/oauth/register`,
  revoke: `${STELE_OAUTH_ISSUER}/oauth/revoke`,
  introspect: `${STELE_OAUTH_ISSUER}/oauth/introspect`,
});

export const OpaqueOAuthTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const OAuthClientIdSchema = z.string().regex(/^stc_[A-Za-z0-9_-]{32,64}$/u);
export const OAuthLoopbackRedirectSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.toString() === value &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        /^[1-9][0-9]{0,4}$/u.test(url.port) &&
        Number(url.port) <= 65_535 &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        /^\/callback\/[A-Za-z0-9_-]{43}$/u.test(url.pathname)
      );
    } catch {
      return false;
    }
  });

const OAuthServerMetadataSchema = z
  .object({
    issuer: z.literal(STELE_OAUTH_ISSUER),
    authorization_endpoint: z.literal(STELE_OAUTH_ENDPOINTS.authorize),
    token_endpoint: z.literal(STELE_OAUTH_ENDPOINTS.token),
    registration_endpoint: z.literal(STELE_OAUTH_ENDPOINTS.register),
    revocation_endpoint: z.literal(STELE_OAUTH_ENDPOINTS.revoke),
    introspection_endpoint: z.literal(STELE_OAUTH_ENDPOINTS.introspect),
    response_types_supported: z.tuple([z.literal("code")]),
    grant_types_supported: z.tuple([
      z.literal("authorization_code"),
      z.literal("refresh_token"),
    ]),
    token_endpoint_auth_methods_supported: z.tuple([z.literal("none")]),
    revocation_endpoint_auth_methods_supported: z.tuple([z.literal("none")]),
    introspection_endpoint_auth_methods_supported: z.tuple([
      z.literal("client_secret_basic"),
    ]),
    code_challenge_methods_supported: z.tuple([z.literal("S256")]),
    scopes_supported: z.tuple([
      z.literal("stele:public:read"),
      z.literal("stele:drafts:write"),
    ]),
  })
  .strip();

const OAuthProtectedResourceMetadataSchema = z
  .object({
    resource: z.literal(STELE_OAUTH_RESOURCE),
    authorization_servers: z.tuple([z.literal(STELE_OAUTH_ISSUER)]),
    scopes_supported: z.tuple([
      z.literal("stele:public:read"),
      z.literal("stele:drafts:write"),
    ]),
    bearer_methods_supported: z.tuple([z.literal("header")]),
  })
  .strip();

export const OAuthClientRegistrationSchema = z
  .object({
    redirect_uris: z.tuple([OAuthLoopbackRedirectSchema]),
    application_type: z.literal("native"),
    token_endpoint_auth_method: z.literal("none"),
    grant_types: z.tuple([z.literal("authorization_code"), z.literal("refresh_token")]),
    response_types: z.tuple([z.literal("code")]),
    client_name: z.literal("Lyth Stele MCP"),
    scope: z.literal(STELE_OAUTH_SCOPE),
    software_id: z.literal("com.monolythium.lyth-mcp.stele"),
    software_version: z.string().regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u),
    client_id: OAuthClientIdSchema,
    client_id_issued_at: z.number().int().nonnegative().safe().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
    client_id_expires_at: z.number().int().positive().safe().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
  })
  .strip()
  .superRefine((value, context) => {
    if (value.client_id_expires_at <= value.client_id_issued_at) {
      context.addIssue({ code: "custom", path: ["client_id_expires_at"], message: "invalid lifetime" });
      return;
    }
    if (
      value.client_id_expires_at - value.client_id_issued_at >
      STELE_OAUTH_CLIENT_REGISTRATION_MAX_LIFETIME_SECONDS
    ) {
      context.addIssue({ code: "custom", path: ["client_id_expires_at"], message: "lifetime too long" });
    }
  });

export const OAuthTokenResponseSchema = z
  .object({
    access_token: OpaqueOAuthTokenSchema,
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive().max(86_400),
    refresh_token: OpaqueOAuthTokenSchema,
    scope: z.literal(STELE_OAUTH_SCOPE),
  })
  .strip()
  .superRefine((value, context) => {
    if (value.access_token === value.refresh_token) {
      context.addIssue({ code: "custom", path: ["refresh_token"], message: "token collision" });
    }
  });

export const OAuthProtocolErrorSchema = z
  .object({
    error: z.enum([
      "invalid_request",
      "invalid_client",
      "invalid_client_metadata",
      "invalid_redirect_uri",
      "invalid_grant",
      "invalid_scope",
      "temporarily_unavailable",
      "unsupported_grant_type",
      "unsupported_response_type",
    ]),
    error_description: z.string().min(1).max(512),
  })
  .strip();

export type OAuthServerMetadata = z.infer<typeof OAuthServerMetadataSchema>;
export type OAuthProtectedResourceMetadata = z.infer<
  typeof OAuthProtectedResourceMetadataSchema
>;
export type OAuthClientRegistration = z.infer<typeof OAuthClientRegistrationSchema>;
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>;
export type OAuthProtocolErrorCode = z.infer<typeof OAuthProtocolErrorSchema>["error"];

export function parseOAuthServerMetadata(value: unknown): OAuthServerMetadata {
  return OAuthServerMetadataSchema.parse(value);
}

export function parseOAuthProtectedResourceMetadata(
  value: unknown,
): OAuthProtectedResourceMetadata {
  return OAuthProtectedResourceMetadataSchema.parse(value);
}

export function createOAuthRegistrationRequest(redirectUri: string, version: string) {
  OAuthLoopbackRedirectSchema.parse(redirectUri);
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error("Invalid OAuth client version");
  }
  return {
    redirect_uris: [redirectUri],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Lyth Stele MCP",
    scope: STELE_OAUTH_SCOPE,
    software_id: "com.monolythium.lyth-mcp.stele",
    software_version: version,
  } as const;
}

export interface SteleOAuthPkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

export function createSteleOAuthPkce(): SteleOAuthPkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

export function buildSteleAuthorizationUrl(
  registration: OAuthClientRegistration,
  redirectUri: string,
  pkce: SteleOAuthPkce,
): URL {
  const validRegistration = OAuthClientRegistrationSchema.parse(registration);
  OAuthLoopbackRedirectSchema.parse(redirectUri);
  if (validRegistration.redirect_uris[0] !== redirectUri) {
    throw new Error("OAuth redirect mismatch");
  }
  for (const value of [pkce.verifier, pkce.challenge, pkce.state]) {
    OpaqueOAuthTokenSchema.parse(value);
  }
  const expectedChallenge = Buffer.from(
    createHash("sha256").update(pkce.verifier, "ascii").digest("base64url"),
    "ascii",
  );
  const suppliedChallenge = Buffer.from(pkce.challenge, "ascii");
  try {
    if (
      expectedChallenge.length !== suppliedChallenge.length ||
      !timingSafeEqual(expectedChallenge, suppliedChallenge)
    ) {
      throw new Error("OAuth PKCE challenge mismatch");
    }
  } finally {
    expectedChallenge.fill(0);
    suppliedChallenge.fill(0);
  }
  const url = new URL(STELE_OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", validRegistration.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", STELE_OAUTH_SCOPE);
  url.searchParams.set("resource", STELE_OAUTH_RESOURCE);
  if (Buffer.byteLength(`${url.pathname}${url.search}`, "utf8") > 8_192) {
    throw new Error("OAuth authorization request is too large");
  }
  return url;
}

export function oauthStateMatches(actual: string, expected: string): boolean {
  if (!OpaqueOAuthTokenSchema.safeParse(actual).success || !OpaqueOAuthTokenSchema.safeParse(expected).success) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  try {
    return timingSafeEqual(actualBytes, expectedBytes);
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
}
