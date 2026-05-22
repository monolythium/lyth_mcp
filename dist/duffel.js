import { createCipheriv, createDecipheriv, randomBytes, scryptSync, } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const DUFFEL_API_VERSION = "v2";
// -----------------------------------------------------------------------------
// Config store
// -----------------------------------------------------------------------------
export function duffelConfigPath() {
    return process.env.LYTH_MCP_DUFFEL_CONFIG || join(homedir(), ".lyth_mcp", "duffel.json");
}
function duffelKeyPath() {
    return process.env.LYTH_MCP_DUFFEL_KEY || join(homedir(), ".lyth_mcp", "duffel.key");
}
async function readOrCreateKey() {
    const path = duffelKeyPath();
    try {
        return (await readFile(path, "utf8")).trim();
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
    const key = randomBytes(32).toString("hex");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    return key;
}
function deriveKey(passphrase, salt, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }) {
    return scryptSync(passphrase, salt, params.keyLen, { N: params.n, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}
function encryptSecret(secret, passphrase) {
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
function decryptSecret(payload, passphrase) {
    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const key = deriveKey(passphrase, salt, payload.params);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
export async function readDuffelConfig(path = duffelConfigPath()) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== STORE_VERSION)
            throw new Error(`unsupported duffel config shape at ${path}`);
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
export async function writeDuffelConfig(config, path = duffelConfigPath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
}
export async function configureDuffel(args) {
    const key = await readOrCreateKey();
    const existing = await readDuffelConfig();
    const now = new Date().toISOString();
    const config = {
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
async function requireConfig() {
    const config = await readDuffelConfig();
    if (!config)
        throw new Error("duffel not configured; call duffel_configure first");
    const key = await readOrCreateKey();
    return { config, accessToken: decryptSecret(config.encryptedAccessToken, key) };
}
export async function duffelConfigRedacted() {
    const c = await readDuffelConfig();
    if (!c)
        return null;
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
async function duffelRequest(method, path, options = {}) {
    const { accessToken } = await requireConfig();
    const url = new URL(DUFFEL_BASE_URL + path);
    if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        }
    }
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Duffel-Version": DUFFEL_API_VERSION,
        Accept: "application/json",
    };
    if (options.body !== undefined)
        headers["Content-Type"] = "application/json";
    const body = options.body !== undefined ? JSON.stringify({ data: options.body }) : undefined;
    const res = await fetch(url.toString(), { method, headers, body });
    const text = await res.text();
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch { /* keep raw */ }
    if (!res.ok) {
        throw new Error(`duffel ${method} ${path} ${res.status}: ${text.slice(0, 800)}`);
    }
    const envelope = parsed;
    return (envelope?.data ?? parsed);
}
// -----------------------------------------------------------------------------
// Endpoint wrappers
// -----------------------------------------------------------------------------
export async function duffelCreateOfferRequest(args) {
    return duffelRequest("POST", "/air/offer_requests", {
        query: { return_offers: args.returnOffers === false ? "false" : undefined },
        body: {
            slices: args.slices,
            passengers: args.passengers,
            cabin_class: args.cabinClass ?? "economy",
            max_connections: args.maxConnections,
        },
    });
}
export async function duffelListOffers(args) {
    const offers = await duffelRequest("GET", "/air/offers", {
        query: {
            offer_request_id: args.offerRequestId,
            limit: args.limit,
            sort: args.sort,
        },
    });
    return Array.isArray(offers) ? offers : [];
}
export async function duffelGetOffer(offerId, withServices = false) {
    return duffelRequest("GET", `/air/offers/${encodeURIComponent(offerId)}`, {
        query: { return_available_services: withServices ? "true" : undefined },
    });
}
export async function duffelGetSeatMaps(offerId) {
    return duffelRequest("GET", "/air/seat_maps", { query: { offer_id: offerId } });
}
export async function duffelCreateOrder(args) {
    return duffelRequest("POST", "/air/orders", { body: args });
}
export async function duffelGetOrder(orderId) {
    return duffelRequest("GET", `/air/orders/${encodeURIComponent(orderId)}`);
}
export async function duffelListOrders(args = {}) {
    return duffelRequest("GET", "/air/orders", {
        query: {
            limit: args.limit,
            awaiting_payment: args.awaitingPayment === undefined ? undefined : String(args.awaitingPayment),
        },
    });
}
export async function duffelCancelOrder(orderId) {
    return duffelRequest("POST", `/air/order_cancellations`, { body: { order_id: orderId } });
}
export async function duffelConfirmCancellation(cancellationId) {
    return duffelRequest("POST", `/air/order_cancellations/${encodeURIComponent(cancellationId)}/actions/confirm`);
}
export async function duffelPayOrder(args) {
    return duffelRequest("POST", "/air/payments", {
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
function pickPassportForCountry(profile, preferredCountry) {
    const passports = profile.passports ?? [];
    if (passports.length === 0)
        return undefined;
    const byLatestExpiry = (a, b) => b.expiresOn.localeCompare(a.expiresOn);
    if (preferredCountry) {
        const matches = passports
            .filter((p) => p.countryOfIssue.toUpperCase() === preferredCountry.toUpperCase())
            .sort(byLatestExpiry);
        if (matches.length > 0)
            return matches[0];
    }
    return [...passports].sort(byLatestExpiry)[0];
}
// Picks the most universal KTN value from the profile. Global Entry / NEXUS /
// SENTRI members get KTNs that work for TSA PreCheck — they all go in the
// single `known_traveler_number` slot. We prefer Global Entry → TSA PreCheck →
// NEXUS → first 'other' entry.
function pickKnownTravelerNumber(profile) {
    const ktn = profile.knownTravelerNumbers;
    if (!ktn)
        return undefined;
    if (ktn.globalEntry)
        return ktn.globalEntry;
    if (ktn.tsaPrecheck)
        return ktn.tsaPrecheck;
    if (ktn.nexus)
        return ktn.nexus;
    if (ktn.other) {
        const first = Object.values(ktn.other).find((v) => v && v.trim() !== "");
        if (first)
            return first;
    }
    return undefined;
}
const NEVER_EXPIRES = "2099-12-31";
export function duffelPassengerFromProfile(args) {
    const givenName = args.profile.preferredName ?? args.profile.legalFirstName;
    const familyName = args.profile.legalLastName;
    const gender = args.profile.gender === "M" ? "m" : args.profile.gender === "F" ? "f" : undefined;
    const preference = args.includePassport === false ? "none" : (args.identityDocumentPreference ?? "passport");
    const out = {
        id: args.passengerId,
        type: args.type ?? "adult",
        given_name: givenName,
        family_name: familyName,
        email: args.profile.ticketDeliveryEmail ?? args.profile.contact.email,
        phone_number: args.profile.contact.phone,
    };
    if (gender)
        out.gender = gender;
    if (args.profile.dateOfBirth)
        out.born_on = args.profile.dateOfBirth;
    if (preference === "passport") {
        const passport = pickPassportForCountry(args.profile, args.preferredPassportCountry);
        if (passport) {
            out.identity_documents = [{
                    unique_identifier: passport.number,
                    expires_on: passport.expiresOn,
                    issuing_country_code: passport.countryOfIssue.toUpperCase(),
                    type: "passport",
                }];
        }
    }
    else if (preference === "known_traveler_number") {
        const ktn = pickKnownTravelerNumber(args.profile);
        if (ktn) {
            out.identity_documents = [{
                    unique_identifier: ktn,
                    expires_on: NEVER_EXPIRES,
                    issuing_country_code: (args.ktnIssuingCountry ?? args.profile.nationality ?? "US").toUpperCase(),
                    type: "known_traveler_number",
                }];
        }
    }
    else if (preference === "passenger_redress_number") {
        if (args.profile.redressNumber) {
            out.identity_documents = [{
                    unique_identifier: args.profile.redressNumber,
                    expires_on: NEVER_EXPIRES,
                    issuing_country_code: (args.redressIssuingCountry ?? args.profile.nationality ?? "US").toUpperCase(),
                    type: "passenger_redress_number",
                }];
        }
    }
    // preference === "none": skip identity_documents entirely.
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
export function summarizeOffer(offer) {
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
export function summarizeOrder(order) {
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
