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

Global install from GitHub:

```bash
npm install -g https://github.com/monolythium-vision/lyth_mcp/archive/refs/heads/main.tar.gz
```

If you specifically want npm's git resolver, use `--install-links=true` with npm 10:

```bash
npm install -g --install-links=true git+https://github.com/monolythium-vision/lyth_mcp.git
```

From this repository:

```bash
cd repos/monolythium-vision/lyth_mcp
npm install
npm run build
```

`@monolythium/core-sdk` is installed from the public GitHub repo `monolythium-vision/mono-core-sdk` through a pinned HTTPS tarball, so this MCP can be installed outside the local monorepo without a nested git build.

Run the server over stdio:

```bash
npm start
```

For development:

```bash
npm run dev
```

## Claude Desktop Example

After building, add an MCP server entry like this:

```json
{
  "mcpServers": {
    "lyth-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/monolythium-vision/lyth_mcp/dist/index.js"],
      "env": {
        "LYTH_NETWORK": "testnet-69420",
        "LYTH_CHAIN_ID": "69420",
        "LYTH_MCP_ENABLE_SUBMIT": "0",
        "LYTH_MCP_WALLET_STORE": "/absolute/path/to/.lyth_mcp/wallets.json",
        "LYTH_MCP_HOT_KEY": "/absolute/path/to/.lyth_mcp/hot.key",
        "LYTH_MCP_LOCAL_KEY": "/absolute/path/to/.lyth_mcp/local.key",
        "LYTH_MCP_ADDRESSBOOK": "/absolute/path/to/.lyth_mcp/addressbook.json",
        "LYTH_MCP_VENDOR_REGISTRY": "/absolute/path/to/monolythium-vision/lyth_mcp/vendors.example.json"
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
| `LYTH_MCP_BRIDGE_ROUTE_REGISTRY` | bundled `bridge_routes.example.json` | Optional path override for local bridge/liquidity route metadata |
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
| `account_overview` | Get balance, nonce, label, profile, and flow for an address |
| `recent_transactions` | Read recent transactions from `lyth_txFeed` |
| `tx_lookup` | Look up status, receipt, transaction, and decoded view by tx hash |
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
| `bridge_routes` | List bridge/liquidity routes with status, cooldown, and trust metadata |
| `bridge_route_get` | Get one bridge route's risk/cooldown/circuit-breaker metadata |
| `bridge_quote` | Preflight a bridge amount against route status, fees, caps, cooldown, and risk |
| `bridge_cooldown_matrix` | Show configured cooldowns by route |
| `bridge_status_summary` | Summarize route health, drain caps, and attention flags |
| `liquidity_onboarding` | Explain how to bring an asset into Mono through configured routes |
| `vendor_registry_info` | Show registry hashes, issuer, expiry, signature status, and categories |
| `vendor_get` | Get one vendor by id |
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
| `wallet_setup` | Create a local encrypted PQM-1/ML-DSA-65 agent wallet |
| `wallet_import` | Import an existing PQM-1 mnemonic into the encrypted store |
| `wallet_list` | List local wallets and low-value policy status |
| `wallet_low_value_accounting` | Show reserved/submitted/confirmed/failed/expired low-value buckets |
| `wallet_preflight_transfer` | Check chain id, balance, nonce, RPC health, encryption key, and policy before signing |
| `wallet_approval_summary` | Render the human-readable approval text for a planned transfer |
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

## Bridge Route Registry

By default, the MCP loads `bridge_routes.example.json`. These routes are planning/preflight metadata unless a route is explicitly marked `active`.

The registry lets an assistant answer:

- which USDC/ETH/BTC routes exist;
- whether the route is IBC, zk-light-client, trusted, issuer-native, or manual;
- cooldown by source chain and trust model;
- route fees, limits, drain caps, circuit-breaker status, finality threshold, and trust assumptions.

Use `bridge_quote` to check a specific amount before a future bridge transaction builder exists. Draft routes intentionally return `executable: false` so the assistant can explain the path without pretending a live bridge transfer can be sent.

The bundled cooldown posture is:

| Route family | Suggested cooldown |
|---|---|
| IBC/Cosmos-style finality | 1 epoch, maybe lower later |
| Ethereum finalized events | 1 epoch after zk/light-client verification |
| Solana | 1-2 epochs depending on finality confidence |
| Bitcoin | 2 epochs or value-tiered limits |
| Trusted/transitional bridge | Longer cooldown, e.g. 7 days, until zk/light-client path replaces it |

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
  "to": "0x1111111111111111111111111111111111111111",
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
  "address": "0x2aa62149ac3a7f9316afeb299bbd17a4dcbb70b6",
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
    "recipient": "0x1111111111111111111111111111111111111111",
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
  "from": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fields": {
    "recipient": "0x1111111111111111111111111111111111111111",
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
      "from": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "to": "0x1111111111111111111111111111111111111111",
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
    "agentAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
      "address": "0x1111111111111111111111111111111111111111",
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

Quotes and order creation include a local merchant-risk evaluation. If a vendor is denylisted, exceeds a configured cap, uses a blocked asset, or falls outside an allowed category, `order_create` and `order_pay` refuse the flow.

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

Use `merchant_risk_check` before creating an order or booking when an assistant wants to explain policy basis, caps, notes, and refusal reasons in plain language.

## Service Bookings

Bookings model the service side of agent commerce: a plumber request, travel request, legal review, food delivery request, or similar external service. They are local workflow records until real vendor connectors and escrow modules exist.

Typical flow:

1. `booking_request_create`
2. `booking_send_webhook` for a configured provider, or `booking_accept_demo` for local demos
3. `booking_prepare_escrow` when the service needs deliverable-based payment
4. `booking_mark_paid` with an observed payment or escrow tx hash
5. `booking_complete_dry_run`, `booking_dispute_demo`, or `booking_cancel`

`booking_request_create` attaches a canonical `book_service` runbook draft. `booking_prepare_escrow` attaches a canonical `open_escrow` draft. Both enforce the same local merchant policy checks as orders.

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
