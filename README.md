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
| `LYTH_MCP_ENABLE_SUBMIT` | `0` | Set to `1` to allow broadcasting already-signed payloads |
| `LYTH_MCP_WALLET_STORE` | `~/.lyth_mcp/wallets.json` | Local encrypted wallet store path |
| `LYTH_MCP_HOT_KEY` | `~/.lyth_mcp/hot.key` | Local key file used only for opt-in low-value mode |
| `LYTH_MCP_LOCAL_KEY` | `~/.lyth_mcp/local.key` | Local machine key used for passphrase-less agent wallets |
| `LYTH_MCP_ADDRESSBOOK` | `~/.lyth_mcp/addressbook.json` | Local contact/addressbook store path |
| `LYTH_MCP_WALLET_PASSPHRASE` | unset | Optional env passphrase for unattended passphrase signing; safer to pass per call |
| `LYTH_MCP_DEFAULT_LOW_VALUE_MAX` | `10` | Default LYTH per-transaction cap for passphrase-less wallets |
| `LYTH_MCP_DEFAULT_LOW_VALUE_DAILY_LIMIT` | `50` | Default LYTH daily cap for passphrase-less wallets |

Use `LYTH_RPC_URLS` when you want the MCP to probe your own RPC fleet:

```bash
LYTH_RPC_URLS="http://node1:8545,http://node2:8545" npm start
```

## Tools

### Live Chain Tools

| Tool | Purpose |
|---|---|
| `chain_status` | Probe RPC endpoints and return chain, round, mempool, indexer, and sync status |
| `account_overview` | Get balance, nonce, label, profile, and flow for an address |
| `recent_transactions` | Read recent transactions from `lyth_txFeed` |
| `tx_lookup` | Look up status, receipt, transaction, and decoded view by tx hash |
| `search_chain` | Search addresses, hashes, blocks, clusters, and labels |
| `markets` | List live CLOB markets or inspect one market with optional book/trades |
| `api_get` | Low-level read-only helper for `/api/v1` |

### AI Runbook Tools

| Tool | Purpose |
|---|---|
| `list_runbooks` | Show supported runbooks and live-readiness status |
| `draft_runbook` | Create a typed runbook intent |
| `validate_runbook` | Check a runbook against spending policy and safety rules |
| `prepare_wallet_request` | Prepare a wallet approval payload where supported |
| `vendor_search` | Search a local vendor registry JSON |
| `submit_signed_transaction` | Broadcast an already-signed payload, disabled unless explicitly enabled |

### Local Wallet Tools

| Tool | Purpose |
|---|---|
| `wallet_funding_address` | Create or return a local testnet agent wallet funding address |
| `wallet_setup` | Create a local encrypted PQM-1/ML-DSA-65 agent wallet |
| `wallet_import` | Import an existing PQM-1 mnemonic into the encrypted store |
| `wallet_list` | List local wallets and low-value policy status |
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

## Wallet Setup

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

Amounts above the low-value cap are blocked unless the wallet was passphrase-protected and the passphrase is supplied. Low-value accounting is reserved when the MCP creates a signed payload, not when final settlement is observed, because a signed payload can be submitted later. If broadcast fails, retry the returned `built.signed.encryptedEnvelopeHex` with `submit_signed_transaction`; do not rebuild the transfer unless you intentionally want a new signed payload and a new low-value reservation.

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

Run:

```bash
npm start
```
