# Runbook Guide

Runbooks are typed AI workflow intents. They are not signed transactions by themselves.

## Current Local Registry

Bundled runbooks live in:

```text
runbooks/
```

Use:

```text
runbook_list
runbook_get
runbook_verify
runbook_diff_versions
```

The local registry uses stable `sha256:` hashes. The production target is a signed SDK/protocol registry with final canonicalization and hash rules.

## Draft And Validate

Typical flow:

1. `draft_runbook`
2. `validate_runbook`
3. `prepare_wallet_request` where supported
4. user/wallet approval
5. local receipt or outbox entry
6. status watcher

Example:

```json
{
  "runbook": "pay_vendor",
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

## Recovery Runbooks

Use `recovery_runbook_draft` for local operational recovery:

- `pause_agent`
- `drain_agent`
- `delete_local_wallet`
- `release_stale_outbox`
- `rotate_emergency_key`

The first four are MCP-local actions. Emergency-key rotation is TODO until core/wallet support exists.

## Production Gaps

Still needed:

- final SDK runbook schema;
- signed registry;
- execution state machine;
- preconditions and post-conditions;
- monitoring engine;
- typed receipt matching;
- bridge/swap/escrow/contract runbooks backed by core builders.

