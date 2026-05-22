# External Commerce Setup

This guide covers the **P14** surface that lets an agent reach mainstream crypto-commerce vendors (NOWPayments, Travala, Coinsbee) using an EVM hot wallet, the [x402](https://github.com/coinbase/x402) payment protocol, and ERC-8004 agent identity.

The lyth_mcp safety model is unchanged: every money-moving path is capped, dry-run-friendly, and gated behind explicit configuration. Broadcasts to EVM chains require `LYTH_MCP_ENABLE_EVM_SUBMIT=1`. None of these tools are custody wallets.

Pages:

- [EVM hot wallet and funding](#evm-hot-wallet-and-funding)
- [x402 + ERC-8004 agent identity](#x402--erc-8004-agent-identity)
- [NOWPayments](#nowpayments)
- [Travala](#travala)
- [Coinsbee](#coinsbee)
- [Secure traveler profiles](#secure-traveler-profiles)
- [Production switch checklist](#production-switch-checklist)

---

## EVM Hot Wallet And Funding

The EVM hot wallet is a **separate, low-value operating wallet** — never custody. It's a fresh secp256k1 key, encrypted at rest with AES-256-GCM (passphrase or local-machine key, same model as PQM-1 agent wallets), with per-`(chain, asset)` caps.

Default supported chains: Ethereum mainnet (`1`) and Base (`8453`). Polygon, Arbitrum, and Optimism are configurable.

### Create

```text
evm_wallet_create
  name = "travala-agent"
  confirm = "CREATE_EVM_WALLET"
  agent = { purpose: "pay-for-hotels-via-travala" }
  allowedChainIds = [8453]            # Base only
  allowedAssets   = ["USDC"]
  lowValueCaps    = [{ chainId: 8453, asset: "USDC", maxPerTx: "200", dailyLimit: "500" }]
  allowLocalKey   = true
```

The response includes the funding address. Treat the returned `privateKey` (only present if `revealPrivateKey: true`) as a secret.

### Fund

```text
evm_wallet_fund_request
  name    = "travala-agent"
  chainId = 8453
  asset   = "USDC"
  amount  = "300"
  purpose = "Tokyo hotel booking May 1-5"
```

This produces a draft you (the principal) approve from a higher-value wallet. The agent cannot raise its own caps or refill itself.

### Limits, pause, drain, delete

```text
evm_wallet_limits        # update caps + agent metadata
evm_wallet_pause         # disable low-value signing, mark paused
evm_wallet_drain_draft   # build a drain transfer (real ERC-20 builders are P14.1; signing/broadcast use that path)
evm_wallet_delete        # remove the record after confirmName check
```

### RPC config

Defaults are public RPCs. Override with `LYTH_MCP_EVM_RPC_<chainId>` (comma-separated for multiple endpoints). Probe with `evm_rpc_health`.

```text
LYTH_MCP_EVM_RPC_8453=https://mainnet.base.org,https://base.llamarpc.com
```

### Native + ERC-20 transfers

```text
evm_native_transfer       # ETH (or chain-native) transfer; EIP-1559
erc20_transfer            # ERC-20 transfer; canonical USDC/USDT addresses bundled
erc20_approve             # exact-amount approve (not unlimited)
erc20_allowance           # read owner→spender allowance
```

All write tools default to building + signing locally. Broadcast is **off** unless `LYTH_MCP_ENABLE_EVM_SUBMIT=1` is set. Outbox + receipt entries are written for every signed payload, so a retry can never double-spend.

Canonical token addresses ship in `src/evm_tokens.ts`. List with `evm_token_list`.

---

## x402 + ERC-8004 Agent Identity

[x402](https://github.com/coinbase/x402) is an open HTTP-402-based payment protocol. The client hits a resource URL, the server replies `402` with an `accepts` array (scheme, asset, amount, payTo), the client signs an EIP-3009 `TransferWithAuthorization` (USDC's permit-style authorization), and retries the request with an `X-PAYMENT` header containing the signed payload.

The `x402_pay` tool does all of this end-to-end against the configured EVM wallet. It will not pay unless a matching **vendor policy** exists.

### 1. Set a vendor policy

```text
x402_vendor_policy_set
  vendorId            = "travala"
  walletName          = "travala-agent"
  originAllowlist     = ["https://travel-mcp.travala.com"]
  allowedAssets       = ["USDC"]
  maxPaymentPerRequest = { "8453:USDC": "500000000" }   # atomic units (USDC = 6 decimals → 500 USDC)
  notes               = "Base USDC, agent_identity used for cbBTC giveback"
```

Caps are in **atomic units**, matching how x402's `maxAmountRequired` is denominated.

### 2. Set local ERC-8004 agent identity (for attribution)

Vendor connectors that support attribution (Travala today, others as ERC-8004 adoption grows) read `agentId` + `rewardWallet` from this local config.

```text
agent_identity_register_guide   # explains the 8004scan.io UI flow

agent_identity_set_local
  agentId      = "your-agentId-from-8004scan"
  rewardWallet = "0xYourBaseEvmAddress"
```

The on-chain `agent_identity_register_draft` tool is intentionally **not** shipped yet: the ERC-8004 reference implementation is on Ethereum Sepolia only, and a verified Base-mainnet IdentityRegistry contract address hasn't been published. Once it has, that tool will land.

### 3. Pay

```text
x402_pay
  vendorId             = "travala"
  url                  = "https://travel-mcp.travala.com/some-paid-resource"
  method               = "POST"
  body                 = { ... }
  dryRun               = true    # see selected requirement without signing
```

Behavior:

- If the server returns anything other than `402`, you get the response back as-is.
- If `402`, the client picks the first `accepts` entry that matches the vendor policy + wallet allowlist (origin, scheme = `"exact"`, network → chainId, asset symbol from `extra.name`, cap), signs the EIP-712/EIP-3009 authorization, and retries with `X-PAYMENT`.
- The `paymentReceipt` field in the response holds the signed authorization, the EIP-712 digest, and the base64 header. It's also written to the outbox so the same resource isn't double-paid on retry.
- An `X-PAYMENT-RESPONSE` header (base64 JSON) on the retry response is decoded into `settlement`.

`dryRun: true` returns the selected `accepts` entry without signing or retrying.

---

## NOWPayments

NOWPayments is a payment processor with public REST docs, a real sandbox, and an HMAC-SHA512 IPN. It's the broadest "reference connector" — any merchant that accepts NOWPayments is reachable.

### Configure

```text
nowpayments_configure
  confirm        = "CONFIGURE_NOWPAYMENTS"
  environment    = "sandbox"           # default; switch to "production" only when intentional
  apiKey         = "<x-api-key>"
  ipnSecret      = "<ipn-secret>"      # optional but required to verify IPN signatures
  ipnCallbackUrl = "https://your-host/np-webhook"   # optional default for new payments
```

Sandbox: register at <https://sandbox.nowpayments.io>; production base is `https://api.nowpayments.io/v1`. The connector encrypts both secrets with a local key.

### Catalog + quote

```text
nowpayments_status
nowpayments_currencies          # all known currencies
nowpayments_merchant_coins      # coins enabled for your account
nowpayments_estimate            # amount + currency_from + currency_to
```

### Create a payment or invoice

```text
nowpayments_payment_create
  priceAmount      = 9.99
  priceCurrency    = "usd"
  payCurrency      = "usdc"             # or any merchant-enabled coin
  orderId          = "order-123"
  orderDescription = "Premium API access"

nowpayments_invoice_create
  priceAmount   = 9.99
  priceCurrency = "usd"
  payCurrency   = "usdc"
  successUrl    = "https://your-host/success"
  cancelUrl     = "https://your-host/cancel"
```

`payment_create` returns a deposit address you can fund with `erc20_transfer` (e.g. `USDC` on Ethereum). `invoice_create` returns a hosted page URL.

### Status + reconciliation

```text
nowpayments_payment_status   paymentId = "12345"
nowpayments_payment_list     limit = 50

nowpayments_ipn_verify
  rawBody    = "<raw webhook body as a JSON string>"
  sigHeader  = "<x-nowpayments-sig value>"

nowpayments_refund_draft     paymentId = "12345"  reason = "..."
```

The IPN verifier sorts the JSON body keys alphabetically, `JSON.stringify`s, and HMAC-SHA512s with the configured IPN secret. Refunds are support-mediated; the tool produces a request, it does not auto-submit.

### Inspect config

```text
nowpayments_config_redacted
```

Shows environment, base URL, IPN callback, and whether the API key + IPN secret are configured (no secret values revealed).

---

## Travala

Travala already ships a hosted MCP server: `https://travel-mcp.travala.com/mcp`. Install it alongside lyth_mcp for catalog + booking tools (`travala_search_hotel`, `travala_search_package`, `travala_manage_bookings`, `travala_cancel_booking`). lyth_mcp owns the wallet, x402 payment, ERC-8004 attribution, outbox, and receipts.

### Setup

1. Install Travala's MCP:

    ```bash
    claude mcp add --transport http travala-mcp https://travel-mcp.travala.com/mcp
    ```

2. Create a Base USDC EVM hot wallet (see [EVM hot wallet](#evm-hot-wallet-and-funding)).
3. Set an x402 vendor policy with `vendorId = "travala"`, `originAllowlist = ["https://travel-mcp.travala.com"]`, and a Base USDC cap.
4. Set local agent identity (`agent_identity_set_local`) with your 8004scan `agentId` and a Base `rewardWallet` to claim 10% cbBTC giveback on completed bookings.

Inspect the wiring at any time with `travala_info`.

### Booking flow

```text
# 1. Catalog (Travala MCP)
travala_search_hotel    location = "Tokyo"  checkIn = "2026-05-01"  checkOut = "2026-05-05"  rooms = ["2"]
travala_search_package  hotelId = "..."     sessionId = "..."

# 2. Book + pay (lyth_mcp owns this end-to-end)
travala_book_pay
  packageId = "..."
  sessionId = "..."
  customer  = { firstName, lastName, email, phone }
  dryRun    = true            # inspect x402 instructions before paying
```

`travala_book_pay` calls `travala_book` on Travala's MCP, parses x402 instructions from the response (structured content, text content, or paymentUrl), invokes `x402_pay` with the configured Base USDC wallet, attaches `agentId` + `rewardWallet`, and polls `travala_book_status` to materialize the confirmed booking. Outbox + receipts capture the tx hash for reconciliation.

### Recovery

If `travala_book_pay` errors, times out, or returns ambiguously, **call `travala_book_recover` before retrying**. It wraps Travala's `travala_book_status` endpoint, which returns one of:

| `interpretation` | meaning | retry safe? |
|---|---|---|
| `completed` | booking succeeded server-side | **no** |
| `in_progress` | server still settling | wait |
| `not_found` | nothing happened | yes |
| `invalid_request` | bad packageId/sessionId/expired | re-quote |
| `server_error` | recovery endpoint down | check email; do not retry |

### Read-only proxy

`travala_proxy_call` forwards arbitrary read-only tool calls to Travala's MCP if you'd rather have one MCP client config:

```text
travala_proxy_call
  tool = "travala_manage_bookings"
  args = { bookingId: "MN5V9DWQ", lastName: "Doe" }
```

---

## Coinsbee

Coinsbee (gift cards in 200+ cryptos, 4000 brands, 185 countries) doesn't publish a public reseller API; access is partnership-gated. Until BD returns a real contract, the supported path is **Coinsbee's own checkout via NOWPayments**.

```text
coinsbee_guide                # full step-by-step
coinsbee_via_nowpayments_track
  paymentId       = "<NOWPayments payment_id from Coinsbee checkout>"
  brand           = "Amazon"
  denomination    = "50 USD"
  region          = "US"
  recipientEmail  = "buyer@example.com"
```

Code retrieval is via email from Coinsbee today; the agent can't auto-fetch the code without mailbox access. Refunds and disputes go through Coinsbee support, not NOWPayments.

A direct `coinsbee_*` connector will land only after the partnership returns real endpoints — no fabricated endpoints.

---

## Secure Traveler Profiles

Frequent-traveler PII (legal name, DOB, passport, contact, ticket delivery email, frequent-flyer numbers, etc.) lives in an encrypted local store with the same model as wallets: AES-256-GCM with a scrypt-derived passphrase key, or a local-machine key for lower-sensitivity setups. Only a redacted preview is visible to `profile_list` / `profile_get`; plaintext requires `profile_reveal`.

### Schema

```json
{
  "legalFirstName": "Nayiem",
  "legalMiddleName": null,
  "legalLastName": "Willems",
  "preferredName": "Nayiem",
  "dateOfBirth": "1990-01-15",
  "nationality": "CA",
  "gender": "M",
  "passports": [
    { "number": "AB1234567", "countryOfIssue": "CA", "expiresOn": "2030-06-01", "issuedOn": "2020-06-01" }
  ],
  "knownTravelerNumbers": { "globalEntry": "GE1234567" },
  "frequentFlyerNumbers": [
    { "airline": "AC", "number": "AC123" },
    { "airline": "WS", "number": "WS456" }
  ],
  "contact": {
    "email": "primary@example.com",
    "phone": "+15555550101",
    "alternateEmail": "backup@example.com"
  },
  "ticketDeliveryEmail": "tickets@example.com",
  "mailingAddress": { "street": "123 Main St", "city": "Kamloops", "region": "BC", "postalCode": "V2C 1A1", "country": "CA" },
  "emergencyContact": { "name": "Jane", "phone": "+15555550102", "relationship": "spouse" },
  "dietaryPreferences": "vegetarian",
  "accessibilityNeeds": null,
  "notes": null
}
```

### Create + manage

```text
profile_create
  confirm     = "CREATE_TRAVELER_PROFILE"
  id          = "nayiem"
  displayName = "Nayiem (personal)"
  profile     = { ... schema above ... }
  passphrase  = "<≥12 chars>"           # or allowLocalKey: true for lower-sensitivity setups

profile_update                          # confirm = "UPDATE_TRAVELER_PROFILE"; patch only the fields you supply
profile_list                            # redacted previews only
profile_get      id = "nayiem"          # redacted preview only
profile_reveal   id = "nayiem"  confirm = "REVEAL_TRAVELER_PROFILE"   # plaintext; do not paste into chat history
profile_delete   id = "nayiem"  confirmId = "nayiem"  confirm = "DELETE_TRAVELER_PROFILE"
profile_store_info
```

### Redaction example

`profile_get` returns:

```json
{
  "legalName": "Nayiem W•••••••",
  "dateOfBirth": "1990-••-••",
  "contact": { "email": "pr•••••@example.com", "phone": "+1•••••••0101", "hasAlternateEmail": true },
  "ticketDeliveryEmail": "ti••••••@example.com",
  "passports": [{ "countryOfIssue": "CA", "expiresOn": "2030-06-01", "last4": "4567" }],
  "frequentFlyerCount": 2,
  "hasMailingAddress": true,
  "hasEmergencyContact": true,
  "hasKnownTraveler": true
}
```

### Using a profile to book

```text
travala_book_pay
  packageId  = "..."
  sessionId  = "..."
  profileId  = "nayiem"                 # pulls firstName/lastName/email/phone from the encrypted profile
  # customer  = { ... }                 # optional override; merged on top of profile values
  dryRun     = true
```

Mapping rules:

- `firstName` ← `preferredName` if set, else `legalFirstName`
- `lastName`  ← `legalLastName`
- `email`     ← `ticketDeliveryEmail` if set, else `contact.email`
- `phone`     ← `contact.phone`

Pass `customer` alongside `profileId` to override specific fields per booking (e.g. a different `email` for a one-off). Passport and DOB are not sent to Travala today — they're stored for flight bookings once a flight connector lands.

### Safety notes

- Profile passphrases are never written anywhere. If you forget the passphrase on a passphrase-protected profile, the profile is unrecoverable.
- `LYTH_MCP_PROFILE_PASSPHRASE` (or `LYTH_MCP_WALLET_PASSPHRASE` as a fallback) lets you avoid passing it per call, but it lives in the process environment — only use it in trusted shells.
- The local-machine key (when `allowLocalKey: true`) is just `~/.lyth_mcp/profiles.key`; protect it like an SSH private key.
- `profile_reveal` output contains plaintext PII — never paste it into chat history or commit it.

## Production Switch Checklist

Sandbox is the default. Before flipping to live broadcast on EVM chains:

- [ ] `mcp_self_check` is green (RPC reachable, stores writable).
- [ ] Outbox is empty for the agent wallet (`tx_outbox_list walletName=<wallet> status=signed` returns nothing).
- [ ] Per-`(chain, asset)` caps are explicitly set on the EVM wallet (`evm_wallet_limits`).
- [ ] Vendor x402 policies have correct `originAllowlist` and atomic-unit caps.
- [ ] ERC-8004 agent identity is set if you want vendor attribution.
- [ ] `LYTH_MCP_ENABLE_EVM_SUBMIT=1` is set in the environment **only** when broadcast is intentional.
- [ ] NOWPayments is on `production` only when fund movement is intentional.

`readiness_check gate=external_commerce` summarizes the current state and gaps.

## Open Items

These are documented in `TODO.md` and are intentionally unshipped until upstream conditions are met:

- ERC-8004 on-chain `agent_identity_register_draft` (awaits verified Base-mainnet IdentityRegistry).
- Direct Coinsbee reseller API (awaits BD/partnership).
- Live verification of Travala's exact tool-result shape (parser handles three known flavors).
- Live NOWPayments sandbox integration tests (`LYTH_MCP_LIVE_NOWPAYMENTS_SANDBOX=1`) — current smoke suite is fully offline.
- Production-switch enforcer tool (`evm_submit_enable_draft`); today the env-var gate is the only enforcement.
