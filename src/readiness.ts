export type ReadinessGateId =
  | "no_evm"
  | "mrc"
  | "agent_commerce"
  | "bridge"
  | "wallet"
  | "runbook"
  | "security"
  | "docs"
  | "tests"
  | "external_commerce";

export interface ReadinessContext {
  toolNames: string[];
  runbookCount: number;
  vendorCount: number;
  bridgeRouteCount: number;
  activeBridgeRouteCount: number;
  assetCount: number;
  walletCount: number;
  docsUpdated?: boolean;
  testsUpdated?: boolean;
}

export function readinessCheck(ctx: ReadinessContext, gate?: ReadinessGateId | "all") {
  const gates = buildReadinessGates(ctx);
  const selected = gate && gate !== "all"
    ? gates.filter((item) => item.id === gate)
    : gates;
  if (gate && gate !== "all" && selected.length === 0) {
    throw new Error(`readiness gate '${gate}' not found`);
  }
  const completion = Math.round(selected.reduce((sum, item) => sum + item.percent, 0) / Math.max(1, selected.length));
  return {
    checkedAt: new Date().toISOString(),
    gate: gate ?? "all",
    completionPercent: completion,
    status: completion >= 80 ? "near_ready" : completion >= 60 ? "partial" : completion >= 40 ? "early" : "blocked",
    gates: selected,
    mainnetWarning: "This is an MCP readiness dashboard. Mainnet readiness still requires core, SDK, indexer, wallet, audit, and testnet evidence.",
  };
}

export function buildReadinessGates(ctx: ReadinessContext) {
  return [
    gate({
      id: "no_evm",
      title: "No-EVM Readiness",
      percent: has(ctx, "contract_path_guidance") ? 55 : 25,
      done: [
        "MCP gives explicit Solidity/EVM refusal and Rust/RISC-V guidance.",
        "Native asset/bridge/vendor flows avoid EVM contract assumptions.",
      ],
      missing: [
        "Rust/RISC-V contract package, deploy, call, query, event, gas/cycle tools.",
        "Core-backed VM/version/gate status.",
      ],
    }),
    gate({
      id: "mrc",
      title: "MRC Asset Readiness",
      percent: hasAll(ctx, ["asset_registry_info", "asset_search", "asset_risk_label"]) ? 30 : 15,
      done: [
        `${ctx.assetCount} local asset records with risk labels and privacy-denomination policy.`,
        "Native/wrapped/issuer/private labels are visible to wallets and assistants.",
      ],
      missing: [
        "Live MRC-20/721/1155/4626 balances, transfers, approvals, metadata validation, and receipts.",
        "Indexer decoding for native asset and market events.",
      ],
    }),
    gate({
      id: "agent_commerce",
      title: "Agent-Commerce Readiness",
      percent: hasAll(ctx, ["vendor_search", "order_create", "booking_request_create", "funding_request_create", "provider_onboarding_draft"]) ? 65 : 35,
      done: [
        `${ctx.vendorCount} local demo vendors, local orders, bookings, invoices, funding requests, merchant policies, and connector hooks.`,
        "Commerce safety and risk summaries are enforced before local demo orders/bookings.",
      ],
      missing: [
        "On-chain discovery, reputation, availability, attestation, consent, issuer, escrow, arbiter, and counter-offer modules.",
        "Real vendor verification and production connector approvals.",
      ],
    }),
    gate({
      id: "bridge",
      title: "Bridge And Liquidity Readiness",
      percent: hasAll(ctx, ["bridge_routes", "bridge_quote", "bridge_circuit_breaker_watch", "liquidity_onboarding"]) ? 50 : 25,
      done: [
        `${ctx.bridgeRouteCount} route records, ${ctx.activeBridgeRouteCount} active route records, cooldown matrix, risk labels, drain caps, and circuit-breaker watch.`,
        "Assistant can explain USDC/BTC/ETH-style liquidity paths without pretending draft routes are executable.",
      ],
      missing: [
        "Core/indexer route registry, light-client freshness, proof verifier state, bridge quote/preflight, lock/mint and burn/unlock builders.",
        "Cross-chain swap intents, claim/status tools, and settlement proof verification.",
      ],
    }),
    gate({
      id: "wallet",
      title: "Wallet And Policy Readiness",
      percent: hasAll(ctx, ["agent_wallet_create", "wallet_preflight_transfer", "wallet_build_transfer", "wallet_safety_profile", "hot_wallet_policy_simulate"]) ? 70 : 45,
      done: [
        `${ctx.walletCount} local wallet(s), explicit agent hot-wallet setup, preflight, outbox, receipts, drain/pause/delete, safety profile, and hot-wallet policy simulation.`,
        "Small-spend hot-wallet behavior is opt-in and cap-bound.",
      ],
      missing: [
        "Production wallet handoff, passkey/hardware thresholds, on-chain spending policies, real agent subaccounts, and SLH-DSA emergency-key support.",
      ],
    }),
    gate({
      id: "runbook",
      title: "Runbook Readiness",
      percent: hasAll(ctx, ["runbook_list", "runbook_get", "validate_runbook", "prepare_wallet_request"]) ? 60 : 35,
      done: [
        `${ctx.runbookCount} local canonical runbooks with stable hashes and validation attachment.`,
        "Payment, booking, escrow, trade, policy, receipt, and vendor-rating drafts exist.",
      ],
      missing: [
        "Final SDK schema with JCS/RFC 8785 and BLAKE3, signed registry, execution state machine, pre/post-condition engine, monitors, and full receipts.",
      ],
    }),
    gate({
      id: "security",
      title: "Security And Emergency Readiness",
      percent: hasAll(ctx, ["security_status", "emergency_state_watch", "bridge_blast_radius", "recovery_status"]) ? 65 : 35,
      done: [
        "Local threat posture, emergency watcher, bridge blast-radius monitor, recovery runbook drafts, RPC health, outbox, receipts, and privacy guardrails.",
      ],
      missing: [
        "Core-backed G3/PQ emergency declarations, checkpoint verification, Ferveo threshold status, verifier gates, bridge settlement state, and audit/research gates from signed metadata.",
      ],
    }),
    gate({
      id: "docs",
      title: "Documentation Readiness",
      percent: ctx.docsUpdated ? 70 : 45,
      done: [
        "README covers install, tools, wallet setup, vendors, bridges, clusters, and local workflow examples.",
        "Dedicated docs cover Claude/Codex usage, operators, vendor registries, and runbooks.",
      ],
      missing: [
        "Production deployment guide, wallet handoff guide, SDK compatibility matrix, security model signoff, and end-user app docs.",
      ],
    }),
    gate({
      id: "external_commerce",
      title: "External Commerce (EVM + x402 + NOWPayments + Travala)",
      percent: hasAll(ctx, [
        "evm_wallet_create",
        "erc20_transfer",
        "x402_pay",
        "x402_vendor_policy_set",
        "agent_identity_set_local",
        "nowpayments_configure",
        "nowpayments_ipn_verify",
        "travala_book_pay",
      ]) ? 55 : 25,
      done: [
        "EVM hot-wallet primitive (secp256k1, encrypted, per-(chain,asset) caps) on Ethereum + Base.",
        "EIP-1559 native + ERC-20 builders with EIP-712 signing and outbox/receipt integration.",
        "x402 client with EIP-3009 USDC authorization, origin allowlist, per-vendor caps, dry-run mode.",
        "NOWPayments connector (sandbox/prod toggle, x-api-key, IPN HMAC-SHA512 verifier).",
        "Travala bridge tools that pay through Travala's hosted MCP via x402, with ERC-8004 agentId + rewardWallet attribution.",
        "Coinsbee interim path via NOWPayments-issued invoices.",
      ],
      missing: [
        "LYTH_MCP_ENABLE_EVM_SUBMIT live broadcast flag is OFF by default until production switch is approved (principal-signed approval, empty outbox, caps explicitly set).",
        "ERC-8004 on-chain agent_identity_register_draft (gated on a verified Base-mainnet IdentityRegistry address).",
        "Direct Coinsbee reseller API (partnership-gated, no fabricated endpoints).",
        "Live verification of Travala MCP response shapes (current parser handles structured + text content + paymentUrl flavors).",
      ],
    }),
    gate({
      id: "tests",
      title: "Test Readiness",
      percent: ctx.testsUpdated ? 60 : 40,
      done: [
        "Dist-based smoke test covers stores, connectors, policies, orders, bookings, invoices, assets, bridge routes, clusters, staking, node metadata, security, readiness, and wallet safety helpers.",
        "Golden failure fixtures cover common RPC/policy/bridge/privacy failure explanations.",
      ],
      missing: [
        "Unit test suite, mock RPC integration coverage for live server tools, live testnet smoke tests gated by env, and SDK fixture harness.",
      ],
    }),
  ];
}

function gate(args: {
  id: ReadinessGateId;
  title: string;
  percent: number;
  done: string[];
  missing: string[];
}) {
  return {
    ...args,
    status: args.percent >= 80 ? "near_ready" : args.percent >= 60 ? "partial" : args.percent >= 40 ? "early" : "blocked",
    next: args.missing[0],
  };
}

function has(ctx: ReadinessContext, toolName: string): boolean {
  return ctx.toolNames.includes(toolName);
}

function hasAll(ctx: ReadinessContext, toolNames: string[]): boolean {
  return toolNames.every((toolName) => has(ctx, toolName));
}
