# Vendor Registry Guide

The bundled `vendors.example.json` is a local demo registry. It is useful for testing AI runbooks, not for production commerce.

## Required Vendor Fields

```json
{
  "id": "pizza-demo",
  "displayName": "Pizza Demo Vendor",
  "category": "food",
  "address": "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
  "acceptedAssets": ["LYTH"],
  "maxOrderAmount": "100",
  "serviceTags": ["pizza", "delivery", "demo"],
  "fulfillment": {
    "type": "delivery_demo",
    "requiredFields": ["deliveryAddress", "phone", "orderNotes"]
  }
}
```

## Signature Metadata

The MCP can report optional `ed25519` registry signature status:

```json
{
  "signature": {
    "algorithm": "ed25519",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
    "signatureBase64": "..."
  }
}
```

The signature covers the canonical registry payload excluding `signature` and `signatures`.

## Demo Connectors

Use:

```text
demo_connector_templates
demo_connector_get
demo_connector_draft
```

The current connector templates are TODO/demo stubs for:

- Stripe checkout;
- Coinsbee-style gift cards;
- travel booking;
- food delivery;
- service providers;
- Agent Commerce Protocol;
- Universal Commerce Protocol.

Generated connector drafts are disabled by default. Real integrations need provider approval, API credentials, webhook verification, refund/dispute handling, and local merchant risk policy.

## Production Requirements

Before a vendor is production-ready:

- verify provider identity and jurisdiction;
- configure merchant policy caps;
- verify refund and dispute terms;
- use webhook/API credentials stored through `connector_set`;
- verify external callbacks before marking orders fulfilled;
- bind discovery metadata to on-chain or signed registry data once core/indexer support exists.

