const SENSITIVE_KEY = /^(?:access[_-]?token|authorization|authorization[_-]?code|callback|callback[_-]?(?:uri|url)|challenge|client[_-]?id|code|code[_-]?challenge|code[_-]?verifier|cookie|mnemonic|oauth[_-]?state|passphrase|password|private[_-]?key|recovery[_-]?phrase|redirect[_-]?uri|refresh[_-]?token|seed|secret|signed[_-]?payload|state|token|verifier)$/iu;
const SENSITIVE_QUERY = /([?&](?:access_token|api_key|authorization_code|client_id|code|code_challenge|code_verifier|key|password|redirect_uri|refresh_token|secret|state|token)=)[^&#\s]*/giu;
const AUTHORIZATION_VALUE = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const URL_CREDENTIALS = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const LOOPBACK_CALLBACK_URL = /\bhttp:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/callback\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])(?:[?#][^\s]*)?/giu;
const CALLBACK_PATH_ID = /\/callback\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu;

/**
 * Redact values before they cross a diagnostic or logging boundary.
 * Stele tool responses are built from strict schemas; this helper is the
 * defensive fallback for startup/configuration diagnostics.
 */
export function redactSteleText(value: string): string {
  return value
    .replace(LOOPBACK_CALLBACK_URL, "[REDACTED:LOOPBACK_CALLBACK]")
    .replace(CALLBACK_PATH_ID, "/callback/[REDACTED]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(AUTHORIZATION_VALUE, "[REDACTED]")
    .replace(SENSITIVE_QUERY, "$1[REDACTED]");
}

export function redactSteleValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSteleText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:CYCLE]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry, seen);
  }
  return output;
}

export function safeSteleError(code: SteleSafeErrorCode) {
  return { code } as const;
}

export type SteleSafeErrorCode =
  | "capability_unavailable"
  | "invalid_request"
  | "network_identity_mismatch"
  | "stele_unavailable";
