# Lyth MCP

Monolythium MCP server for live-chain reads and AI runbooks.

`lyth-mcp` lets an AI assistant safely interact with the current live Monolythium testnet surface. It can read chain state, inspect accounts, look up transactions, list markets, discover local vendors, draft agent-commerce runbooks, validate spending policies, create a local encrypted agent wallet, and build native LYTH transfer transactions.

It does **not** silently spend funds. By default it drafts wallet approval payloads and stores no plaintext secrets. If the user creates an MCP wallet, the mnemonic is encrypted locally. Signing requires a passphrase unless the wallet is a local-machine protected agent wallet with capped low-value mode enabled.

The first useful product shape is:

> Mono provides the rails, wallet handoff, discovery, runbooks, settlement, and verification. Users and vendors build the services agents can call.

## Status

This is an MVP MCP server for the live Monolythium testnet.

Default network:

| Field | Value |
|---|---|
| Network | `testnet-69420` |
| Chain ID | `69420` |
| RPC source | Monolythium chain-registry official testnet endpoints |
| Transaction signing | Supported for local MCP wallets by passphrase or opt-in low-value mode |
| Transaction broadcast | Disabled by default |
| Wallet storage | Optional encrypted local store at `~/.lyth_mcp/wallets.json` |
| Low-value no-passphrase mode | Optional per-wallet cap and daily cap for test/agent wallets; default for passphrase-less funding wallets |
| Native payment preparation | `pay_vendor` with native `LYTH` |
| Token payment preparation | Draft-only until MRC/token routes are wired |
| Escrow/trade/policy writes | Draft-only until the live write builders are wired |

## Why This Exists

An AI assistant should eventually be able to say:

> "Send me 50 USDC to complete this task. Here is my agent wallet address."

That does not mean the assistant gets unlimited spending power. It means the user can give the assistant a wallet, a budget, and a policy. The assistant can request funds, receive approval, spend within limits, open escrow, pay a vendor, or verify a receipt.

This MCP is the first tool layer for that workflow.

## Safety Model

The server is intentionally wallet-cautious:

- no plaintext private keys or mnemonics;
- local wallets are encrypted with AES-256-GCM and a scrypt-derived passphrase key;
- passphrase signing is the default for passphrase-protected wallets;
- local-machine protected wallets are allowed for capped agent/testnet funding flows;
- low-value mode is opt-in and should only be used for capped agent wallets;
- no hidden approvals;
- no default broadcasting;
- every economic runbook requires human approval or a previously configured low-value policy;
- wallet payloads are prepared for review, not executed automatically;
- signed transaction submission requires `LYTH_MCP_ENABLE_SUBMIT=1`.

The intended production architecture is:

```text
AI assistant
  -> lyth-mcp
    -> draft/validate runbook
      -> prepare wallet request or build transfer
        -> user approves policy / cap
          -> wallet signs by passphrase or capped low-value mode
            -> signed encrypted envelope is optionally submitted
```

The MCP is allowed to help. The user controls funding, policy, passphrases, and broadcast permission.

## Install

Install the reviewed `v0.1.0` release artifact from GitHub:

```bash
npm install --global https://github.com/monolythium/lyth_mcp/releases/download/v0.1.0/lyth-mcp-0.1.0.tgz
```

For source development, clone the exact tag instead of installing a mutable
default branch:

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/monolythium/lyth_mcp.git
```

From this repository:

```bash
cd repos/monolythium/lyth_mcp
npm install
npm run build
```

`@monolythium/core-sdk` is exact-pinned to the reviewed public `0.6.8` npm
release. The release tarball, SBOM, checksum file, and keyless signature bundles
are attached to the matching GitHub tag.

Run the server over stdio:

```bash
npm start
```

For development:

```bash
npm run dev
```

## Isolated Stele Profile

Stele uses a separate MCP entry point. It does not register or import the legacy wallet, signing, submission, connector, or local-vendor tools:

```bash
npm run start:stele
```

After a global release install, the equivalent command is:

```bash
lyth-stele-mcp
```

The profile exposes exactly three read-only tools:

| Tool | Purpose |
|---|---|
| `stele_connection_status` | Re-read and compare the SDK pin, a genesis-verified trusted operator, and Stele metadata |
| `stele_search_services` | Search public Stele listings after a fresh identity check |
| `stele_agent_wallet_status` | Report the unavailable dedicated-agent keystore boundary without opening a key |

Economic execution is intentionally unavailable in this foundation slice. The Stele entry point cannot import, reveal, unlock, sign, or submit, and it never inspects desktop, browser, or legacy MCP wallet stores.

Production reads are pinned to `https://stele.monolythium.com`. Local LAN testing is opt-in. Supply the same operator-controlled origin for both variables, replacing the documentation placeholder with a canonical dotted RFC1918 IPv4 address served over HTTP on effective port 80:

```bash
export STELE_PRIVATE_LAN_ORIGIN='http://<canonical-rfc1918-ipv4>'
LYTH_MCP_STELE_API_ORIGIN="$STELE_PRIVATE_LAN_ORIGIN" \
LYTH_MCP_STELE_PUBLIC_ORIGIN="$STELE_PRIVATE_LAN_ORIGIN" \
LYTH_MCP_STELE_ALLOW_INSECURE_LAN=1 \
npm run start:stele
```

DNS names, IPv6, alternate numeric IP encodings, public and special-use addresses, non-default ports, origin mismatches, and credential/path/query/fragment additions are rejected. Redirects, non-JSON responses, oversized bodies, malformed schemas, missing genesis identity, and any chain/genesis disagreement fail closed. Do not enable insecure LAN mode outside the local development network, and keep the concrete origin in untracked local environment configuration.

### Codex

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app share the same
local MCP configuration. After installing the release artifact, add the isolated
profile and verify it:

```bash
codex mcp add stele -- lyth-stele-mcp
codex mcp list
```

For a hand-edited configuration, copy `examples/codex_stele_config.toml` into
your user `~/.codex/config.toml` or a trusted project's `.codex/config.toml`,
then restart the client. The example allowlists the same exact three tools.

### Claude Desktop

Copy the `stele` entry from `examples/claude_desktop_stele_config.json` into
Claude Desktop's MCP configuration, then restart Claude Desktop. The command is
the globally installed `lyth-stele-mcp` executable and carries no wallet-store,
passphrase, signing, or submission environment variables.

## Claude Desktop Example

After building, add an MCP server entry like this:

```json
{
  "mcpServers": {
    "lyth-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/monolythium/lyth_mcp/dist/index.js"],
      "env": {
        "LYTH_NETWORK": "testnet-69420",
        "LYTH_CHAIN_ID": "69420",
        "LYTH_MCP_ENABLE_SUBMIT": "0",
        "LYTH_MCP_WALLET_STORE": "/absolute/path/to/.lyth_mcp/wallets.json",
        "LYTH_MCP_HOT_KEY": "/absolute/path/to/.lyth_mcp/hot.key",
        "LYTH_MCP_LOCAL_KEY": "/absolute/path/to/.lyth_mcp/local.key",
        "LYTH_MCP_ADDRESSBOOK": "/absolute/path/to/.lyth_mcp/addressbook.json",
        "LYTH_MCP_VENDOR_REGISTRY": "/absolute/path/to/monolythium/lyth_mcp/vendors.example.json"
      }
    }
  }
}
```

There is also a template at:

```text
examples/claude_desktop_config.json
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `LYTH_NETWORK` | `testnet-69420` | Human-readable network label |
| `LYTH_CHAIN_ID` | `69420` | Expected chain ID |
| `LYTH_RPC_URL` | unset | Single RPC override |
| `LYTH_RPC_URLS` | official testnet RPCs | Comma-separated RPC endpoint override |
| `LYTH_MCP_TIMEOUT_MS` | `10000` | Per-request timeout |
| `LYTH_MCP_MAX_OUTPUT` | `16000` | MCP response truncation limit |
| `LYTH_MCP_VENDOR_REGISTRY` | bundled `vendors.example.json` | Optional path override for local vendor registry JSON |
| `LYTH_MCP_ASSET_REGISTRY` | bundled `asset_registry.example.json` | Optional path override for local asset/risk metadata |
| `LYTH_MCP_BRIDGE_ROUTE_REGISTRY` | bundled `bridge_routes.example.json` | Optional path override for local bridge/liquidity route metadata |
| `LYTH_MCP_CLUSTER_REGISTRY` | bundled `clusters.example.json` | Optional path override for local cluster/operator/service-tier metadata |
| `LYTH_MCP_NODE_REGISTRY` | bundled `nodes.example.json` | Optional path override for local node/TPM/PCR metadata |
| `LYTH_MCP_ENABLE_SUBMIT` | `0` | Set to `1` to allow broadcasting already-signed payloads |
| `LYTH_MCP_WALLET_STORE` | `~/.lyth_mcp/wallets.json` | Local encrypted wallet store path |
| `LYTH_MCP_HOT_KEY` | `~/.lyth_mcp/hot.key` | Local key file used only for opt-in low-value mode |
| `LYTH_MCP_LOCAL_KEY` | `~/.lyth_mcp/local.key` | Local machine key used for passphrase-less agent wallets |
| `LYTH_MCP_ADDRESSBOOK` | `~/.lyth_mcp/addressbook.json` | Local contact/addressbook store path |
| `LYTH_MCP_OUTBOX` | `~/.lyth_mcp/outbox.json` | Local signed-payload outbox for retrying without rebuilding/re-signing |
| `LYTH_MCP_RECEIPTS` | `~/.lyth_mcp/receipts.json` | Local receipt store for drafted/signed/submitted/failed operations |
| `LYTH_MCP_CONNECTOR_STORE` | `~/.lyth_mcp/connectors.json` | Local webhook connector store |
| `LYTH_MCP_CONNECTOR_KEY` | `~/.lyth_mcp/connector.key` | Local key used to encrypt connector API keys/webhook secrets |
| `LYTH_MCP_ORDER_STORE` | `~/.lyth_mcp/orders.json` | Local demo order lifecycle store |
| `LYTH_MCP_BOOKING_STORE` | `~/.lyth_mcp/bookings.json` | Local service-booking lifecycle store |
| `LYTH_MCP_INVOICE_STORE` | `~/.lyth_mcp/invoices.json` | Local invoice and funding-request store |
| `LYTH_MCP_MERCHANT_POLICY_STORE` | `~/.lyth_mcp/merchant_policies.json` | Local per-vendor allow/deny/cap/risk policy store |
| `LYTH_MCP_RUNBOOK_REGISTRY` | bundled `runbooks/` | Local canonical runbook registry path |
| `LYTH_MCP_WALLET_PASSPHRASE` | unset | Optional env passphrase for unattended passphrase signing; safer to pass per call |
| `LYTH_MCP_DEFAULT_LOW_VALUE_MAX` | `10` | Default LYTH per-transaction cap for passphrase-less wallets |
| `LYTH_MCP_DEFAULT_LOW_VALUE_DAILY_LIMIT` | `50` | Default LYTH daily cap for passphrase-less wallets |
| `LYTH_MCP_OUTBOX_EXPIRY_HOURS` | `24` | Local signed-payload reservation expiry window |

Use `LYTH_RPC_URLS` when you want the MCP to probe your own RPC fleet:

```bash
LYTH_RPC_URLS="http://node1:8545,http://node2:8545" npm start
```

## Tools

### Live Chain Tools

| Tool | Purpose |
|---|---|
| `chain_status` | Probe RPC endpoints and return chain, round, mempool, indexer, and sync status |
| `rpc_health` | Score configured RPC endpoints for read/write readiness |
| `mcp_self_check` | Check install/config/store/RPC health |
| `security_status` | Show MCP-local threat posture across RPC, bridge, wallet, outbox, and TODO(mainnet) security gates |
| `emergency_state_watch` | Watch emergency signals such as no write-ready RPC, paused bridge routes, stale signed payloads, and failure spikes |
| `bridge_blast_radius` | Summarize affected bridge routes, local bridge/swap receipts, signed bridge payloads, and freeze recommendations |
| `recovery_status` | Show recovery posture and available recovery runbooks for local agent wallets |
| `recovery_runbook_draft` | Draft pause, drain, delete, stale-outbox release, or future emergency-key recovery steps |
| `audit_gate_dashboard` | Track local audit/research gates for zkML, RISC-V VM, MRC, FRI/STARK, oracle, and DAG sync |
| `readiness_check` | Show mainnet-readiness gates for no-EVM, MRC, commerce, bridge, wallet, runbooks, security, docs, and tests |
| `account_overview` | Get balance, nonce, label, profile, and flow for an address |
| `recent_transactions` | Read recent transactions from `lyth_txFeed` |
| `tx_lookup` | Look up status, receipt, transaction, and decoded view by tx hash |
| `tx_error_explain` | Explain failed sends, RPC errors, policy failures, bridge refusals, and reverts |
| `ask_chain` | Route natural-language chain questions to typed MCP paths with cited sources |
| `tx_status_summary` | Summarize status by tx hash or outbox id |
| `tx_watch` | Poll a tx hash or outbox id until confirmed, failed, or attempts are exhausted |
| `search_chain` | Search addresses, hashes, blocks, clusters, and labels |
| `markets` | List live CLOB markets or inspect one market with optional book/trades |
| `api_get` | Low-level read-only helper for `/api/v1` |
| `mcp_dashboard` | Render a compact Markdown dashboard for Claude Code/text clients |

### AI Runbook Tools

| Tool | Purpose |
|---|---|
| `list_runbooks` | Show supported runbooks and live-readiness status |
| `runbook_list` | List canonical runbook files with stable content hashes |
| `runbook_get` | Load one canonical runbook by name or id |
| `runbook_verify` | Verify a runbook content hash |
| `runbook_diff_versions` | Diff two runbook versions |
| `draft_runbook` | Create a typed runbook intent |
| `validate_runbook` | Check a runbook against spending policy and safety rules |
| `prepare_wallet_request` | Prepare a wallet approval payload where supported |
| `vendor_search` | Search a local vendor registry JSON |
| `commerce_safety_check` | Check vendor/service/search text against local commerce safety policy |
| `risk_explain` | Render a plain-English risk summary from MCP policy/preflight inputs |
| `asset_registry_info` | Show local asset registry metadata and content hash |
| `asset_search` | Search asset metadata and risk labels |
| `asset_get` | Get one asset, risk labels, warnings, and bridge routes |
| `asset_risk_label` | Render wallet-readable labels for an asset/use case |
| `asset_route_labels` | Join local asset labels with bridge route labels |
| `privacy_policy_check` | Refuse blocked private-denomination use cases |
| `private_denomination_warning` | Explain public/private LYTH separation and compliance warnings |
| `contract_path_guidance` | Explain no-EVM/Solidity guidance and Rust/RISC-V path |
| `bridge_routes` | List bridge/liquidity routes with status, cooldown, and trust metadata |
| `bridge_route_get` | Get one bridge route's risk/cooldown/circuit-breaker metadata |
| `bridge_quote` | Preflight a bridge amount against route status, fees, caps, cooldown, and risk |
| `bridge_cooldown_matrix` | Show configured cooldowns by route |
| `bridge_status_summary` | Summarize route health, drain caps, and attention flags |
| `bridge_circuit_breaker_watch` | Alert on paused/non-active routes, trusted-route risk, missing audits, and low drain caps |
| `liquidity_onboarding` | Explain how to bring an asset into Mono through configured routes |
| `cluster_registry_info` | Show local cluster/operator registry metadata and hashes |
| `cluster_search` | Search clusters by region, service, status, foundation control, GPU, and open seats |
| `cluster_get` | Get one cluster with reputation, foundation, sunset, service, and operator detail |
| `cluster_reputation` | Explain cluster reputation, uptime, slashing, services, and decentralization risk |
| `cluster_foundation_flag` | Explain foundation-control implications for delegation |
| `cluster_sunset_status` | Explain whether a cluster is active, sunsetting, or retired |
| `operator_search` | Search local operators by region, cluster, foundation control, and open-seat interest |
| `operator_get` | Get one operator's clusters, reputation, open seats, and attestation status |
| `operator_open_seats` | List clusters/operators with open operator seats |
| `monarch_operator_assistant` | Explain cluster health, quorum, resource pressure, open seats, and service ROI |
| `delegation_cap_explain` | Explain phase caps, diversification, over-cap grace, and tapered rewards |
| `stake_status` | Summarize local staking positions against caps and cluster risk |
| `delegate_draft` | Draft a local delegation plan for one cluster |
| `rebalance_draft` | Draft a local rebalance plan across clusters |
| `undelegate_draft` | Draft a local undelegation plan for one cluster |
| `autovote_simulate` | Simulate cluster ranking for staking autovote modes |
| `node_registry_info` | Show local node registry metadata and hashes |
| `node_search` | Search nodes by cluster, operator, role, status, hosting, attestation, GPU, and TPM |
| `node_attestation_get` | Get local TPM/attestation metadata and PCR comparison for one node |
| `node_pcr_explain` | Explain one node's PCR values and measured-boot meaning |
| `node_diversity_score` | Score node diversity by ASN, provider, country, hosting class, operator, and cluster |
| `node_hosting_class` | Explain one node's hosting class and correlated-failure risk |
| `rpc_service_search` | Search local RPC service tiers |
| `archive_service_search` | Search local archive service tiers |
| `prover_service_search` | Search local GPU prover service tiers |
| `gpu_proof_market_assistant` | Route bridge/zkML/generic proof requests to local GPU prover service tiers |
| `oracle_service_search` | Search local oracle service tiers |
| `charter_read` | Read a cluster's live active + pending economics charter (Law §6.8): member shares, delegator share, effective epoch |
| `update_charter_draft` | Build + validate an offline `updateCharter` draft (Σ member = 10000 bps, delegator ≥ 2000 bps floor) and return the consent digest to sign |
| `service_score_per_cluster` | Read the live per-cluster ServiceScore (Component A, Law §7) plus the base/diversity/service term reads — the "rewards = proved service" view |
| `vendor_registry_info` | Show registry hashes, issuer, expiry, signature status, and categories |
| `vendor_get` | Get one vendor by id |
| `provider_onboarding_draft` | Draft vendor registry, merchant policy, availability, and connector metadata |
| `demo_connector_templates` | List TODO/demo connector templates for Stripe, Coinsbee, travel, food, service providers, ACP, and UCP |
| `demo_connector_get` | Inspect one TODO/demo connector template |
| `demo_connector_draft` | Create a disabled `connector_set` draft from a TODO/demo connector template |
| `connector_set` | Create or update an encrypted local webhook connector |
| `connector_get` | Get one connector without revealing its secret |
| `connector_list` | List local connectors without revealing secrets |
| `connector_remove` | Remove one connector and its encrypted secret |
| `connector_test_webhook` | Preview or send a test webhook payload |
| `merchant_policy_set` | Create or update local merchant risk controls |
| `merchant_policy_get` | Get one vendor's local merchant policy and risk view |
| `merchant_policy_list` | List local merchant policies |
| `merchant_policy_remove` | Remove one local merchant policy |
| `merchant_risk_check` | Evaluate a vendor/amount/asset before creating an order |
| `order_quote` | Quote a demo vendor catalog item |
| `order_create` | Create a local demo order |
| `order_pay` | Prepare a pay_vendor runbook and optional wallet request for an order |
| `order_mark_paid` | Mark a local order paid after supplying a tx hash |
| `order_status` | Get one local order |
| `order_list` | List local orders |
| `order_receipt` | Export a local order receipt |
| `order_cancel` | Cancel a local order before dry-run fulfillment |
| `order_fulfill_dry_run` | Mark a local demo order fulfilled without contacting a real vendor |
| `order_fulfill_manual` | Mark a local order fulfilled from manual vendor evidence |
| `order_fulfill_webhook` | Send an order to a configured vendor webhook connector |
| `booking_request_create` | Create a local service-booking request and `book_service` runbook draft |
| `booking_accept_demo` | Mark a booking accepted by a demo provider |
| `booking_send_webhook` | Send a booking request to a configured vendor webhook connector |
| `booking_prepare_escrow` | Prepare an `open_escrow` runbook draft for a booking |
| `booking_mark_paid` | Mark a booking paid with an observed tx hash |
| `booking_complete_dry_run` | Mark a booking completed by dry-run fulfillment |
| `booking_dispute_demo` | Open a local demo dispute for a booking |
| `booking_status` | Get one local booking |
| `booking_list` | List local bookings |
| `booking_cancel` | Cancel a local booking before completion |
| `invoice_create` | Create a local invoice requesting payment |
| `funding_request_create` | Create a local agent funding request |
| `invoice_status` | Get a local invoice/funding request |
| `invoice_list` | List invoices and funding requests |
| `invoice_mark_paid` | Mark an invoice/funding request paid with a tx hash |
| `invoice_cancel` | Cancel an open invoice/funding request |
| `submit_signed_transaction` | Broadcast an already-signed payload, disabled unless explicitly enabled; can update an outbox id |
| `tx_outbox_list` | List local signed payloads that can be retried |
| `tx_outbox_get` | Inspect one local signed payload |
| `tx_outbox_retry` | Retry a signed payload without rebuilding/re-signing |
| `tx_outbox_forget` | Remove a local outbox entry without invalidating the signed payload |
| `tx_outbox_release` | Release a local low-value allowance reservation for one signed/not-submitted payload |
| `tx_outbox_expire_stale` | List or release locally expired low-value outbox reservations |
| `receipt_list` | List local MCP operation receipts |
| `receipt_get` | Inspect one local MCP receipt |
| `receipt_export` | Export one receipt as JSON |

### Local Wallet Tools

| Tool | Purpose |
|---|---|
| `wallet_funding_address` | Create or return a local testnet agent wallet funding address |
| `wallet_setup` | Create a local encrypted ML-DSA-65 agent wallet |
| `wallet_import` | Import an existing 24-word recovery phrase into the encrypted store |
| `wallet_list` | List local wallets and low-value policy status |
| `wallet_low_value_accounting` | Show reserved/submitted/confirmed/failed/expired low-value buckets |
| `wallet_preflight_transfer` | Check chain id, balance, nonce, RPC health, encryption key, and policy before signing |
| `wallet_approval_summary` | Render the human-readable approval text for a planned transfer |
| `wallet_safety_profile` | Explain key protection, hot-wallet caps, pending signed payloads, recovery path, and missing production signals |
| `hot_wallet_policy_simulate` | Simulate whether a proposed small spend passes the local agent hot-wallet policy |
| `wallet_threshold_explain` | Explain hot-wallet, passkey/wallet-handoff, and full-key/hardware approval thresholds |
| `agent_wallet_create` | Create an explicit low-value agent operating wallet with purpose and caps |
| `agent_wallet_fund_request` | Draft a funding request for an agent wallet |
| `agent_wallet_limits` | Update an agent wallet's local caps and metadata |
| `agent_wallet_pause` | Disable low-value signing and mark the agent wallet paused |
| `agent_wallet_drain` | Prepare/sign a drain transfer back to a principal or recovery address |
| `agent_wallet_delete` | Delete a local agent wallet record after explicit confirmation |
| `wallet_configure_low_value` | Enable or disable capped no-passphrase signing |
| `wallet_export_mnemonic` | Reveal a mnemonic after passphrase confirmation |
| `wallet_delete` | Delete a local wallet from the store |
| `wallet_build_transfer` | Build a native LYTH transfer and optionally sign an encrypted envelope |
| `addressbook_add` | Add or update a named local contact |
| `addressbook_lookup` | List or search local contacts |
| `addressbook_remove` | Remove a named local contact |

## Supported Runbooks

| Runbook | Status | Meaning |
|---|---|---|
| `request_funds` | Draft-only | Ask a principal to fund an agent wallet |
| `pay_vendor` | Live-preparable | Prepare native LYTH payment for wallet approval |
| `book_service` | Draft-only | Book an external service under policy |
| `open_escrow` | Draft-only | Draft escrow terms for future live escrow support |
| `place_trade` | Draft-only | Draft a spot-market order intent |
| `set_spending_policy` | Draft-only | Draft an agent spending policy update |
| `revoke_agent_permission` | Draft-only | Draft a permission revocation |
| `verify_receipt` | Live-read | Verify receipt/status of a live transaction |
| `rate_vendor` | Draft-only | Draft a reputation update |

Runbook JSON examples live in:

```text
runbooks/
```

The MCP exposes those files through a local canonical registry. `runbook_list` returns stable `sha256:` content hashes, and `runbook_verify` can compare a runbook against an expected hash. This is a release-local integrity layer; the future target is signed SDK/protocol registry metadata.

`draft_runbook`, `validate_runbook`, and `prepare_wallet_request` attach canonical metadata when a bundled runbook exists. Drafts include the runbook id, version, content hash, required fields, optional fields, and missing required fields. Validation fails if a canonical required field is absent.

## Asset Registry And Privacy Guardrails

By default, the MCP loads `asset_registry.example.json`. This is local planning metadata with explicit `TODO(mainnet)` notes; it is not a replacement for signed/on-chain asset metadata.

The asset registry labels:

- native public LYTH;
- private-denominated LYTH;
- wrapped bridge assets such as `mUSDC` and `mBTC`;
- issuer-native draft assets such as `USDC`;
- demo MRC assets.

`asset_risk_label` and `asset_route_labels` are wallet-facing helpers. They return labels such as `native_asset`, `wrapped_asset`, `bridge_dependency`, `issuer_supported`, and `privacy_cordon`.

`privacy_policy_check` enforces the private-denomination cordon. Known private assets, such as `pLYTH`, are refused for commerce, service payments, escrow, bridges, staking, contracts, markets, discovery, and issuer registration. The same local policy is enforced by order creation, order payment preparation, booking creation, and bridge quotes.

Use `contract_path_guidance` when a user asks to deploy Solidity or EVM bytecode. It returns the explicit no-EVM answer and points to the future Rust/RISC-V MRV contract path.

## Commerce Safety And Risk Summaries

`commerce_safety_check` applies a local client-side safety policy before vendor discovery, provider onboarding, orders, and bookings. It blocks obvious illicit-commerce requests and warns on restricted categories such as travel, gift cards, legal, medical, and regulated finance. This is not a protocol validity rule; it is a wallet/MCP guardrail so assistants do not help source illegal goods or services.

`risk_explain` renders policy inputs into a Markdown summary with the operation, amount, counterparty, decision, violations, warnings, assumptions, receipt path, and retry path. The same renderer is now attached to bridge quotes, merchant checks, order quotes, order creation, order payment preparation, booking creation, and provider onboarding drafts.

`tx_error_explain` turns raw failures into assistant-readable recovery guidance. It recognizes mempool encrypted-envelope failures, disabled broadcast, RPC outages, insufficient funds, nonce/duplicate payloads, privacy-denomination violations, commerce-safety refusals, merchant-policy blocks, bridge-route failures, and generic contract reverts. Failed `wallet_build_transfer`, `agent_wallet_drain`, `submit_signed_transaction`, and `tx_outbox_retry` responses include this explanation automatically.

`ask_chain` is a lightweight natural-language router. It maps common questions to typed MCP surfaces such as `chain_status`, `account_overview`, `tx_lookup`, `tx_error_explain`, `vendor_search`, `asset_search`, `bridge_routes`, `bridge_quote`, `markets`, or `search_chain`, and returns the source RPC methods or local registry hashes it used.

`provider_onboarding_draft` builds draft-only metadata for a future provider listing: local vendor registry record, merchant policy, availability placeholder, and optional webhook connector shape. It does not publish anything on-chain and includes `TODO(mainnet)` notes for real signed discovery metadata and provider verification.

## Security And Readiness Dashboards

Use `security_status` for a compact threat posture summary. It checks local RPC/write readiness, bridge verifier posture, bridge route posture, oracle service metadata, RISC-V VM gate status, local hot-wallet pressure, and signed outbox pressure.

Use `emergency_state_watch` when something looks wrong. It surfaces no-write RPC state, paused bridge routes, stale signed payloads, repeated failed broadcasts, and the current TODO(mainnet) gap for G3/PQ emergency declarations.

Use `bridge_blast_radius` before enabling or reopening any bridge route. It joins local route alerts with bridge/swap receipts and signed bridge-like outbox payloads. The current MCP does not build live bridge transactions yet, so in-flight detection is local-store based until core/indexer settlement state exists.

Use `readiness_check` to show the MCP's mainnet-readiness gates:

| Gate | Current MCP role |
|---|---|
| `no_evm` | no-EVM guidance and Rust/RISC-V direction |
| `mrc` | asset labels and privacy policy only |
| `agent_commerce` | local vendors, orders, bookings, invoices, policies, connectors |
| `bridge` | route metadata, cooldowns, quotes, circuit-breaker watch |
| `wallet` | explicit capped agent wallets, preflight, outbox, receipts, safety profile |
| `runbook` | local canonical runbooks and validation |
| `security` | local dashboard, emergency watcher, recovery drafts |
| `docs` | README plus focused docs under `docs/` |
| `tests` | smoke tests plus golden failure fixtures |

This dashboard is intentionally conservative. Mainnet readiness still depends on core, SDK, indexer, wallet handoff, audits, and live testnet evidence.

## Bridge Route Registry

By default, the MCP loads `bridge_routes.example.json`. These routes are planning/preflight metadata unless a route is explicitly marked `active`.

The registry lets an assistant answer:

- which USDC/ETH/BTC routes exist;
- whether the route is zk-light-client, trusted, issuer-native, or manual;
- cooldown by source chain and trust model;
- route fees, limits, drain caps, circuit-breaker status, finality threshold, and trust assumptions.

Use `bridge_quote` to check a specific amount before a future bridge transaction builder exists. Draft routes intentionally return `executable: false` so the assistant can explain the path without pretending a live bridge transfer can be sent.

Use `bridge_circuit_breaker_watch` to surface route pauses, non-active routes, trusted/transitional risk, missing audit/insurance metadata, and low drain-cap remaining. In this example registry it intentionally returns critical alerts because all routes are draft or paused.

The bundled cooldown posture is:

| Route family | Suggested cooldown |
|---|---|
| Ethereum finalized events | 1 epoch after zk/light-client verification |
| Solana | 1-2 epochs depending on finality confidence |
| Bitcoin | 2 epochs or value-tiered limits |
| Trusted/transitional bridge | Longer cooldown, e.g. 7 days, until zk/light-client path replaces it |

## Cluster And Operator Registry

By default, the MCP loads `clusters.example.json`. This is local planning metadata for operator UX, cluster discovery, delegation decisions, and service-tier routing. It is not a live validator registry.

The local registry lets an assistant answer:

- which clusters exist by region, jurisdiction, status, and open operator seats;
- which clusters are Foundation-controlled;
- which clusters expose RPC, archive, GPU prover, or oracle services;
- which clusters are better candidates for max-decentralization delegation;
- which operators have draft reputation, cluster membership, and attestation status.

Use `cluster_search`, `cluster_reputation`, `cluster_foundation_flag`, and `cluster_sunset_status` for delegation explanations. Use `delegation_cap_explain` for phase-level staking policy: per-cluster cap, minimum diversification, over-cap grace period, and tapered reward assumptions.

`stake_status`, `delegate_draft`, `rebalance_draft`, `undelegate_draft`, and `autovote_simulate` are local planning shims for future staking UX. They rank clusters and produce unsigned plans, but they do not build or submit staking transactions.

Use `monarch_operator_assistant` for node-operator planning: cluster health, 7-of-10 quorum, update status, open seats, resource pressure, and service ROI. It is intentionally node-ops only and should not be mixed into consumer wallet/payment flows.

By default, node-level tools load `nodes.example.json`. Use `node_attestation_get`, `node_pcr_explain`, `node_diversity_score`, and `node_hosting_class` to explain TPM/PCR posture, measured-boot mismatches, ASN/provider/country diversity, and hosting risk. These tools only inspect local placeholder metadata; they do not verify TPM quote signatures.

Use `prover_service_search`, `rpc_service_search`, `archive_service_search`, and `oracle_service_search` for service-tier routing. Use `gpu_proof_market_assistant` when an assistant needs to route a bridge, zkML, or generic proof request to a prover service with fee/latency assumptions. `ask_chain` routes questions such as "Show EU clusters with GPU prover service" and "Which clusters maximize decentralization for my stake?" into these typed tools and returns the local registry hash it used.

Unlike the cluster/operator/node planning tools above (which read bundled metadata), the service-reward tools read the **live chain** through `@monolythium/core-sdk`. Use `service_score_per_cluster` for the "rewards = proved service" view (Component A, Law §7): the settled per-cluster ServiceScore plus the base/availability term (cluster status), the diversity term (ASN/geo/hosting spread), and the archive/prover/rpc/indexer service terms. Use `charter_read` to read a cluster's active + pending economics charter (Component H, Law §6.8) — per-operator member shares, the delegator share, and the pending amendment's effective epoch. Use `update_charter_draft` to build and validate an `updateCharter` amendment offline (it enforces Σ member shares = 10000 bps and the 2000 bps delegator floor, returns the 30-byte charter payload plus the per-signer ML-DSA-65 consent digest, and never assembles submittable calldata or broadcasts).

Every cluster/operator/node response includes TODO(mainnet) assumptions. Production needs signed cluster metadata, live quorum/uptime/slashing feeds, TPM/PCR attestation, service-capacity feeds, and delegation cap checks from core/indexer.

## Wallet Setup

For an explicit agent operating wallet, use `agent_wallet_create`. This records the wallet purpose and local caps, then returns a funding address:

```json
{
  "name": "pizza-agent",
  "purpose": "Small food-ordering demos on testnet",
  "confirm": "CREATE_AGENT_WALLET",
  "maxBalance": "25",
  "lowValueMaxAmount": "10",
  "lowValueDailyLimit": "50",
  "allowedCategories": ["food"]
}
```

The agent can then request funding:

```json
{
  "name": "pizza-agent",
  "amount": "20",
  "asset": "LYTH",
  "purpose": "Pizza demo operating budget"
}
```

For the fastest testnet demo, ask for a funding address. The MCP creates or returns a local-machine protected wallet named `agent-main` and enables capped no-passphrase signing:

```json
{
  "name": "agent-main",
  "lowValueMaxAmount": "10",
  "lowValueDailyLimit": "50"
}
```

The response includes `fundingAddress`. Send only testnet or capped agent funds there.

Create a local agent wallet with passphrase protection:

```json
{
  "name": "agent-main",
  "passphrase": "use-a-real-long-passphrase",
  "revealMnemonic": false
}
```

For testing small autonomous spends, the user can enable capped no-passphrase signing at setup. If `passphrase` is omitted, the MCP uses a local machine key and defaults low-value mode on:

```json
{
  "name": "agent-main",
  "lowValueNoPassphrase": true,
  "lowValueMaxAmount": "10",
  "lowValueDailyLimit": "50"
}
```

Then the assistant can build and sign a small transfer without asking for the passphrase again:

```json
{
  "walletName": "agent-main",
  "to": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
  "amount": "9",
  "sign": true,
  "allowLowValueSigning": true,
  "broadcast": false
}
```

Named contacts can be stored in the local addressbook and then used directly as recipients:

```json
{
  "name": "Neo",
  "address": "mono192nzzjdv8flex940av5eh0gh5nwtku9k5kehrm",
  "tags": ["team"]
}
```

```json
{
  "walletName": "agent-main",
  "to": "Neo",
  "amount": "0.1",
  "sign": true,
  "allowLowValueSigning": true,
  "broadcast": true
}
```

Amounts above the low-value cap are blocked unless the wallet was passphrase-protected and the passphrase is supplied. Low-value accounting is reserved when the MCP creates a signed payload, not when final settlement is observed, because a signed payload can be submitted later. Broadcast acceptance moves the amount from `reserved` to `submitted`; `tx_status_summary` or `tx_watch` moves it to `confirmed` or `failed` once a receipt is observed. If broadcast fails, retry the returned outbox entry; do not rebuild the transfer unless you intentionally want a new signed payload and a new low-value reservation.

Signed payloads receive a local expiry timestamp, default 24 hours. Expiry only releases the MCP allowance reservation; it cannot invalidate a signed payload that was copied elsewhere. Use `tx_outbox_expire_stale` to list expired candidates, then call it with `release=true` and `confirm: "EXPIRE_STALE_RESERVATIONS"` to move eligible reservations to the `expired` bucket. Use `tx_outbox_release` for one entry.

Signed payloads are now also written to the local outbox. Prefer retrying with `tx_outbox_retry`:

```json
{
  "id": "outbox_..."
}
```

Use `mcp_dashboard` when you want a Claude Code-friendly Markdown view of wallets, outbox entries, receipts, connectors, orders, bookings, invoices, and merchant policies.

Before signing a payment, the MCP now runs transfer preflight checks. You can call the same checks directly:

```json
{
  "walletName": "pizza-agent",
  "to": "Neo",
  "amount": "0.1",
  "sign": true,
  "allowLowValueSigning": true
}
```

Use `rpc_health` to see which RPC endpoint will be preferred for writes.

For display-only approval text without signing, call:

```json
{
  "walletName": "pizza-agent",
  "to": "Neo",
  "amount": "0.1"
}
```

## Example: Pizza Payment Runbook

User:

```text
Hey assistant, I'm hungry.
```

Assistant:

```text
I can order your usual pizza for 10 LYTH.
Delivery should arrive within 30 minutes. Approve spend?
```

The assistant drafts:

```json
{
  "runbook": "pay_vendor",
  "fields": {
    "recipient": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
    "vendorId": "pizza-demo",
    "amount": "10",
    "asset": "LYTH",
    "category": "food",
    "memo": "usual pizza, no pineapple, add 1 LYTH tip"
  },
  "policy": {
    "maxAmount": "15",
    "assetAllowlist": ["LYTH"],
    "vendorAllowlist": ["pizza-demo"],
    "categoryAllowlist": ["food"],
    "requireHumanApproval": true
  }
}
```

Then it calls `validate_runbook`.

If valid, it calls `prepare_wallet_request` with the user's `from` address:

```json
{
  "runbook": "pay_vendor",
  "from": "mono142424242424242424242424242424242ga9n5c",
  "fields": {
    "recipient": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
    "vendorId": "pizza-demo",
    "amount": "10",
    "asset": "LYTH",
    "category": "food"
  },
  "policy": {
    "maxAmount": "15",
    "assetAllowlist": ["LYTH"],
    "vendorAllowlist": ["pizza-demo"],
    "categoryAllowlist": ["food"],
    "requireHumanApproval": true
  }
}
```

The MCP returns a wallet request:

```json
{
  "method": "eth_sendTransaction",
  "params": [
    {
      "from": "mono142424242424242424242424242424242ga9n5c",
      "to": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
      "value": "0x8ac7230489e80000",
      "data": "0x",
      "chainId": "0x10f2c"
    }
  ]
}
```

The wallet must render that request and the user must approve it.

## Example: Agent Wallet Funding Request

```json
{
  "runbook": "request_funds",
  "fields": {
    "agentAddress": "mono1hwamhwamhwamhwamhwamhwamhwamhwam6rjwp2",
    "amount": "50",
    "asset": "LYTH",
    "purpose": "Legal review agent budget"
  },
  "policy": {
    "maxAmount": "50",
    "assetAllowlist": ["LYTH"],
    "requireHumanApproval": true
  }
}
```

This runbook produces a funding request. Use `wallet_setup` separately when the user wants the MCP to create a local encrypted agent wallet.

## Vendor Registry

By default, the MCP loads the bundled `vendors.example.json` demo registry. Set `LYTH_MCP_VENDOR_REGISTRY` only when you want to override it with another JSON file:

```bash
LYTH_MCP_VENDOR_REGISTRY=./vendors.example.json npm start
```

Shape:

```json
{
  "schemaVersion": 1,
  "network": "testnet-69420",
  "vendors": [
    {
      "id": "pizza-demo",
      "displayName": "Pizza Demo Vendor",
      "category": "food",
      "address": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
      "acceptedAssets": ["LYTH"],
      "maxOrderAmount": "25",
      "serviceTags": ["pizza", "delivery"],
      "catalog": [
        {
          "id": "margherita",
          "name": "Margherita",
          "price": "9",
          "asset": "LYTH"
        }
      ]
    }
  ]
}
```

The included `vendors.example.json` contains demo vendors for:

| Vendor ID | Category | Purpose |
|---|---|---|
| `pizza-demo` | `food` | 10 pizza SKUs for payment/runbook testing |
| `flight-tickets-demo` | `travel` | Fake flight booking requests |
| `plumber-demo` | `home_services` | Fake plumber/service-call booking |
| `coinsbee-giftcards-demo` | `gift_cards` | Unofficial sandbox gift-card metadata; no real Coinsbee API calls |
| `legal-review-demo` | `professional_services` | Existing professional-services demo |

This local registry is only an MVP discovery layer. A production vendor registry should be on-chain or backed by signed vendor metadata, real vendor verification, and fulfillment webhooks/API credentials.

The MCP now computes registry hashes and can verify optional `ed25519` signature metadata when present:

```json
{
  "signature": {
    "algorithm": "ed25519",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
    "signatureBase64": "..."
  }
}
```

Signature verification covers the canonical registry payload excluding `signature` and `signatures`.

## Demo Orders

Local orders are for MCP flow testing. They do not contact real vendors or deliver real goods.

Typical flow:

1. `order_quote`
2. `order_create`
3. `order_pay`
4. `order_mark_paid` with an observed tx hash, or continue as payment-prepared in a dry run
5. `order_fulfill_dry_run` for a demo, `order_fulfill_webhook` for a configured vendor connector, or `order_fulfill_manual` with a vendor confirmation/reference
6. `order_receipt`

Quotes and order creation include local merchant-risk, asset/privacy, commerce-safety, and plain-English risk summaries. If a vendor is denylisted, exceeds a configured cap, uses a blocked asset, falls outside an allowed category, or matches blocked commerce policy, `order_quote`, `order_create`, and `order_pay` refuse the flow.

## Fulfillment Connectors

Connectors are local webhook/API-key records for vendor integrations. Secrets are encrypted at rest with `LYTH_MCP_CONNECTOR_KEY` and never returned by list/get tools.

Example:

```json
{
  "id": "pizza-demo-webhook",
  "vendorId": "pizza-demo",
  "endpoint": "https://vendor.example/orders",
  "authMode": "hmac_sha256",
  "secret": "vendor-shared-secret",
  "confirm": "STORE_CONNECTOR"
}
```

Use `connector_test_webhook` without `send=true` to preview the payload hash and endpoint before sending. `order_fulfill_webhook` and `booking_send_webhook` require explicit confirmation and record receipts/events. A successful webhook means the external service accepted the request; it is not final proof that goods or services were delivered.

### Demo Connector Templates

`demo_connector_templates`, `demo_connector_get`, and `demo_connector_draft` provide clearly marked TODO/demo stubs for product-specific integrations:

- Stripe checkout;
- Coinsbee-style gift cards;
- travel booking;
- food delivery;
- service providers;
- Agent Commerce Protocol;
- Universal Commerce Protocol.

Generated drafts are disabled by default and include TODO notes. Do not enable a real connector until provider terms, credentials, webhook verification, refund/dispute handling, and merchant policy are reviewed.

## Merchant Risk Controls

Merchant policies are local MCP controls for agent-commerce safety. They do not modify the vendor registry or on-chain state.

Example:

```json
{
  "vendorId": "pizza-demo",
  "allowlisted": true,
  "maxOrderAmount": "15",
  "allowedAssets": ["LYTH"],
  "allowedCategories": ["food"],
  "refundPolicy": "Demo refunds are manual.",
  "fulfillmentSla": "30 minutes in demo text only."
}
```

Use `merchant_risk_check` before creating an order or booking when an assistant wants to explain policy basis, caps, notes, commerce-safety status, and refusal reasons in plain language.

## Service Bookings

Bookings model the service side of agent commerce: a plumber request, travel request, legal review, food delivery request, or similar external service. They are local workflow records until real vendor connectors and escrow modules exist.

Typical flow:

1. `booking_request_create`
2. `booking_send_webhook` for a configured provider, or `booking_accept_demo` for local demos
3. `booking_prepare_escrow` when the service needs deliverable-based payment
4. `booking_mark_paid` with an observed payment or escrow tx hash
5. `booking_complete_dry_run`, `booking_dispute_demo`, or `booking_cancel`

`booking_request_create` attaches a canonical `book_service` runbook draft. `booking_prepare_escrow` attaches a canonical `open_escrow` draft. Booking creation enforces the same local merchant, asset/privacy, commerce-safety, and risk-summary checks as orders.

## Invoices And Funding Requests

`invoice_create` and `funding_request_create` create local payment requests with a `monolythium://send` URI and a canonical `request_funds` runbook draft. They do not watch for payment automatically yet; use `invoice_mark_paid` with an observed tx hash.

## Broadcasting Signed Payloads

By default, `submit_signed_transaction` and `wallet_build_transfer` refuse to broadcast.

To enable broadcast of signed payloads:

```bash
LYTH_MCP_ENABLE_SUBMIT=1 npm start
```

Supported broadcast modes:

| Kind | RPC method |
|---|---|
| `eth_raw` | `eth_sendRawTransaction` |
| `lyth_encrypted` | `lyth_submitEncrypted` |

`submit_signed_transaction` only submits a payload that was signed elsewhere. `wallet_build_transfer` can sign from a local encrypted MCP wallet, but it still will not broadcast unless `LYTH_MCP_ENABLE_SUBMIT=1`.

When `wallet_build_transfer` signs and broadcast fails, it returns `broadcastError` plus a `retry` object. Retry the exact same `payloadHex` with `submit_signed_transaction`. Rebuilding a transfer signs a fresh payload and reserves low-value allowance again.

## Production Notes

Before treating this as a public product, the next pieces should be added:

- wallet extension handoff for approval requests;
- mono1-to-0x address resolution through the SDK;
- MRC token payment builders;
- signed/on-chain asset registry and privacy event metadata;
- on-chain or signed vendor registry with verified fulfillment connectors;
- escrow module integration;
- spot-market order transaction builder;
- spending-policy transaction builder;
- receipt matching against expected sender, recipient, asset, and amount;
- runbook signature format so agents and wallets can attest to the exact approved workflow.

## Development

Type-check:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Smoke test built package output:

```bash
npm test
```

Run:

```bash
npm start
```

## External Commerce (NOWPayments, ChangeNow, Travala, Coinsbee, Duffel)

An optional surface lets the agent reach mainstream crypto-commerce vendors through hosted payment processors and travel connectors. There is no EVM hot wallet, x402, or ERC-8004 agent-identity surface — Monolythium is a no-EVM chain (see `contract_path_guidance` / `readiness_check gate=no_evm`). Payment connectors are sandbox-first: settlement runs through the vendor's own processor, and lyth_mcp builds, signs, and tracks locally rather than custodying funds.

Quick map (every tool listed below is registered by the server):

| Need | Tools |
|---|---|
| NOWPayments (crypto checkout) | `nowpayments_configure`, `nowpayments_config_redacted`, `nowpayments_status`, `nowpayments_currencies`, `nowpayments_merchant_coins`, `nowpayments_estimate`, `nowpayments_payment_create`, `nowpayments_invoice_create`, `nowpayments_payment_status`, `nowpayments_payment_list`, `nowpayments_refund_draft`, `nowpayments_ipn_verify` |
| ChangeNow (swap / fiat) | `changenow_configure`, `changenow_config_redacted`, `changenow_status`, `changenow_currencies`, `changenow_min_amount`, `changenow_estimate`, `changenow_swap_create`, `changenow_swap_status`, `changenow_swap_list`, `changenow_fiat_estimate`, `changenow_fiat_sell_draft` |
| Travala (hosted MCP proxy) | `travala_info`, `travala_proxy_call`, `travala_book_recover`, `travala_flight_capability_probe` |
| Coinsbee (interim NOWPayments path) | `coinsbee_guide`, `coinsbee_via_nowpayments_track` |
| Secure traveler profiles (encrypted PII) | `profile_create`, `profile_update`, `profile_list`, `profile_get`, `profile_reveal`, `profile_delete`, `profile_store_info` |
| Flights via Duffel (real catalog) | `duffel_configure`, `duffel_config_redacted`, `flight_search`, `flight_offer_get`, `flight_seat_maps`, `flight_order_create_hold`, `flight_order_create_instant`, `flight_order_pay`, `flight_order_get`, `flight_order_list`, `flight_order_cancel`, `flight_order_cancel_confirm` |
| Flights via crypto OTA + NOWPayments | `flight_ota_nowpayments_track` |
| Readiness | `readiness_check gate=external_commerce` |

## Additional Docs

Focused docs live in:

```text
docs/CLAUDE_CODE_EXAMPLES.md
docs/OPERATOR_GUIDE.md
docs/VENDOR_REGISTRY.md
docs/RUNBOOK_GUIDE.md
docs/EXTERNAL_COMMERCE.md
```
