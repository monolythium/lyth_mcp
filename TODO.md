# Lyth MCP Todo

Whitepaper-driven backlog for turning `lyth-mcp` from an MVP wallet/runbook helper into the AI-legibility layer described by Monolythium whitepaper v4.1.

Source reviewed:

- `whitepaper/v4.1/README.md`
- `whitepaper/v4.1/OUTLINE.md`
- `whitepaper/v4.1/10_thesis_settlement_layer.md`
- `whitepaper/v4.1/11_why_no_governance.md`
- `whitepaper/v4.1/12_why_no_perps.md`
- `whitepaper/v4.1/13_bifurcated_denomination.md`
- `whitepaper/v4.1/14_cluster_marketplace.md`
- `whitepaper/v4.1/17_why_rust_riscv.md`
- `whitepaper/v4.1/18_market_positioning.md`
- `whitepaper/v4.1/19_bridge_to_technical.md`
- `whitepaper/v4.1/20_consensus_starfish.md`
- `whitepaper/v4.1/21_cryptography.md`
- `whitepaper/v4.1/22_execution_riscv.md`
- `whitepaper/v4.1/23_cluster_economics.md`
- `whitepaper/v4.1/24_agent_commerce_primitives.md`
- `whitepaper/v4.1/25_privacy_bifurcation.md`
- `whitepaper/v4.1/26_bridge_model.md`
- `whitepaper/v4.1/27_sdk_runbooks.md`
- `whitepaper/v4.1/28_hardware_sovereignty.md`
- `whitepaper/v4.1/29_threat_model.md`
- `whitepaper/v4.1/30_recovery_emergency.md`
- `whitepaper/v4.1/99_research_disclaimer.md`

Legend:

- **MCP**: can be built inside this repo against current or mocked surfaces.
- **SDK**: depends on `mono-core-sdk` types/builders.
- **CORE**: depends on mono-core protocol/RPC/module implementation.
- **WALLET**: depends on desktop/browser/mobile wallet approval UX.
- **INDEXER**: depends on Monoscan/indexer views.

## Current MVP Coverage

- [x] Live chain status, account overview, transaction lookup, recent tx feed, search, market read helpers.
- [x] Local encrypted PQM-1 / ML-DSA-65 wallet storage.
- [x] Local-machine protected low-value testnet wallet flow.
- [x] Native LYTH transfer builder and optional encrypted broadcast.
- [x] Signed-payload outbox and retry guidance when broadcast fails.
- [x] Local receipts for drafted, signed, submitted, and failed MCP operations.
- [x] Explicit low-value agent wallet tools with purpose, caps, pause, drain, delete, and funding request.
- [x] MCP self-check and Markdown dashboard for text/TUI-style clients.
- [x] Transfer preflight, RPC health scoring, tx watcher, and bucketed low-value accounting.
- [x] Low-value reservation expiry/manual release and approval summary rendering.
- [x] Local canonical runbook registry tools with stable content hashes.
- [x] Draft/validate/prepare flows attach canonical runbook metadata and required-field checks.
- [x] Vendor registry hashes/signature status, demo order lifecycle, and dry-run fulfillment adapter.
- [x] Local invoices and funding requests with canonical request-funds drafts.
- [x] Local addressbook with named-recipient transfer resolution.
- [x] Demo vendor registry with pizza, flight, plumber, gift-card, and legal-review examples.
- [x] Draft runbooks for payment, service booking, escrow, trade, policy, receipt, and vendor-rating flows.
- [x] Global GitHub tarball install with committed `dist/`.

## Product Target

The MCP should become the interface an AI agent uses to answer and execute:

- "What can I safely do on Mono?"
- "What assets, markets, bridges, services, agents, and operators exist?"
- "Can I spend this amount under my policy?"
- "Can I hire, negotiate, escrow, receive, dispute, and rate?"
- "Can I bridge or swap this asset, and what is the route risk?"
- "Can I deploy or call a Rust/RISC-V contract?"
- "Can I prove what happened, explain why it failed, and show a receipt?"

The MCP may support explicitly authorized agent hot-wallet behavior for small spending. The agent can create its own wallet, but only after the user approves the wallet purpose, network, funding limit, per-transaction cap, daily/epoch cap, expiry, and recovery/drain path. The MCP must never become a hidden or unrestricted hot wallet: every money-moving path requires explicit user approval or a previously configured, auditable, bounded policy.

## P0: Reliability And Safety Baseline

Whitepaper refs: §10, §24.10, §27.6, §29.1.

- [x] **MCP** Add a local signed-transaction outbox.
  - Tools: `tx_outbox_list`, `tx_outbox_get`, `tx_outbox_retry`, `tx_outbox_forget`.
  - Store signed payload, from, to, amount, nonce, route, created time, runbook hash, policy snapshot, and broadcast attempts.
  - Prevent repeated rebuild/re-sign loops after transient mempool or RPC failures.
- [x] **MCP** Split low-value accounting into `reserved`, `submitted`, `confirmed`, `failed`, and `expired`.
  - Keep the conservative rule that signed payloads reserve allowance.
  - Track allowance per agent wallet, not just globally.
- [x] **MCP** Add low-value reservation expiry and manual release.
  - Add expiry/garbage-collection for old unsubmitted payloads.
  - Add a manual user-approved release flow for stale reservations.
- [x] **MCP** Add preflight checks before signing.
  - Chain id and network match.
  - Wallet balance covers amount + fee.
  - Nonce is current.
  - RPC endpoint is synced.
  - Mempool endpoint is healthy.
  - Encryption key epoch is current.
  - Policy allows the spend.
  - Recipient resolves cleanly.
- [x] **MCP** Add RPC node health scoring and endpoint quarantine.
  - Track response latency, sync lag, method failures, mempool decryption failures, stale encryption keys, and bad chain id.
  - Route write attempts away from bad nodes.
  - Expose `rpc_health` and include selected endpoint rationale in all signing responses.
- [x] **MCP** Add pending transaction watcher.
  - Tools: `tx_watch`, `tx_status_summary`.
  - Poll `tx_lookup`, receipt, nonce, and account balance deltas.
  - Return `drafted`, `signed`, `submitted`, `pending`, `confirmed`, `failed`, `not_found`, `expired`.
- [x] **MCP** Add local receipts.
  - Persist every drafted/signed/submitted/confirmed/failed operation as JSON.
  - Include runbook id/hash, policy decision, signed payload hash, tx hash, receipt, and final status.
  - Tools: `receipt_list`, `receipt_get`, `receipt_export`.
- [x] **MCP** Add human-readable approval summaries.
  - "Send 0.1 LYTH from pizza-agent to Neo. Estimated fee X. Balance after Y. Policy cap remaining Z."
  - Show route risk for bridge/swap operations before signing.
- [x] **MCP** Add MCP self-check.
  - Tool: `mcp_self_check`.
  - Verify install version, SDK version, env config, writable stores, wallet file permissions, addressbook path, broadcast mode, node reachability.

## P1: SDK As Source Of Truth

Whitepaper refs: §17, §22, §27.2, §27.9, §99.10.

- [ ] **SDK** Replace MCP-local transaction shaping with `mono-core-sdk` builders wherever available.
- [ ] **SDK** Add typed clients for every `lyth_*` RPC method currently hand-called by the MCP.
- [ ] **SDK** Generate TypeScript bindings from Rust structs for account, receipt, MRC assets, bridge metadata, runbooks, policies, markets, and agent-commerce primitives.
- [ ] **MCP** Fail CI if new MCP tools handcraft protocol JSON where SDK types exist.
- [ ] **MCP** Add SDK compatibility guard.
  - On startup, report SDK version, chain protocol version, runbook schema version, and incompatible surface warnings.
- [ ] **SDK** Add testnet fixture harness for MCP.
  - Deterministic wallets, fixture accounts, fixture vendors, fixture markets, mock bridge routes.
- [ ] **MCP** Add compatibility matrix in `README.md`.
  - MCP version -> SDK commit/version -> supported chain version.

## P2: Wallet, Agent Accounts, And Spending Policy

Whitepaper refs: §10, §21.2.1, §24.10, §27.6, §28.5, §30.1.

- [ ] **CORE SDK WALLET** Support real agent sub-account creation.
  - Tool: `agent_create_subaccount`.
  - Link agent address to human deployer/principal.
  - Store principal, purpose, policy, and revocation metadata.
- [x] **MCP WALLET** Support explicit agent hot-wallet setup for small spending.
  - Tools: `agent_wallet_create`, `agent_wallet_fund_request`, `agent_wallet_limits`, `agent_wallet_pause`, `agent_wallet_drain`, `agent_wallet_delete`.
  - Require user approval before creation.
  - Capture purpose, network, max balance, per-tx cap, daily/epoch cap, allowed counterparties/categories, expiry, and fallback approval mode.
  - Generate the agent wallet locally, encrypt the key, and present backup/recovery choices.
  - Mark these wallets as low-value operating wallets, not custody wallets.
- [x] **MCP WALLET** Add agent-wallet funding flow.
  - Agent can request funds: "Send up to X LYTH/USDC to this agent wallet for task Y; expires at Z."
  - Funding requires user approval from a principal wallet.
  - Agent cannot raise its own limits or refill itself without approval.
- [ ] **CORE SDK WALLET** Support on-chain spending-policy creation/modification/revocation.
  - Tools: `policy_draft`, `policy_validate`, `policy_create`, `policy_update`, `policy_revoke`, `policy_explain`.
  - Support budget caps, per-tx caps, counterparty allowlists, category limits, time windows, expiry, and emergency pause.
- [ ] **MCP** Mirror policies locally for explainability, but always treat on-chain policy as authoritative.
- [ ] **MCP** Add policy simulation before signing.
  - "Would this tx pass if submitted right now?"
  - Show exact failing policy clause.
- [ ] **WALLET** Add wallet handoff support.
  - MCP drafts request; wallet renders and signs.
  - High-value custody does not need to live inside MCP for normal production usage.
  - Explicit low-value agent wallets may sign locally only within configured limits.
- [ ] **WALLET** Add passkey-aware thresholds.
  - Below user-set cap: agent hot wallet or passkey/keychain, depending on policy.
  - Above cap: full-key or hardware wallet approval.
- [ ] **CORE SDK WALLET** Add SLH-DSA emergency-key support.
  - Tools: `emergency_key_status`, `emergency_key_register_draft`, `emergency_key_rotate_draft`.
  - Explain G3 freeze consequences to users without backup keys.
- [ ] **MCP** Add account safety profile.
  - Shows PQM-1 backup status, emergency-key status, policy status, multisig status, and recent risky operations.

## P3: Canonical Runbook Engine

Whitepaper refs: §10, §24, §27.3-§27.7.

- [ ] **SDK** Define canonical runbook JSON schema with JCS/RFC 8785 canonicalization and BLAKE3 content hash.
- [x] **MCP** Add local canonical runbook registry tools.
  - Current MCP implementation uses stable canonical JSON and `sha256:` content hashes for bundled runbook files.
  - Tools: `runbook_list`, `runbook_get`, `runbook_verify`, `runbook_diff_versions`.
  - Future SDK/protocol version should upgrade this to signed registry metadata and the final hash algorithm.
- [x] **MCP** Attach canonical runbook definitions to draft/validate/prepare flows.
  - Drafts include runbook id, version, content hash, required fields, optional fields, and missing required fields.
  - Validation fails when required canonical fields are absent.
- [ ] **MCP** Replace current ad hoc runbook drafts with canonical runbook loading/validation.
  - Runbooks live in SDK releases or bundled verified registry.
  - MCP verifies content hash before use.
- [ ] **MCP** Add runbook execution state machine.
  - `selected -> filled -> preflighted -> approved -> signed -> submitted -> monitored -> completed | disputed | expired`.
- [ ] **MCP** Add preconditions and post-conditions engine.
  - Balance checks, policy checks, provider availability, bridge route health, market status, deadline checks.
  - Post-condition verification against events/receipts.
- [ ] **MCP** Add monitoring engine per runbook.
  - Watch event set, timeout, retry policy, and final report.
- [ ] **MCP** Add runbook receipts.
  - User can ask "what did you do and why?"
  - Output includes runbook hash, parameters, approvals, signatures, txs, events, and final status.
- [ ] **SDK MCP** Implement first-wave agent-commerce runbooks:
  - `register-as-provider`
  - `update-availability`
  - `verify-credential`
  - `create-service-offer`
  - `monitor-offer`
  - `accept-offer`
  - `counter-offer`
  - `submit-deliverable`
  - `dispute-escrow`
  - `find-arbiter`
- [ ] **MCP** Keep simple convenience runbooks:
  - `request_funds`
  - `pay_contact`
  - `pay_vendor`
  - `book_service`
  - `place_spot_order`
  - `bridge_asset`
  - `swap_cross_chain`
  - `verify_receipt`

## P4: Agent-Commerce Primitive Tools

Whitepaper refs: §10, §24.1-§24.13, §29.2.

- [ ] **CORE SDK INDEXER** Attestation tools.
  - `attestation_schema_list`, `attestation_schema_get`, `attestation_verify`, `attestation_draft`, `attestation_revoke_draft`.
  - Support schema name, version, content hash, signer, subject, expiry, revocation.
- [ ] **CORE SDK** Consent registry tools.
  - `consent_grant_draft`, `consent_revoke_draft`, `consent_query`.
  - Explain revocation semantics: new uses stop immediately, in-flight escrows are grandfathered.
- [ ] **CORE SDK INDEXER** Issuer registry tools.
  - `issuer_search`, `issuer_get`, `issuer_register_draft`, `issuer_trust_explain`.
  - Flag that issuer trust is market-driven and no protocol revocation exists.
- [ ] **CORE SDK INDEXER** Discovery registry tools.
  - `provider_search`, `provider_get`, `provider_register_draft`, `provider_close_draft`.
  - Support category, free-text, embedded search, fee structure, availability, credentials, reputation filters.
- [ ] **INDEXER MCP** Reputation tools.
  - `reputation_get`, `reputation_compare`, `reputation_explain`.
  - Axes: speed, quality, communication, accuracy.
  - Link ratings back to provable event history.
- [ ] **CORE SDK** Availability tools.
  - `availability_get`, `availability_update_draft`, `availability_request`, `availability_accept`, `availability_decline`.
  - Support vacation mode, open request count, timeouts, fallback routing.
- [ ] **CORE SDK** Escrow and counter-offer tools.
  - `escrow_create_offer`, `escrow_counter_offer`, `escrow_accept`, `escrow_submit_deliverable`, `escrow_release`, `escrow_refund`, `escrow_dispute`.
  - Track state: `Open -> Negotiating(round_n) -> Accepted -> InProgress -> Submitted -> Released | Disputed`.
  - Enforce round limit and signed terms per counter-offer.
- [ ] **CORE SDK INDEXER** Arbiter registry tools.
  - `arbiter_search`, `arbiter_get`, `arbiter_register_draft`.
  - Filter single arbiter, quorum arbiter, human-required, credentials, availability, fee.
- [ ] **MCP** Add anti-illicit-commerce frontend warnings.
  - Discovery listings can be on-chain and still hidden/flagged by client policy.
  - Arbiters may refuse illicit disputes.
  - MCP should not help source illegal services.
- [ ] **MCP** Add provider/vendor onboarding wizard.
  - Builds discovery listing, availability setup, fee schedule, credentials, accepted assets, webhook/API metadata.

## P5: MRC Assets, NFTs, Markets, And Native Commerce

Whitepaper refs: §17, §18, §22.4-§22.8, §24, §99.6.

- [ ] **CORE SDK INDEXER** MRC-20 tools.
  - `mrc20_balance`, `mrc20_metadata`, `mrc20_transfer_draft`, `mrc20_allowance`, `mrc20_approve_draft`.
  - Include native vs wrapped/trust metadata.
- [ ] **CORE SDK INDEXER** MRC-721 tools.
  - `nft_list`, `nft_get`, `nft_transfer_draft`, `nft_metadata_validate`.
- [ ] **CORE SDK INDEXER** MRC-1155 tools.
  - Batch balances, batch transfer drafts, game item metadata.
- [ ] **CORE SDK** MRC-4626 vault tools.
  - `vault_get`, `vault_deposit_draft`, `vault_withdraw_draft`, `vault_risk_explain`.
- [ ] **CORE SDK WALLET** Smart account / policy account tools.
  - MRC-1271 signature validation checks.
  - MRC-4337-style account/policy simulation.
- [ ] **CORE SDK INDEXER** Spot CLOB tools.
  - Expand current read-only `markets` into `market_get`, `orderbook_get`, `order_estimate`, `order_place_draft`, `order_cancel_draft`, `trade_history`.
  - Keep perps/margin absent by design.
- [ ] **CORE SDK** AMM tools if AMMs are admitted.
  - `pool_get`, `swap_quote`, `swap_draft`, `liquidity_add_draft`, `liquidity_remove_draft`.
  - Include explicit audit/risk posture.
- [x] **MCP** Asset registry and route labels.
  - Native asset, wrapped asset, issuer-supported asset, bridge route, privacy-denomination status.
  - Wallet-readable risk labels for every asset.
- [ ] **INDEXER** Event/receipt decoding for MRC and market events.
  - MCP can explain typed events, not Solidity logs.

## P6: Bridge, IBC, Cross-Chain Swaps, And Liquidity Edge

Whitepaper refs: §17, §18, §21.6, §22.10, §26, §29.1, §30.7.

- [ ] **CORE SDK INDEXER** Bridge route registry tools.
  - `bridge_routes`, `bridge_route_get`, `bridge_asset_get`, `bridge_metadata_get`.
  - Show trust model: IBC light-client, SP1-zk, federated multisig, other.
- [x] **MCP** Route-risk explanation.
  - Display trust assumptions, external dependencies, audit history, insurance pool, drain cap, cooldown, finality threshold, upgrade authority.
- [ ] **CORE SDK** Bridge quote/preflight.
  - `bridge_quote`, `bridge_preflight`.
  - Check route health, light-client freshness, drain-cap remaining, circuit-breaker status, cooldown, fees.
- [ ] **CORE SDK** Bridge transaction builders.
  - `bridge_lock_mint_draft`, `bridge_burn_unlock_draft`.
  - Include status watcher for source-chain finality and destination release.
- [ ] **CORE SDK** Cross-chain swap tools.
  - `xswap_quote`, `xswap_intent_draft`, `xswap_claim_draft`, `xswap_status`.
  - Verify proof-bound inputs: chain id, source root, token, amount, recipient, nonce, deadline.
- [x] **MCP** Cooldown matrix and route config explanation.
  - IBC/Cosmos finality: 1 epoch target.
  - Ethereum finalized events: 1 epoch target once verified.
  - Solana: 1-2 epochs depending on finality confidence.
  - Bitcoin: 2 epochs or value-tiered limits.
  - Trusted/transitional routes: longer cooldown until zk/light-client path replaces them.
- [ ] **MCP** Bridge circuit-breaker watcher.
  - Alert if route halted, drain cap near exhaustion, light client stale, proof verifier sunset active.
- [x] **MCP** USDC/native issuer support tracker.
  - Current support status, issuer route, wrapped route, route risk, liquidity venue.
- [x] **MCP** Liquidity onboarding assistant.
  - "How do I bring ETH/BTC/USDC into Mono?"
  - Answer with available routes, risks, fees, cooldowns, and recommended path.

## P7: Privacy Bifurcation Guardrails

Whitepaper refs: §13, §25, §99 Legal Disclaimer.

- [ ] **CORE SDK INDEXER** Public/private balance display.
  - Show public LYTH and private LYTH as non-fungible denominations.
  - Never combine them into one spendable balance.
- [ ] **CORE SDK** Privacy transfer helpers.
  - `private_transfer_draft`, `private_burn_draft`, `cross_to_private_draft`.
  - No `cross_to_public` path exists.
- [x] **MCP** Privacy-denomination policy guard.
  - Refuse to use private LYTH for contracts, spot CLOB, bridge, staking, discovery, issuer registration, escrow, or service payments.
  - Return `PrivacyDenominationViolation` explanation.
- [x] **MCP** Compliance warnings for private denomination.
  - Explain one-way crossing, exchange rejection risk, KYC/front-end policy risk, and no productive chain use.
- [ ] **WALLET MCP** Proof-of-crossing helper if supported by application layer.
  - Draft/export optional proof for exchanges/frontends.
  - Label as application-layer, not protocol-mandated.
- [ ] **INDEXER** Privacy cordon event decoding.
  - `privacy_events`, `crossing_events`, `privacy_warning_summary`.

## P8: Rust/RISC-V Contract And Developer Tooling

Whitepaper refs: §17, §22, §27.2, §99.8.

- [ ] **SDK** Contract package tools.
  - `contract_build_mrv`, `contract_validate_mrv`, `contract_hash`, `contract_manifest`.
  - Expose ABI, syscall imports, memory limits, storage namespace, build metadata.
- [ ] **CORE SDK** Contract deploy/call tools.
  - `contract_deploy_draft`, `contract_call_draft`, `contract_query`, `contract_events`.
- [ ] **MCP** Contract safety explanation.
  - Interpret deterministic-artifact validation errors.
  - Explain syscall ABI usage, cycle/state-I/O estimates, memory limits.
- [ ] **CORE SDK** Gas/cycle/state estimator.
  - Estimate RISC-V cycles, syscall cost, state I/O, event cost, receipt cost.
- [ ] **MCP** Developer runbooks.
  - "Deploy this Rust contract."
  - "Call this contract."
  - "Why did this contract revert?"
  - "Show storage/events/receipt."
- [ ] **SDK MCP** MRC conformance runner.
  - Validate MRC-20/MRC-721/MRC-1155/MRC-4626 implementation behavior.
- [x] **MCP** No-EVM clarity.
  - Explicitly say Solidity/EVM bytecode is not supported when users ask to deploy Solidity.
  - Link to Rust/RISC-V path and any future compatibility layer status.

## P9: Cluster, Staking, Operator, And Service-Tier Tools

Whitepaper refs: §14, §20, §23, §28, §30.5.

- [ ] **CORE SDK INDEXER** Cluster registry tools.
  - `cluster_list`, `cluster_get`, `cluster_reputation`, `cluster_foundation_flag`, `cluster_sunset_status`.
  - Show roster, uptime, slashing history, service tiers, geography, ASN diversity, hardware class.
- [ ] **CORE SDK INDEXER** Operator registry tools.
  - `operator_get`, `operator_open_seats`, `operator_apply_draft`, `operator_reputation`, `operator_attestation_status`.
- [ ] **CORE SDK INDEXER** Node registry / TPM attestation tools.
  - `node_attestation_get`, `node_pcr_explain`, `node_diversity_score`, `node_hosting_class`.
- [ ] **CORE SDK** Delegation tools.
  - `stake_status`, `delegate_draft`, `rebalance_draft`, `undelegate_draft`, `autovote_simulate`.
  - Modes: Max Yield, Max Diversity, Max Decentralization, Custom.
- [ ] **MCP** Delegation cap explanation.
  - Explain current phase, per-cluster cap, minimum diversification, over-cap grace period, tapered rewards.
- [ ] **CORE SDK INDEXER** Service-tier market tools.
  - `rpc_service_search`, `archive_service_search`, `prover_service_search`, `oracle_service_search`.
  - Show price, uptime, capacity, GPU class, proof latency, reputation.
- [ ] **MCP** GPU proof market assistant.
  - Route zkML/bridge proof requests to available prover services.
  - Show expected proof time, fee, and verifier status.
- [ ] **MCP** Monarch operator assistant.
  - Explain cluster health, 7-of-10 quorum, update status, open seats, resource pressure, service ROI.
  - Keep node-ops separate from consumer wallet UX.

## P10: Security, Emergency, And Threat-Model Tools

Whitepaper refs: §21, §29, §30, §99.8.

- [ ] **MCP** Threat posture summary.
  - `security_status` reports mempool mode, Ferveo threshold status, zk verifier backend, IBC hardening status, oracle status, RISC-V VM gate status.
- [ ] **MCP** Emergency-state watcher.
  - Detect and explain G3 declarations, algorithm freezes, bridge freezes, circuit breakers, checkpoint anomalies.
- [ ] **CORE SDK INDEXER** PQ checkpoint tools.
  - `checkpoint_latest`, `checkpoint_verify`, `checkpoint_explain`.
  - Distinguish fast block finality from PQ-attested deep settlement.
- [ ] **MCP** Bridge and cross-chain settlement blast-radius monitor.
  - Freeze new bridge operations when emergency state says routes are paused.
  - Surface in-flight settlement risk.
- [ ] **WALLET MCP** Recovery runbook tools.
  - `recovery_status`, `recovery_rotate_draft`, `recovery_claim_start`.
  - Explain frozen-account path for users without backup keys.
- [ ] **MCP** Audit/research gate dashboard.
  - Track zkML verifier, Rust/RISC-V VM, MRC standards, EVM retirement, FRI/STARK verifier, Ferveo, oracle, IBC, DAG sync.
  - Pull from chain milestone/config where possible, otherwise from a signed metadata source.

## P11: Natural-Language Search And Explanation

Whitepaper refs: §27.8, §28.5, §99.3.

- [ ] **SDK INDEXER** Typed NL query surface for chain state.
  - Queries compile to typed SDK calls, not arbitrary RPC JSON.
- [ ] **MCP** "Ask the blockchain" tool.
  - `ask_chain` routes NL to typed tools and returns cited data sources.
- [ ] **MCP** Agent-commerce search examples.
  - "Find a crypto lawyer with 4+ quality, available this week, under 5k."
  - "Find a plumber near me under 150 LYTH."
  - "Find an arbiter for a high-value escrow."
- [ ] **MCP** Cluster/operator search examples.
  - "Show EU clusters with GPU prover service."
  - "Which clusters are Foundation-controlled?"
  - "Which clusters maximize decentralization for my stake?"
- [ ] **MCP** Transaction explanation.
  - "Why did this transaction revert?"
  - Decode typed errors, policy failures, bridge failures, privacy cordon violations, and contract reverts.
- [ ] **MCP** Plain-English risk renderer.
  - Every money-moving flow outputs risks, assumptions, policy basis, and retry/receipt path.

## P12: Vendor, Commerce, And Real-World Integration Layer

Whitepaper refs: §10, §18, §24, §27.7.

- [x] **MCP** Replace demo vendor registry with pluggable signed vendor registries.
  - Local JSON remains for demos.
  - Signed registry format includes issuer, signature, expiry, category taxonomy, fulfillment schema, API capability metadata.
- [ ] **CORE SDK INDEXER** Bind vendor registry to on-chain discovery registry when available.
- [x] **MCP** Vendor fulfillment adapters.
  - Dry-run adapter is implemented via `order_fulfill_dry_run`.
  - Manual confirmation adapter is implemented via `order_fulfill_manual`.
  - Webhook adapter is implemented via `connector_set`, `connector_test_webhook`, `order_fulfill_webhook`, and `booking_send_webhook`.
  - API-key/HMAC adapter with encrypted local secret store is implemented via `LYTH_MCP_CONNECTOR_STORE` and `LYTH_MCP_CONNECTOR_KEY`.
- [x] **MCP** Order lifecycle.
  - `order_quote`, `order_create`, `order_pay`, `order_status`, `order_receipt`, `order_cancel`.
  - For now, demo only; production requires real vendor terms and fulfillment hooks.
- [x] **MCP** Invoices and funding requests.
  - `invoice_create`, `invoice_status`, `funding_request_create`.
  - Let agent say: "Send 50 USDC/LYTH here for this task; expires at X."
- [x] **MCP** Service booking.
  - `booking_request_create`, `booking_accept_demo`, `booking_prepare_escrow`, `booking_mark_paid`, `booking_complete_dry_run`, `booking_dispute_demo`, `booking_cancel`.
  - Local workflow only; production requires real provider connectors and live escrow integration.
- [ ] **MCP** External commerce connectors.
  - Generic webhook/API-key connector is implemented; product-specific integrations remain TODO.
  - Stripe/agent-commerce protocol style connectors if appropriate.
  - Coinsbee-style gift-card connector only with official API credentials and clear legal/compliance posture.
  - Travel/food/service connectors through vendor-approved integrations.
- [x] **MCP** Merchant risk controls.
  - `merchant_policy_set/get/list/remove`, `merchant_risk_check`.
  - Enforced by `order_create`, `order_pay`, and `booking_request_create`.
  - Per-vendor caps, allowlist, denylist, jurisdiction notes, refund policy, fulfillment SLA, dispute process.

## P13: Mainnet Readiness Gates For MCP

Whitepaper refs: §18, §22, §24.2, §26, §27, §29.5, §99.8.

- [ ] **MCP** No-EVM readiness.
  - RISC-V VM and MRC SDK surfaces available.
  - `contract_path_guidance` gives explicit no-EVM/Solidity guidance now.
  - MCP still depends on transitional LYTH transfer compatibility until native wallet/contract builders are exposed.
- [ ] **MCP** MRC readiness.
  - Token/NFT/vault/market helpers work through native modules.
- [ ] **MCP** Agent-commerce readiness.
  - Spending-policy, discovery, availability, escrow, arbiter, reputation, attestation, issuer, consent tools live.
- [ ] **MCP** Bridge readiness.
  - Route metadata, cooldowns, drain caps, circuit breakers, and local bridge quotes are implemented via `bridge_routes`, `bridge_route_get`, `bridge_quote`, `bridge_cooldown_matrix`, `bridge_status_summary`, and `liquidity_onboarding`.
  - Live status watchers and transaction builders still require core/indexer bridge surfaces.
- [ ] **MCP** Wallet handoff readiness.
  - Production path supports wallet handoff for high-value funds.
  - MCP-local agent hot-wallet mode is explicit opt-in, capped, revocable, and receipt-covered.
  - MCP-local low-value wallet remains suitable for agent operating budgets, demos, testnet, and developer workflows.
- [ ] **MCP** Runbook readiness.
  - Canonical signed/hash-verified runbooks with monitoring and receipts.
- [ ] **MCP** Security readiness.
  - Self-check, health scoring, outbox, receipts, and privacy guardrails are implemented.
  - Recovery, emergency state, and full policy simulation remain.
- [ ] **MCP** Documentation readiness.
  - User README, operator README, developer README, connector guide, security model, production deployment guide.
- [ ] **MCP** Test readiness.
  - Dist-based smoke test is implemented via `npm test` / `scripts/smoke.mjs` for stores, connectors, policies, bookings, orders, invoices, bridge routes, and runbooks.
  - Unit tests for stores, policies, addressbook, outbox, receipts.
  - Integration tests against mock RPC.
  - Live testnet smoke tests gated by env.
  - Golden runbook fixtures.

## Suggested Build Order

1. **Make payments reliable.** Outbox, preflight, receipts, node health, status watcher.
2. **Make policy real.** Policy simulation, local reservation ledger, then on-chain spending-policy once core exposes it.
3. **Make runbooks canonical.** Schema, JCS hash, registry, execution state machine, monitoring.
4. **Make discovery real.** Replace demo vendors with discovery registry reads and signed vendor metadata.
5. **Make escrow real.** Offer/counter-offer/deliverable/dispute runbooks.
6. **Make assets real.** MRC-20 first, then MRC-721/1155, then MRC-4626.
7. **Make liquidity real.** Bridge route metadata, quotes, risk display, status watcher.
8. **Make contract tooling real.** MRV validation, deploy/call/read/events.
9. **Make operator tooling useful.** Cluster registry, service tiers, staking/autovote.
10. **Make emergency/security legible.** G3, checkpoint, bridge freeze, recovery, research-gate status.

## Non-Goals

- Do not add Solidity/EVM deployment as a first-class MCP path.
- Do not support perpetuals or margin runbooks.
- Do not add on-chain governance/voting/tally tools.
- Do not let private-denominated LYTH interact with commerce, bridges, staking, markets, or contracts.
- Do not hide bridge/wrapped-asset trust assumptions.
- Do not make MCP-local hot wallets an implicit, unrestricted, or high-value production signing architecture.

## Open Design Questions

- What is the final canonical runbook schema version and registry location?
- Should the MCP be bundled into every wallet or shipped as a separate optional agent connector first?
- What is the production secret-store story for vendor API keys and low-value agent keys?
- How should local reserved-spend expiry work without creating a false sense that an already-signed payload is impossible to submit?
- Should route-risk scoring be deterministic protocol metadata only, or can MCP add client-side scoring?
- What signed metadata source should MCP use before every v4.1 native module is queryable on-chain?
- What is the policy for MCP refusing requests that are legal gray areas but not protocol-invalid?
