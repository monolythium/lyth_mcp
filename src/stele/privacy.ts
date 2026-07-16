const SENSITIVE_KEY = /^(?:authorization|cookie|mnemonic|passphrase|password|private[_-]?key|recovery[_-]?phrase|seed|secret|signed[_-]?payload|token)$/iu;
const SENSITIVE_QUERY = /([?&](?:access_token|api_key|key|password|secret|token)=)[^&#\s]*/giu;
const AUTHORIZATION_VALUE = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const URL_CREDENTIALS = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

/**
 * Redact values before they cross a diagnostic or logging boundary.
 * Stele tool responses are built from strict schemas; this helper is the
 * defensive fallback for startup/configuration diagnostics.
 */
export function redactSteleText(value: string): string {
  return value
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
