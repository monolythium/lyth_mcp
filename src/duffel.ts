import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProfilePlaintext } from "./profiles.js";

const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;

export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const DUFFEL_API_VERSION = "v2";

export interface DuffelEncryptedPayload {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  params: { n: number; r: number; p: number; keyLen: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface DuffelConfig {
  schemaVersion: 1;
  // Duffel does not have separate sandbox base URLs; the access-token type
  // ('Test Mode' vs 'Live Mode' tokens) determines whether resources are
  // simulated. We track which was last configured so we can warn on live use.
  declaredEnvironment: "test" | "live";
  encryptedAccessToken: DuffelEncryptedPayload;
  defaultCurrency?: string;
  configuredAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Config store
// -----------------------------------------------------------------------------

export function duffelConfigPath(): string {
  return process.env.LYTH_MCP_DUFFEL_CONFIG || join(homedir(), ".lyth_mcp", "duffel.json");
}

function duffelKeyPath(): string {
  return process.env.LYTH_MCP_DUFFEL_KEY || join(homedir(), ".lyth_mcp", "duffel.key");
}

async function readOrCreateKey(): Promise<string> {
  const path = duffelKeyPath();
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  return key;
}

function deriveKey(passphrase: string, salt: Uint8Array, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }): Buffer {
  return scryptSync(passphrase, salt, params.keyLen, { N: params.n, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}

function encryptSecret(secret: string, passphrase: string): DuffelEncryptedPayload {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    params: { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSecret(payload: DuffelEncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(passphrase, salt, payload.params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function readDuffelConfig(path = duffelConfigPath()): Promise<DuffelConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as DuffelConfig;
    if (parsed.schemaVersion !== STORE_VERSION) throw new Error(`unsupported duffel config shape at ${path}`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeDuffelConfig(config: DuffelConfig, path = duffelConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function configureDuffel(args: {
  declaredEnvironment: "test" | "live";
  accessToken: string;
  defaultCurrency?: string;
}): Promise<DuffelConfig> {
  const key = await readOrCreateKey();
  const existing = await readDuffelConfig();
  const now = new Date().toISOString();
  const config: DuffelConfig = {
    schemaVersion: STORE_VERSION,
    declaredEnvironment: args.declaredEnvironment,
    encryptedAccessToken: encryptSecret(args.accessToken, key),
    defaultCurrency: args.defaultCurrency ?? existing?.defaultCurrency,
    configuredAt: existing?.configuredAt ?? now,
    updatedAt: now,
  };
  await writeDuffelConfig(config);
  return config;
}

async function requireConfig(): Promise<{ config: DuffelConfig; accessToken: string }> {
  const config = await readDuffelConfig();
  if (!config) throw new Error("duffel not configured; call duffel_configure first");
  const key = await readOrCreateKey();
  return { config, accessToken: decryptSecret(config.encryptedAccessToken, key) };
}

export async function duffelConfigRedacted(): Promise<{ declaredEnvironment: DuffelConfig["declaredEnvironment"]; defaultCurrency?: string; accessTokenConfigured: boolean; configuredAt?: string; updatedAt?: string } | null> {
  const c = await readDuffelConfig();
  if (!c) return null;
  return {
    declaredEnvironment: c.declaredEnvironment,
    defaultCurrency: c.defaultCurrency,
    accessTokenConfigured: true,
    configuredAt: c.configuredAt,
    updatedAt: c.updatedAt,
  };
}

// -----------------------------------------------------------------------------
// HTTP helper
// -----------------------------------------------------------------------------

async function duffelRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const { accessToken } = await requireConfig();
  const url = new URL(DUFFEL_BASE_URL + path);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Duffel-Version": DUFFEL_API_VERSION,
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const body = options.body !== undefined ? JSON.stringify({ data: options.body }) : undefined;
  const res = await fetch(url.toString(), { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  if (!res.ok) {
    throw new Error(`duffel ${method} ${path} ${res.status}: ${text.slice(0, 800)}`);
  }
  const envelope = parsed as { data?: T; meta?: unknown };
  return (envelope?.data ?? (parsed as T));
}

// -----------------------------------------------------------------------------
// Types (minimal — only fields lyth_mcp actually uses)
// -----------------------------------------------------------------------------

export type DuffelCabin = "economy" | "premium_economy" | "business" | "first";
export type DuffelPassengerType = "adult" | "child" | "infant_without_seat";
export type DuffelGender = "m" | "f";

export interface DuffelSlice {
  origin: string;
  destination: string;
  departure_date: string; // YYYY-MM-DD
  departure_time?: { from: string; to: string };
  arrival_time?: { from: string; to: string };
}

export interface DuffelSearchPassenger {
  type: DuffelPassengerType;
  age?: number;
  given_name?: string;
  family_name?: string;
}

export interface DuffelOfferRequest {
  id: string;
  live_mode: boolean;
  created_at: string;
  cabin_class: DuffelCabin;
  slices: DuffelSlice[];
  passengers: Array<DuffelSearchPassenger & { id: string }>;
  offers?: DuffelOffer[];
}

export interface DuffelOffer {
  id: string;
  live_mode: boolean;
  total_amount: string;
  total_currency: string;
  base_amount?: string;
  tax_amount?: string;
  expires_at: string;
  owner: { iata_code: string; name: string };
  slices: Array<{
    origin: { iata_code: string; name: string };
    destination: { iata_code: string; name: string };
    duration: string;
    segments: Array<{
      origin: { iata_code: string };
      destination: { iata_code: string };
      departing_at: string;
      arriving_at: string;
      marketing_carrier: { iata_code: string; name: string };
      operating_carrier?: { iata_code: string; name: string };
      flight_number?: string;
      aircraft?: { name: string };
      passengers?: Array<{ cabin_class: string; cabin_class_marketing_name?: string }>;
    }>;
  }>;
  passengers?: Array<{ id: string; type: DuffelPassengerType; age?: number }>;
  conditions?: {
    refund_before_departure?: { allowed: boolean; penalty_amount?: string; penalty_currency?: string };
    change_before_departure?: { allowed: boolean; penalty_amount?: string; penalty_currency?: string };
  };
  available_services?: unknown;
}

export interface DuffelOrderPassenger {
  id: string;
  type: DuffelPassengerType;
  title?: "mr" | "mrs" | "ms" | "miss" | "dr";
  given_name: string;
  family_name: string;
  gender?: DuffelGender;
  born_on?: string;
  email?: string;
  phone_number?: string;
  identity_documents?: Array<{
    unique_identifier: string;
    expires_on: string;
    issuing_country_code: string;
    type: "passport";
  }>;
  loyalty_programme_accounts?: Array<{ airline_iata_code: string; account_number: string }>;
  infant_passenger_id?: string;
}

export interface DuffelOrder {
  id: string;
  booking_reference?: string;
  live_mode: boolean;
  created_at: string;
  total_amount: string;
  total_currency: string;
  payment_status?: { awaiting_payment?: boolean; payment_required_by?: string; price_guarantee_expires_at?: string };
  passengers: Array<{ id: string; given_name: string; family_name: string }>;
  slices: Array<DuffelOffer["slices"][number]>;
  documents?: Array<{ unique_identifier?: string; type?: string }>;
  conditions?: DuffelOffer["conditions"];
  cancelled_at?: string;
}

// -----------------------------------------------------------------------------
// Endpoint wrappers
// -----------------------------------------------------------------------------

export async function duffelCreateOfferRequest(args: {
  slices: DuffelSlice[];
  passengers: DuffelSearchPassenger[];
  cabinClass?: DuffelCabin;
  maxConnections?: number;
  returnOffers?: boolean;
}): Promise<DuffelOfferRequest> {
  return duffelRequest<DuffelOfferRequest>("POST", "/air/offer_requests", {
    query: { return_offers: args.returnOffers === false ? "false" : undefined },
    body: {
      slices: args.slices,
      passengers: args.passengers,
      cabin_class: args.cabinClass ?? "economy",
      max_connections: args.maxConnections,
    },
  });
}

export async function duffelListOffers(args: {
  offerRequestId: string;
  limit?: number;
  sort?: "total_amount" | "total_duration";
}): Promise<DuffelOffer[]> {
  const offers = await duffelRequest<DuffelOffer[]>("GET", "/air/offers", {
    query: {
      offer_request_id: args.offerRequestId,
      limit: args.limit,
      sort: args.sort,
    },
  });
  return Array.isArray(offers) ? offers : [];
}

export async function duffelGetOffer(offerId: string, withServices = false): Promise<DuffelOffer> {
  return duffelRequest<DuffelOffer>("GET", `/air/offers/${encodeURIComponent(offerId)}`, {
    query: { return_available_services: withServices ? "true" : undefined },
  });
}

export async function duffelGetSeatMaps(offerId: string): Promise<unknown> {
  return duffelRequest<unknown>("GET", "/air/seat_maps", { query: { offer_id: offerId } });
}

export interface DuffelOrderCreate {
  type: "instant" | "hold";
  selected_offers: string[];
  passengers: DuffelOrderPassenger[];
  services?: Array<{ id: string; quantity: number }>;
  payments?: Array<{ type: "balance" | "arc_bsp_cash"; amount: string; currency: string }>;
  metadata?: Record<string, string>;
}

export async function duffelCreateOrder(args: DuffelOrderCreate): Promise<DuffelOrder> {
  return duffelRequest<DuffelOrder>("POST", "/air/orders", { body: args });
}

export async function duffelGetOrder(orderId: string): Promise<DuffelOrder> {
  return duffelRequest<DuffelOrder>("GET", `/air/orders/${encodeURIComponent(orderId)}`);
}

export async function duffelListOrders(args: { limit?: number; awaitingPayment?: boolean } = {}): Promise<DuffelOrder[]> {
  return duffelRequest<DuffelOrder[]>("GET", "/air/orders", {
    query: {
      limit: args.limit,
      awaiting_payment: args.awaitingPayment === undefined ? undefined : String(args.awaitingPayment),
    },
  });
}

export async function duffelCancelOrder(orderId: string): Promise<unknown> {
  return duffelRequest<unknown>("POST", `/air/order_cancellations`, { body: { order_id: orderId } });
}

export async function duffelConfirmCancellation(cancellationId: string): Promise<unknown> {
  return duffelRequest<unknown>("POST", `/air/order_cancellations/${encodeURIComponent(cancellationId)}/actions/confirm`);
}

export async function duffelPayOrder(args: { orderId: string; amount: string; currency: string; type?: "balance" | "arc_bsp_cash" }): Promise<unknown> {
  return duffelRequest<unknown>("POST", "/air/payments", {
    body: {
      order_id: args.orderId,
      payment: {
        type: args.type ?? "balance",
        amount: args.amount,
        currency: args.currency,
      },
    },
  });
}

// -----------------------------------------------------------------------------
// Profile → Duffel passenger mapping
// -----------------------------------------------------------------------------

function pickPassportForCountry(
  profile: ProfilePlaintext,
  preferredCountry?: string,
): NonNullable<ProfilePlaintext["passports"]>[number] | undefined {
  const passports = profile.passports ?? [];
  if (passports.length === 0) return undefined;
  const byLatestExpiry = (a: { expiresOn: string }, b: { expiresOn: string }) => b.expiresOn.localeCompare(a.expiresOn);
  if (preferredCountry) {
    const matches = passports
      .filter((p) => p.countryOfIssue.toUpperCase() === preferredCountry.toUpperCase())
      .sort(byLatestExpiry);
    if (matches.length > 0) return matches[0];
  }
  return [...passports].sort(byLatestExpiry)[0];
}

export function duffelPassengerFromProfile(args: {
  profile: ProfilePlaintext;
  passengerId: string;
  type?: DuffelPassengerType;
  preferredPassportCountry?: string;
  includePassport?: boolean;
  includeLoyalty?: boolean;
}): DuffelOrderPassenger {
  const givenName = args.profile.preferredName ?? args.profile.legalFirstName;
  const familyName = args.profile.legalLastName;
  const gender = args.profile.gender === "M" ? "m" : args.profile.gender === "F" ? "f" : undefined;
  const passport = args.includePassport === false ? undefined : pickPassportForCountry(args.profile, args.preferredPassportCountry);
  const out: DuffelOrderPassenger = {
    id: args.passengerId,
    type: args.type ?? "adult",
    given_name: givenName,
    family_name: familyName,
    email: args.profile.ticketDeliveryEmail ?? args.profile.contact.email,
    phone_number: args.profile.contact.phone,
  };
  if (gender) out.gender = gender;
  if (args.profile.dateOfBirth) out.born_on = args.profile.dateOfBirth;
  if (passport) {
    out.identity_documents = [{
      unique_identifier: passport.number,
      expires_on: passport.expiresOn,
      issuing_country_code: passport.countryOfIssue.toUpperCase(),
      type: "passport",
    }];
  }
  if (args.includeLoyalty !== false && args.profile.frequentFlyerNumbers?.length) {
    out.loyalty_programme_accounts = args.profile.frequentFlyerNumbers.map((ff) => ({
      airline_iata_code: ff.airline.toUpperCase(),
      account_number: ff.number,
    }));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Compact summarizers for tool responses
// -----------------------------------------------------------------------------

export function summarizeOffer(offer: DuffelOffer) {
  return {
    id: offer.id,
    liveMode: offer.live_mode,
    total: `${offer.total_amount} ${offer.total_currency}`,
    expiresAt: offer.expires_at,
    owner: offer.owner.name,
    slices: offer.slices.map((s) => ({
      from: s.origin.iata_code,
      to: s.destination.iata_code,
      duration: s.duration,
      segments: s.segments.map((seg) => ({
        from: seg.origin.iata_code,
        to: seg.destination.iata_code,
        carrier: seg.marketing_carrier.iata_code,
        flightNumber: seg.flight_number,
        departingAt: seg.departing_at,
        arrivingAt: seg.arriving_at,
        cabin: seg.passengers?.[0]?.cabin_class,
      })),
    })),
    refundable: offer.conditions?.refund_before_departure?.allowed,
    changeable: offer.conditions?.change_before_departure?.allowed,
  };
}

export function summarizeOrder(order: DuffelOrder) {
  return {
    id: order.id,
    liveMode: order.live_mode,
    bookingReference: order.booking_reference,
    total: `${order.total_amount} ${order.total_currency}`,
    awaitingPayment: order.payment_status?.awaiting_payment,
    paymentRequiredBy: order.payment_status?.payment_required_by,
    passengers: order.passengers.map((p) => `${p.given_name} ${p.family_name}`),
    slices: order.slices?.map((s) => ({
      from: s.origin.iata_code,
      to: s.destination.iata_code,
      duration: s.duration,
      segments: s.segments.map((seg) => `${seg.marketing_carrier.iata_code} ${seg.flight_number ?? ""} ${seg.origin.iata_code}→${seg.destination.iata_code} ${seg.departing_at}`),
    })),
    cancelledAt: order.cancelled_at,
  };
}
