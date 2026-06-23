export type ErrorClassification =
  | "broadcast_disabled"
  | "rpc_unavailable"
  | "insufficient_funds"
  | "nonce_or_duplicate"
  | "privacy_policy"
  | "commerce_safety"
  | "merchant_policy"
  | "bridge_route"
  | "contract_revert"
  | "user_rejected"
  | "unknown";

export interface ErrorExplainInput {
  errorMessage?: string;
  code?: string | number;
  rpcMethod?: string;
  tool?: string;
  txHash?: string;
  outboxId?: string;
  context?: unknown;
}

export interface ErrorExplanation {
  ok: false;
  classification: ErrorClassification;
  retryable: boolean;
  severity: "info" | "warning" | "blocked" | "unknown";
  plainEnglish: string;
  likelyCause: string;
  recommendedActions: string[];
  evidence: string[];
  policyFailures: string[];
  warnings: string[];
  assumptions: string[];
}

interface ErrorRule {
  classification: ErrorClassification;
  pattern: RegExp;
  retryable: boolean;
  severity: ErrorExplanation["severity"];
  plainEnglish: string;
  likelyCause: string;
  actions: string[];
}

const RULES: ErrorRule[] = [
  {
    classification: "broadcast_disabled",
    pattern: /(broadcast disabled|LYTH_MCP_ENABLE_SUBMIT|submit.*disabled)/i,
    retryable: false,
    severity: "info",
    plainEnglish: "The MCP refused to broadcast because live submission is disabled in local configuration.",
    likelyCause: "LYTH_MCP_ENABLE_SUBMIT is not set to 1.",
    actions: [
      "Enable LYTH_MCP_ENABLE_SUBMIT=1 only on a machine that is allowed to submit signed payloads.",
      "Keep the outbox payload if the user wants to submit it later.",
    ],
  },
  {
    classification: "rpc_unavailable",
    pattern: /(upstream unavailable|timeout|timed out|ECONN|fetch failed|network error|connection refused|503|502|504)/i,
    retryable: true,
    severity: "warning",
    plainEnglish: "The configured RPC path is unavailable or degraded.",
    likelyCause: "The selected node, upstream mempool, or network path did not answer reliably.",
    actions: [
      "Run rpc_health and retry on a healthy endpoint.",
      "Retry an existing outbox payload instead of rebuilding a transfer.",
    ],
  },
  {
    classification: "insufficient_funds",
    pattern: /(insufficient funds|balance too low|exceeds balance|not enough.*fee|cannot cover fee)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The sender cannot cover the amount plus fee ceiling.",
    likelyCause: "The wallet balance is below the requested spend or fee estimate.",
    actions: [
      "Fund the wallet or lower the amount.",
      "Run wallet_preflight_transfer before signing again.",
    ],
  },
  {
    classification: "nonce_or_duplicate",
    pattern: /(nonce too low|nonce too high|already known|known transaction|replacement transaction underpriced|transaction underpriced)/i,
    retryable: true,
    severity: "warning",
    plainEnglish: "The transaction conflicts with the sender nonce or an already-seen payload.",
    likelyCause: "A prior transaction may already be pending, or this payload is a duplicate/replacement with insufficient fee.",
    actions: [
      "Check tx_status_summary for the outbox or tx hash.",
      "Refresh the sender nonce before building any new transaction.",
    ],
  },
  {
    classification: "privacy_policy",
    pattern: /(PrivacyDenominationViolation|private-denominated|privacy cordon|private LYTH)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The request violates the public/private LYTH denomination guardrail.",
    likelyCause: "Private-denominated LYTH is intentionally blocked from commerce, bridges, staking, contracts, markets, discovery, escrow, and service payments.",
    actions: [
      "Use public LYTH or an allowed public/wrapped asset for this action.",
      "Use private LYTH only for private transfer, private burn, cross-to-private, or view flows.",
    ],
  },
  {
    classification: "commerce_safety",
    pattern: /(commerce safety|illicit|Blocked commerce policy|illegal goods|illegal services)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The MCP refused the request under local commerce safety policy.",
    likelyCause: "The assistant should not help source illegal goods or services, even if a listing exists somewhere.",
    actions: [
      "Choose a lawful vendor or service category.",
      "Review provider credentials and jurisdiction rules for restricted categories.",
    ],
  },
  {
    classification: "merchant_policy",
    pattern: /(merchant policy|denylisted|maxOrderAmount|allowlist|allowed category|allowed asset)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The request is blocked by local merchant risk controls.",
    likelyCause: "The vendor, asset, amount, or category violates the user's configured merchant policy.",
    actions: [
      "Inspect merchant_policy_get for this vendor.",
      "Change the amount/vendor/asset or update the policy with explicit user approval.",
    ],
  },
  {
    classification: "bridge_route",
    pattern: /(bridge route|circuit breaker|drain cap|cooldown|route.*paused|route status is|executable.*false|not active)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The bridge route is not currently safe or executable.",
    likelyCause: "The route may be draft, paused, over cap, missing Chainlink CCIP metadata, or missing LINK fee-token metadata.",
    actions: [
      "Run bridge_quote and bridge_circuit_breaker_watch for the asset/route.",
      "Use only active Chainlink CCIP routes with LINK fee-token metadata.",
    ],
  },
  {
    classification: "contract_revert",
    pattern: /(execution reverted|revert|contract.*failed|VM Exception|invalid opcode)/i,
    retryable: false,
    severity: "blocked",
    plainEnglish: "The transaction executed but failed inside contract or VM logic.",
    likelyCause: "A contract precondition, typed error, or runtime check failed.",
    actions: [
      "Use tx_lookup to fetch the decoded receipt/status when available.",
      "TODO(core): decode typed contract errors once the Rust/RISC-V contract module exposes them.",
    ],
  },
  {
    classification: "user_rejected",
    pattern: /(user rejected|user denied|rejected by user|approval rejected|cancelled by user)/i,
    retryable: false,
    severity: "info",
    plainEnglish: "The user or wallet rejected the approval.",
    likelyCause: "The wallet prompt was cancelled or denied.",
    actions: [
      "Ask for explicit approval again only if the user still wants the action.",
      "Do not submit or rebuild without renewed user intent.",
    ],
  },
];

export function explainError(input: ErrorExplainInput): ErrorExplanation {
  const haystack = [
    input.errorMessage,
    input.code === undefined ? undefined : String(input.code),
    input.rpcMethod,
    input.tool,
    stringify(input.context),
  ].filter(Boolean).join("\n");
  const policyFailures = unique([
    ...collectStrings(input.context, "violations"),
    ...collectStrings(input.context, "refusal"),
  ]);
  const warnings = unique(collectStrings(input.context, "warnings"));
  const rule = ruleFromContext(policyFailures, warnings) ?? RULES.find((entry) => entry.pattern.test(haystack));
  const fallback: ErrorRule = {
    classification: "unknown",
    pattern: /.*/,
    retryable: false,
    severity: "unknown",
    plainEnglish: "The MCP could not classify this error with the local explanation table.",
    likelyCause: "The error may need a typed core/indexer error code or direct receipt decode.",
    actions: [
      "Run tx_lookup or tx_status_summary if a tx hash or outbox id exists.",
      "Preserve the exact error message for debugging.",
      "TODO(core): replace string matching with typed protocol/indexer error codes.",
    ],
  };
  const selected = rule ?? fallback;
  return {
    ok: false,
    classification: selected.classification,
    retryable: selected.retryable,
    severity: selected.severity,
    plainEnglish: selected.plainEnglish,
    likelyCause: selected.likelyCause,
    recommendedActions: selected.actions,
    evidence: evidence(input, selected, haystack),
    policyFailures,
    warnings,
    assumptions: [
      "This explanation is local MCP guidance, not a consensus result.",
      "TODO(mainnet): prefer typed RPC/indexer errors over string matching when core exposes them.",
      input.outboxId ? `Outbox retry path: tx_outbox_retry id=${input.outboxId}.` : "If a signed payload exists in the outbox, retry that payload instead of rebuilding.",
      input.txHash ? `Receipt/status path: tx_lookup txHash=${input.txHash}.` : "If a tx hash exists, check tx_lookup or tx_status_summary before retrying.",
    ],
  };
}

function ruleFromContext(policyFailures: string[], warnings: string[]): ErrorRule | undefined {
  const text = [...policyFailures, ...warnings].join("\n");
  return RULES.find((entry) => entry.pattern.test(text));
}

function evidence(input: ErrorExplainInput, rule: ErrorRule, haystack: string): string[] {
  const items = [
    input.errorMessage ? `errorMessage: ${input.errorMessage}` : undefined,
    input.code !== undefined ? `code: ${input.code}` : undefined,
    input.rpcMethod ? `rpcMethod: ${input.rpcMethod}` : undefined,
    input.tool ? `tool: ${input.tool}` : undefined,
    rule.classification !== "unknown" && rule.pattern.test(haystack) ? `matched: ${rule.classification}` : undefined,
  ];
  return items.filter((item): item is string => Boolean(item));
}

function collectStrings(value: unknown, key: string, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return key === "refusal" ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, key, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const direct = record[key];
  const found = Array.isArray(direct)
    ? direct.filter((item): item is string => typeof item === "string")
    : typeof direct === "string"
      ? [direct]
      : [];
  return [
    ...found,
    ...Object.entries(record)
      .filter(([entryKey]) => entryKey !== key)
      .flatMap(([, entryValue]) => collectStrings(entryValue, key, depth + 1)),
  ];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
