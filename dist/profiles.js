import { createCipheriv, createDecipheriv, randomBytes, scryptSync, } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------
export function profileStorePath() {
    return process.env.LYTH_MCP_PROFILE_STORE || join(homedir(), ".lyth_mcp", "profiles.json");
}
export function profileLocalKeyPath() {
    return process.env.LYTH_MCP_PROFILE_KEY || join(homedir(), ".lyth_mcp", "profiles.key");
}
// -----------------------------------------------------------------------------
// Read / write
// -----------------------------------------------------------------------------
export async function readProfileStore(path = profileStorePath()) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.profiles)) {
            throw new Error(`unsupported profile store shape at ${path}`);
        }
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { schemaVersion: STORE_VERSION, profiles: [] };
        }
        throw err;
    }
}
export async function writeProfileStore(store, path = profileStorePath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
}
export async function profileStoreInfo(path = profileStorePath()) {
    const store = await readProfileStore(path);
    let mode = null;
    try {
        mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
    }
    catch {
        mode = null;
    }
    return {
        path,
        profileCount: store.profiles.length,
        profiles: store.profiles.map(summarizeProfile),
        localKeyPath: profileLocalKeyPath(),
        fileMode: mode,
    };
}
// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------
export async function createProfile(args) {
    validateProfile(args.profile);
    const key = await resolveNewKey(args.passphrase, args.allowLocalKey === true);
    const store = await readProfileStore();
    const existing = store.profiles.find((p) => p.id === args.id);
    if (existing && !args.overwrite) {
        throw new Error(`profile '${args.id}' already exists`);
    }
    const now = new Date().toISOString();
    const record = {
        id: args.id,
        displayName: args.displayName,
        keyProtection: key.protection,
        encryptedProfile: encryptSecret(JSON.stringify(args.profile), key.secret),
        redacted: redactProfile(args.profile),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    const next = existing ? store.profiles.map((p) => (p.id === args.id ? record : p)) : [...store.profiles, record];
    await writeProfileStore({ schemaVersion: STORE_VERSION, profiles: next });
    return summarizeProfile(record);
}
export async function updateProfile(args) {
    const store = await readProfileStore();
    const idx = store.profiles.findIndex((p) => p.id === args.id);
    if (idx < 0)
        throw new Error(`profile '${args.id}' not found`);
    const record = store.profiles[idx];
    const secret = await resolveKey(record, args.passphrase);
    const current = JSON.parse(decryptSecret(record.encryptedProfile, secret));
    const merged = mergeProfile(current, args.patch);
    validateProfile(merged);
    record.displayName = args.displayName ?? record.displayName;
    record.encryptedProfile = encryptSecret(JSON.stringify(merged), secret);
    record.redacted = redactProfile(merged);
    record.updatedAt = new Date().toISOString();
    store.profiles[idx] = record;
    await writeProfileStore(store);
    return summarizeProfile(record);
}
export async function listProfiles() {
    return (await readProfileStore()).profiles.map(summarizeProfile);
}
export async function getProfile(id) {
    const record = (await readProfileStore()).profiles.find((p) => p.id === id);
    if (!record)
        throw new Error(`profile '${id}' not found`);
    return summarizeProfile(record);
}
export async function revealProfile(id, passphrase) {
    const record = (await readProfileStore()).profiles.find((p) => p.id === id);
    if (!record)
        throw new Error(`profile '${id}' not found`);
    const secret = await resolveKey(record, passphrase);
    return JSON.parse(decryptSecret(record.encryptedProfile, secret));
}
export async function deleteProfile(id, confirmId) {
    if (id !== confirmId)
        throw new Error("confirmId must exactly match id");
    const store = await readProfileStore();
    const next = store.profiles.filter((p) => p.id !== id);
    if (next.length === store.profiles.length) {
        throw new Error(`profile '${id}' not found`);
    }
    await writeProfileStore({ schemaVersion: STORE_VERSION, profiles: next });
    return { deleted: true, storePath: profileStorePath() };
}
export function customerFieldsFromProfile(profile) {
    return {
        firstName: profile.preferredName ?? profile.legalFirstName,
        lastName: profile.legalLastName,
        email: profile.ticketDeliveryEmail ?? profile.contact.email,
        phone: profile.contact.phone,
    };
}
// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------
function validateProfile(p) {
    if (!p.legalFirstName?.trim())
        throw new Error("legalFirstName is required");
    if (!p.legalLastName?.trim())
        throw new Error("legalLastName is required");
    if (!p.contact?.email)
        throw new Error("contact.email is required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.contact.email)) {
        throw new Error(`invalid contact.email: ${p.contact.email}`);
    }
    if (p.ticketDeliveryEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.ticketDeliveryEmail)) {
        throw new Error(`invalid ticketDeliveryEmail: ${p.ticketDeliveryEmail}`);
    }
    if (p.contact.alternateEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.contact.alternateEmail)) {
        throw new Error(`invalid contact.alternateEmail: ${p.contact.alternateEmail}`);
    }
    if (!p.contact.phone?.trim())
        throw new Error("contact.phone is required");
    if (p.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth)) {
        throw new Error(`dateOfBirth must be YYYY-MM-DD: ${p.dateOfBirth}`);
    }
    for (const passport of p.passports ?? []) {
        if (!passport.number?.trim())
            throw new Error("passport.number is required");
        if (!passport.countryOfIssue?.trim())
            throw new Error("passport.countryOfIssue is required");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(passport.expiresOn)) {
            throw new Error(`passport.expiresOn must be YYYY-MM-DD: ${passport.expiresOn}`);
        }
    }
}
function mergeProfile(current, patch) {
    return {
        ...current,
        ...patch,
        contact: { ...current.contact, ...(patch.contact ?? {}) },
        knownTravelerNumbers: patch.knownTravelerNumbers !== undefined
            ? patch.knownTravelerNumbers
            : current.knownTravelerNumbers,
        passports: patch.passports !== undefined ? patch.passports : current.passports,
        frequentFlyerNumbers: patch.frequentFlyerNumbers !== undefined
            ? patch.frequentFlyerNumbers
            : current.frequentFlyerNumbers,
        mailingAddress: patch.mailingAddress !== undefined ? patch.mailingAddress : current.mailingAddress,
        emergencyContact: patch.emergencyContact !== undefined ? patch.emergencyContact : current.emergencyContact,
    };
}
// -----------------------------------------------------------------------------
// Redaction (safe for list/get without reveal)
// -----------------------------------------------------------------------------
function maskEmail(email) {
    const [local, domain] = email.split("@");
    if (!local || !domain)
        return "•••";
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${"•".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}
function maskPhone(phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length <= 4)
        return "•".repeat(digits.length);
    const last4 = digits.slice(-4);
    return `${phone.replace(/\d/g, "•").slice(0, phone.length - last4.length)}${last4}`;
}
function maskPassport(number) {
    const trimmed = number.trim();
    if (trimmed.length <= 4)
        return "•".repeat(trimmed.length);
    return trimmed.slice(-4);
}
function maskLastName(last) {
    if (last.length <= 2)
        return last;
    return `${last.slice(0, 1)}${"•".repeat(last.length - 1)}`;
}
function maskDob(dob) {
    if (!dob)
        return undefined;
    const year = dob.slice(0, 4);
    return `${year}-••-••`;
}
export function redactProfile(p) {
    return {
        legalName: `${p.legalFirstName} ${maskLastName(p.legalLastName)}`,
        preferredName: p.preferredName,
        nationality: p.nationality,
        dateOfBirth: maskDob(p.dateOfBirth),
        contact: {
            email: maskEmail(p.contact.email),
            phone: maskPhone(p.contact.phone),
            hasAlternateEmail: !!p.contact.alternateEmail,
        },
        ticketDeliveryEmail: p.ticketDeliveryEmail ? maskEmail(p.ticketDeliveryEmail) : undefined,
        passports: p.passports?.map((pp) => ({
            countryOfIssue: pp.countryOfIssue,
            expiresOn: pp.expiresOn,
            last4: maskPassport(pp.number),
        })),
        frequentFlyerCount: p.frequentFlyerNumbers?.length ?? 0,
        hasMailingAddress: !!p.mailingAddress,
        hasEmergencyContact: !!p.emergencyContact,
        hasKnownTraveler: !!p.knownTravelerNumbers,
    };
}
function summarizeProfile(record) {
    return {
        id: record.id,
        displayName: record.displayName,
        keyProtection: record.keyProtection,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        redacted: record.redacted,
    };
}
// -----------------------------------------------------------------------------
// Crypto helpers (mirrors wallet pattern)
// -----------------------------------------------------------------------------
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
function deriveKey(passphrase, salt, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }) {
    return scryptSync(passphrase, salt, params.keyLen, {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: 64 * 1024 * 1024,
    });
}
async function resolveNewKey(passphrase, allowLocalKey) {
    const configured = passphrase ?? process.env.LYTH_MCP_PROFILE_PASSPHRASE ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
    if (configured) {
        if (configured.length < 12) {
            throw new Error("profile passphrase must be at least 12 characters");
        }
        return { protection: "passphrase", secret: configured };
    }
    if (allowLocalKey) {
        return { protection: "local_machine_key", secret: await readOrCreateLocalKey() };
    }
    throw new Error("profile passphrase missing; pass it explicitly, set LYTH_MCP_PROFILE_PASSPHRASE, or set allowLocalKey for low-sensitivity setup");
}
async function resolveKey(record, passphrase) {
    if (record.keyProtection === "local_machine_key") {
        return readOrCreateLocalKey();
    }
    const resolved = passphrase ?? process.env.LYTH_MCP_PROFILE_PASSPHRASE ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
    if (!resolved)
        throw new Error("profile passphrase missing; pass it explicitly or set LYTH_MCP_PROFILE_PASSPHRASE");
    if (resolved.length < 12)
        throw new Error("profile passphrase must be at least 12 characters");
    return resolved;
}
async function readOrCreateLocalKey() {
    const path = profileLocalKeyPath();
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
    await chmod(path, 0o600);
    return key;
}
