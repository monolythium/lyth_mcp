# Operator Guide

This MCP exposes local planning tools for operators and support users. It does not replace signed core/indexer data.

## Daily Checks

Run:

```text
mcp_dashboard
security_status
emergency_state_watch
readiness_check
```

Watch for:

- no write-ready RPC endpoint;
- paused bridge route;
- stale signed outbox payloads;
- repeated broadcast failures;
- enabled hot wallets with high balances;
- missing audit/research gates.

## Bridge Incidents

Use:

```text
bridge_circuit_breaker_watch
bridge_blast_radius
bridge_status_summary
```

If a route is paused or critical:

1. Stop new route usage in the client.
2. Review in-flight local receipts and outbox entries.
3. Keep draft routes non-executable.
4. Wait for core/indexer route state before reopening production flows.

## Agent Wallet Incidents

Use:

```text
wallet_safety_profile
recovery_status
recovery_runbook_draft
```

For suspected compromise:

1. `agent_wallet_pause`
2. `agent_wallet_drain`
3. `tx_outbox_release` only for stale local allowance reservations
4. `agent_wallet_delete` only after funds are drained or intentionally abandoned

## Known Local-Only Surfaces

These are intentionally TODO/mainnet:

- G3 emergency declarations;
- PQ checkpoints;
- live bridge settlement state;
- live TPM quote verification;
- wallet-native passkey/hardware threshold state;
- on-chain spending policies.

