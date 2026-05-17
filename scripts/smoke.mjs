import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "lyth-mcp-smoke-"));
process.env.LYTH_MCP_CONNECTOR_STORE = join(temp, "connectors.json");
process.env.LYTH_MCP_CONNECTOR_KEY = join(temp, "connector.key");
process.env.LYTH_MCP_MERCHANT_POLICY_STORE = join(temp, "merchant_policies.json");
process.env.LYTH_MCP_BOOKING_STORE = join(temp, "bookings.json");
process.env.LYTH_MCP_ORDER_STORE = join(temp, "orders.json");
process.env.LYTH_MCP_INVOICE_STORE = join(temp, "invoices.json");

const connectors = await import("../dist/connectors.js");
const merchant = await import("../dist/merchant_policy.js");
const bookings = await import("../dist/bookings.js");
const orders = await import("../dist/orders.js");
const invoices = await import("../dist/invoices.js");
const bridges = await import("../dist/bridges.js");
const assets = await import("../dist/assets.js");
const runbooks = await import("../dist/runbooks.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const connector = await connectors.upsertConnector({
  id: "pizza-demo-webhook",
  vendorId: "pizza-demo",
  endpoint: "https://vendor.example/orders",
  authMode: "hmac_sha256",
  secret: "test-secret",
});
const listedConnectors = await connectors.listConnectors({ vendorId: "pizza-demo" });
const headers = await connectors.buildConnectorHeaders(connector, JSON.stringify({ test: true }));
assert(listedConnectors.length === 1, "expected connector list to include one connector");
assert(listedConnectors[0].auth.secretConfigured === true, "expected connector secret to be redacted but configured");
assert(typeof headers["X-Lyth-Signature"] === "string", "expected hmac signature header");

const vendor = { id: "pizza-demo", displayName: "Pizza Demo", category: "food", fulfillment: { type: "demo" } };
await merchant.upsertMerchantPolicy({
  vendorId: "pizza-demo",
  allowlisted: true,
  maxOrderAmount: "15",
  allowedAssets: ["LYTH"],
  allowedCategories: ["food"],
});
const policy = await merchant.getMerchantPolicy("pizza-demo");
const allowedRisk = merchant.evaluateMerchantPolicy({ vendor, policy, amount: "12", asset: "LYTH" });
const blockedRisk = merchant.evaluateMerchantPolicy({ vendor, policy, amount: "20", asset: "LYTH" });
assert(allowedRisk.ok === true, "expected merchant policy to allow 12 LYTH");
assert(blockedRisk.ok === false, "expected merchant policy to block 20 LYTH");

const order = await orders.createOrder({
  network: "testnet-69420",
  chainId: 69420,
  vendorId: "pizza-demo",
  vendorDisplayName: "Pizza Demo",
  vendorAddress: "0x1111111111111111111111111111111111111111",
  itemName: "Margherita",
  quantity: 1,
  amount: "9",
  asset: "LYTH",
  registryHash: "sha256:test",
  quote: {},
});
await orders.updateOrder(order.id, {
  status: "fulfillment_requested",
  fulfillment: {
    adapter: "webhook",
    confirmation: "accepted",
    requestedAt: new Date().toISOString(),
    connectorId: connector.id,
    responseStatus: 202,
    responseHash: "sha256:test",
  },
}, { type: "fulfillment_webhook_sent" });
assert((await orders.getOrder(order.id)).status === "fulfillment_requested", "expected order webhook status");

const booking = await bookings.createBooking({
  network: "testnet-69420",
  chainId: 69420,
  vendorId: "pizza-demo",
  service: "Pizza delivery",
  amount: "9",
  asset: "LYTH",
  registryHash: "sha256:test",
});
await bookings.updateBooking(booking.id, { status: "provider_requested" }, { type: "booking_webhook_sent" });
assert((await bookings.getBooking(booking.id)).status === "provider_requested", "expected booking provider request status");

const invoice = await invoices.createInvoice({
  type: "funding_request",
  network: "testnet-69420",
  chainId: 69420,
  recipient: "0x1111111111111111111111111111111111111111",
  amount: "10",
  asset: "LYTH",
  purpose: "Smoke test funding",
});
await invoices.updateInvoice(invoice.id, { status: "paid", txHash: "0xabc" }, "paid", { txHash: "0xabc" });
assert((await invoices.getInvoice(invoice.id)).status === "paid", "expected paid invoice");

const bridgeRegistry = await bridges.loadBridgeRegistry("./bridge_routes.example.json");
const bridgeRoute = bridges.selectBridgeRoute(bridgeRegistry.registry, {
  asset: "USDC",
  sourceChain: "Ethereum",
  destinationChain: "Monolythium",
});
assert(bridgeRoute?.id === "eth-usdc-to-mono-zk", "expected Ethereum USDC route");
const bridgeQuote = bridges.quoteBridgeRoute(bridgeRoute, {
  amount: "100",
  asset: "USDC",
  epochHours: bridgeRegistry.registry.epochHours,
});
assert(bridgeQuote.executable === false, "expected draft bridge route to be non-executable");
assert(bridgeQuote.cooldown.hours === 14, "expected one-epoch bridge cooldown");

const assetRegistry = await assets.loadAssetRegistry("./asset_registry.example.json");
const publicLyth = assets.getAsset(assetRegistry.registry, "LYTH");
const privateLyth = assets.getAsset(assetRegistry.registry, "pLYTH");
const wrappedUsdc = assets.getAsset(assetRegistry.registry, "mUSDC");
const publicCommerce = assets.evaluateAssetUseCase(publicLyth, "commerce");
const privateCommerce = assets.evaluateAssetUseCase(privateLyth, "commerce");
const wrappedRisk = assets.assetRisk(wrappedUsdc);
assert(publicCommerce.ok === true, "expected public LYTH commerce to be allowed");
assert(privateCommerce.ok === false && privateCommerce.code === "PrivacyDenominationViolation", "expected private LYTH commerce violation");
assert(wrappedRisk.labels.includes("bridge_route"), "expected wrapped USDC bridge route label");

const runbookList = await runbooks.listCanonicalRunbooks("./runbooks");
assert(runbookList.length >= 9, "expected bundled canonical runbooks");

console.log(JSON.stringify({
  ok: true,
  temp,
  connector: connector.id,
  order: order.id,
  booking: booking.id,
  invoice: invoice.id,
  bridgeRoute: bridgeRoute.id,
  assets: assetRegistry.registry.assets.length,
  runbooks: runbookList.length,
}, null, 2));
