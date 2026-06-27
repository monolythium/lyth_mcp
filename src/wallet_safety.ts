import type { TxOutboxEntry } from "./outbox.js";
import type { OperationReceipt } from "./receipts.js";
import type { WalletSummary } from "./wallet.js";

export interface AccountSafetyProfileArgs {
  wallets: WalletSummary[];
  outboxEntries: TxOutboxEntry[];
  receipts: OperationReceipt[];
  walletName?: string;
  now?: Date;
}

export interface HotWalletPolicySimulationArgs {
  wallet: WalletSummary;
  amount: string;
  asset?: string;
  counterparty?: string;
  category?: string;
  now?: Date;
}

export interface ThresholdExplanationArgs {
  amount?: string;
  asset?: string;
  lowValueCap?: string;
  passkeyCap?: string;
  hardwareCap?: string;
  walletHasLowValuePolicy?: boolean;
  passkeyAvailable?: boolean;
  hardwareWalletAvailable?: boolean;
}

type RiskLevel = "low" | "medium" | "high" | "blocked";

export function accountSafetyProfiles(args: AccountSafetyProfileArgs) {
  const now = args.now ?? new Date();
  const wallets = args.walletName
    ? args.wallets.filter((wallet) => wallet.name === args.walletName)
    : args.wallets;
  if (args.walletName && wallets.length === 0) {
    throw new Error(`wallet '${args.walletName}' not found`);
  }
  const profiles = wallets.map((wallet) => accountSafetyProfile(wallet, args.outboxEntries, args.receipts, now));
  const highest = profiles.reduce<RiskLevel>((level, profile) => higherRisk(level, profile.risk.level), "low");
  return {
    checkedAt: now.toISOString(),
    walletCount: profiles.length,
    highestRisk: highest,
    profiles,
    productionNotes: [
      "MCP-local agent wallets are operating wallets, not custody wallets.",
      "TODO(wallet): replace local-only safety metadata with wallet handoff, passkey thresholds, hardware-wallet status, and on-chain policy reads.",
      "TODO(core): add SLH-DSA emergency-key and account-freeze status once core exposes it.",
    ],
  };
}

export function simulateHotWalletPolicy(args: HotWalletPolicySimulationArgs) {
  const amount = parseDecimal(args.amount);
  const asset = (args.asset ?? "LYTH").toUpperCase();
  const now = args.now ?? new Date();
  const lowValue = lowValuePolicy(args.wallet);
  const agent = agentMetadata(args.wallet);
  const violations: string[] = [];
  const warnings: string[] = [];
  const matchedClauses: string[] = [];

  if (asset !== "LYTH") {
    violations.push(`Local hot-wallet signing currently supports LYTH only, not ${asset}.`);
  }
  if (!lowValue?.enabled) {
    violations.push("Low-value hot-wallet mode is not enabled for this wallet.");
  } else {
    matchedClauses.push("lowValue.enabled=true");
    if (lowValue.maxAmount) {
      const max = parseDecimal(lowValue.maxAmount);
      if (amount > max) {
        violations.push(`Amount ${args.amount} exceeds per-transaction low-value cap ${lowValue.maxAmount} LYTH.`);
      } else {
        matchedClauses.push(`amount<=maxAmount(${lowValue.maxAmount})`);
      }
    }
    const remaining = lowValue.accounting?.remainingToday;
    if (remaining !== undefined) {
      const remainingUnits = parseDecimal(remaining);
      if (amount > remainingUnits) {
        violations.push(`Amount ${args.amount} exceeds remaining daily low-value allowance ${remaining} LYTH.`);
      } else {
        matchedClauses.push(`amount<=remainingToday(${remaining})`);
      }
    }
  }

  if (agent?.paused) {
    violations.push("Agent wallet is paused.");
  }
  if (agent?.expiresAt) {
    if (Date.parse(agent.expiresAt) <= now.getTime()) {
      violations.push(`Agent wallet policy expired at ${agent.expiresAt}.`);
    } else {
      matchedClauses.push(`now<expiresAt(${agent.expiresAt})`);
    }
  }
  if (args.counterparty && agent?.allowedCounterparties?.length) {
    if (!agent.allowedCounterparties.includes(args.counterparty)) {
      violations.push(`Counterparty ${args.counterparty} is not in the agent wallet allowlist.`);
    } else {
      matchedClauses.push("counterparty allowlist match");
    }
  }
  if (args.category && agent?.allowedCategories?.length) {
    if (!agent.allowedCategories.includes(args.category)) {
      violations.push(`Category ${args.category} is not in the agent wallet category allowlist.`);
    } else {
      matchedClauses.push("category allowlist match");
    }
  }
  if (args.wallet.keyProtection === "local_machine_key") {
    warnings.push("Wallet is protected by a local machine key. This is convenient for capped agents, but not suitable for high-value custody.");
  }
  if (agent?.fallbackApproval) {
    warnings.push(`Requests outside policy should fall back to ${agent.fallbackApproval}.`);
  }

  return {
    ok: violations.length === 0,
    checkedAt: now.toISOString(),
    wallet: {
      name: args.wallet.name,
      address: args.wallet.address,
      keyProtection: args.wallet.keyProtection,
      agent: args.wallet.agent,
      lowValue: args.wallet.lowValue,
    },
    request: {
      amount: args.amount,
      asset,
      counterparty: args.counterparty,
      category: args.category,
    },
    decision: violations.length === 0 ? "allow_low_value_signing" : "require_fallback_or_refuse",
    matchedClauses,
    violations,
    warnings,
    fallback: agent?.fallbackApproval ?? "passphrase",
  };
}

export function explainWalletThresholds(args: ThresholdExplanationArgs = {}) {
  const asset = (args.asset ?? "LYTH").toUpperCase();
  const amount = args.amount ? parseDecimal(args.amount) : null;
  const lowValueCap = args.lowValueCap ? parseDecimal(args.lowValueCap) : null;
  const passkeyCap = args.passkeyCap ? parseDecimal(args.passkeyCap) : null;
  const hardwareCap = args.hardwareCap ? parseDecimal(args.hardwareCap) : null;
  const tiers = [
    {
      tier: "agent_hot_wallet",
      available: args.walletHasLowValuePolicy === true,
      recommendedFor: "Small, explicitly authorized operating spends.",
      limit: args.lowValueCap ?? "user configured per-wallet low-value cap",
      approval: "No passphrase prompt after setup, but only inside the configured cap, daily limit, expiry, category, and counterparty policy.",
    },
    {
      tier: "passkey_or_wallet_handoff",
      available: args.passkeyAvailable !== false,
      recommendedFor: "Medium-value actions where the user should approve from a wallet/passkey UX.",
      limit: args.passkeyCap ?? "user configured passkey threshold",
      approval: "Wallet renders the action and the user approves with passkey or wallet session.",
    },
    {
      tier: "full_key_or_hardware_wallet",
      available: args.hardwareWalletAvailable !== false,
      recommendedFor: "High-value custody, policy changes, drains, recovery, and bridge/escrow actions.",
      limit: args.hardwareCap ?? "above passkey threshold",
      approval: "Full passphrase, hardware wallet, or future wallet-defined high-assurance approval.",
    },
  ];
  const selectedTier = amount === null
    ? null
    : lowValueCap !== null && amount <= lowValueCap && args.walletHasLowValuePolicy
      ? "agent_hot_wallet"
      : passkeyCap !== null && amount <= passkeyCap && args.passkeyAvailable !== false
        ? "passkey_or_wallet_handoff"
        : "full_key_or_hardware_wallet";
  return {
    asset,
    amount: args.amount,
    selectedTier,
    tiers,
    rules: [
      "Hot-wallet behavior must be explicitly enabled by the user and should hold only bounded operating funds.",
      "The agent may request funds or draft a transaction, but it cannot raise its own caps or refill itself without approval.",
      "A drain, policy change, recovery action, or high-value payment should bypass hot-wallet mode and require stronger approval.",
      "TODO(wallet): replace this local explanation with wallet-native passkey/hardware threshold metadata when available.",
    ],
  };
}

function accountSafetyProfile(
  wallet: WalletSummary,
  outboxEntries: TxOutboxEntry[],
  receipts: OperationReceipt[],
  now: Date,
) {
  const lowValue = lowValuePolicy(wallet);
  const agent = agentMetadata(wallet);
  const walletOutbox = outboxEntries.filter((entry) => entry.walletName === wallet.name);
  const openSigned = walletOutbox.filter((entry) => entry.status === "signed");
  const submitted = walletOutbox.filter((entry) => entry.status === "submitted");
  const failedReceipts = receipts.filter((receipt) => receipt.walletName === wallet.name && receipt.status === "failed");
  const warnings: string[] = [];
  const strengths: string[] = [];

  if (wallet.keyProtection === "passphrase") {
    strengths.push("Wallet mnemonic is encrypted under a passphrase.");
  } else {
    warnings.push("Wallet uses local-machine key protection; use only for capped agent operating funds.");
  }
  if (lowValue?.enabled) {
    warnings.push(`Low-value hot-wallet mode enabled: ${lowValue.maxAmount ?? "unknown"} LYTH per tx, ${lowValue.dailyLimit ?? "no"} daily cap.`);
  } else {
    strengths.push("Low-value hot-wallet signing is not enabled.");
  }
  if (agent?.paused) {
    strengths.push("Agent wallet is paused.");
  }
  if (agent?.expiresAt && Date.parse(agent.expiresAt) <= now.getTime()) {
    warnings.push(`Agent wallet policy expired at ${agent.expiresAt}.`);
  }
  if (openSigned.length > 0) {
    warnings.push(`${openSigned.length} signed outbox payload(s) are not submitted/settled yet.`);
  }
  if (submitted.length > 0) {
    warnings.push(`${submitted.length} submitted outbox payload(s) still need receipt confirmation.`);
  }
  if (failedReceipts.length > 0) {
    warnings.push(`${failedReceipts.length} recent failed receipt(s) are recorded for this wallet.`);
  }
  if (!agent?.purpose) {
    warnings.push("No explicit agent purpose is recorded.");
  }
  if (!agent?.expiresAt) {
    warnings.push("No agent-wallet expiry is recorded.");
  }

  const risk = profileRisk(wallet, openSigned.length, submitted.length, failedReceipts.length, warnings);
  return {
    wallet: {
      name: wallet.name,
      address: wallet.address,
      keyProtection: wallet.keyProtection,
      createdAt: wallet.createdAt,
    },
    risk,
    strengths,
    warnings,
    policy: {
      lowValue: wallet.lowValue ?? null,
      agent: wallet.agent ?? null,
    },
    outbox: {
      signed: openSigned.length,
      submitted: submitted.length,
      latest: walletOutbox.slice(0, 5).map((entry) => ({
        id: entry.id,
        status: entry.status,
        amount: entry.amount,
        asset: entry.asset,
        to: entry.to,
        expiresAt: entry.expiresAt,
      })),
    },
    recovery: {
      pauseTool: "agent_wallet_pause",
      drainTool: "agent_wallet_drain",
      deleteTool: "agent_wallet_delete",
      notes: [
        "Pause disables future low-value signing but cannot invalidate signed payloads copied elsewhere.",
        "Drain should require passphrase/local-key approval and then pause the wallet.",
      ],
    },
    missingProductionSignals: [
      "Recovery phrase backup status is local/user-held and not provable to MCP.",
      "SLH-DSA emergency-key status is TODO(core).",
      "Passkey/hardware-wallet status is TODO(wallet).",
      "On-chain spending policy status is TODO(core/wallet).",
    ],
  };
}

function profileRisk(
  wallet: WalletSummary,
  signedCount: number,
  submittedCount: number,
  failedReceiptCount: number,
  warnings: string[],
): { level: RiskLevel; score: number; reasons: string[] } {
  let score = 100;
  const reasons: string[] = [];
  if (wallet.keyProtection === "local_machine_key") {
    score -= 20;
    reasons.push("local_machine_key");
  }
  if (lowValuePolicy(wallet)?.enabled) {
    score -= 15;
    reasons.push("hot_wallet_enabled");
  }
  if (signedCount > 0) {
    score -= Math.min(25, signedCount * 8);
    reasons.push("signed_payloads_pending");
  }
  if (submittedCount > 0) {
    score -= Math.min(15, submittedCount * 5);
    reasons.push("submitted_payloads_pending");
  }
  if (failedReceiptCount > 0) {
    score -= Math.min(20, failedReceiptCount * 5);
    reasons.push("recent_failures");
  }
  if (warnings.some((warning) => warning.includes("expired"))) {
    score -= 15;
    reasons.push("expired_policy");
  }
  const normalized = Math.max(0, Math.min(100, score));
  return {
    score: normalized,
    level: normalized >= 85 ? "low" : normalized >= 65 ? "medium" : normalized >= 40 ? "high" : "blocked",
    reasons,
  };
}

function lowValuePolicy(wallet: WalletSummary): {
  enabled?: boolean;
  maxAmount?: string;
  dailyLimit?: string;
  accounting?: {
    remainingToday?: string;
  };
} | undefined {
  return wallet.lowValue as {
    enabled?: boolean;
    maxAmount?: string;
    dailyLimit?: string;
    accounting?: {
      remainingToday?: string;
    };
  } | undefined;
}

function agentMetadata(wallet: WalletSummary): {
  purpose?: string;
  maxBalance?: string;
  allowedCounterparties?: string[];
  allowedCategories?: string[];
  expiresAt?: string;
  fallbackApproval?: "passphrase" | "wallet_handoff" | "deny";
  paused?: boolean;
} | undefined {
  return wallet.agent as {
    purpose?: string;
    maxBalance?: string;
    allowedCounterparties?: string[];
    allowedCategories?: string[];
    expiresAt?: string;
    fallbackApproval?: "passphrase" | "wallet_handoff" | "deny";
    paused?: boolean;
  } | undefined;
}

function parseDecimal(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: ${input}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal asset`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function riskRank(level: RiskLevel): number {
  return level === "blocked" ? 4 : level === "high" ? 3 : level === "medium" ? 2 : 1;
}
