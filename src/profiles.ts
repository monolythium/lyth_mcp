import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;

export interface ProfileEncryptedPayload {
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  params: { n: number; r: number; p: number; keyLen: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

// -----------------------------------------------------------------------------
// Plaintext profile shape (this is what reveal returns; never persisted as-is).
// -----------------------------------------------------------------------------

export interface ProfilePassport {
  number: string;
  countryOfIssue: string;       // ISO 3166-1 alpha-2 or alpha-3
  expiresOn: string;            // YYYY-MM-DD
  issuedOn?: string;
  fullNameOnPassport?: string;  // if different from legal name
}

export interface ProfileFrequentFlyer {
  airline: string;              // e.g. "AC", "United"
  number: string;
}

export interface ProfileMailingAddress {
  street: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
}

export interface ProfileEmergencyContact {
  name: string;
  phone: string;
  relationship?: string;
  email?: string;
}

export interface ProfilePlaintext {
  legalFirstName: string;
  legalMiddleName?: string;
  legalLastName: string;
  preferredName?: string;
  dateOfBirth?: string;          // YYYY-MM-DD
  nationality?: string;          // ISO country code
  gender?: "M" | "F" | "X" | string;
  passports?: ProfilePassport[];
  knownTravelerNumbers?: {
    tsaPrecheck?: string;
    globalEntry?: string;
    nexus?: string;
    other?: Record<string, string>;
  };
  frequentFlyerNumbers?: ProfileFrequentFlyer[];
  contact: {
    email: string;
    phone: string;
    alternateEmail?: string;
  };
  ticketDeliveryEmail?: string;  // where booking confirmations go; falls back to contact.email
  mailingAddress?: ProfileMailingAddress;
  emergencyContact?: ProfileEmergencyContact;
  dietaryPreferences?: string;
  accessibilityNeeds?: string;
  notes?: string;
}

// -----------------------------------------------------------------------------
// Persisted shape.
// -----------------------------------------------------------------------------

export interface ProfileRecord {
  id: string;                    // slug, e.g. "nayiem"
  displayName: string;           // shown without revealing PII
  keyProtection: "passphrase" | "local_machine_key";
  encryptedProfile: ProfileEncryptedPayload;
  // A small redacted preview so list/get can be useful without reveal.
  // These mirror the encrypted record but only contain non-secret or
  // safe-to-display values + last-4 / masked variants.
  redacted: ProfileRedacted;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileRedacted {
  legalName: string;             // "Nayiem W•••"
  preferredName?: string;
  nationality?: string;
  dateOfBirth?: string;          // YYYY-••-•• (year only)
  contact: {
    email: string;               // n•••@example.com
    phone: string;               // +1•••••5555
    hasAlternateEmail: boolean;
  };
  ticketDeliveryEmail?: string;  // also masked
  passports?: Array<{
    countryOfIssue: string;
    expiresOn: string;
    last4: string;
  }>;
  frequentFlyerCount: number;
  hasMailingAddress: boolean;
  hasEmergencyContact: boolean;
  hasKnownTraveler: boolean;
}

export interface ProfileStore {
  schemaVersion: 1;
  profiles: ProfileRecord[];
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  keyProtection: ProfileRecord["keyProtection"];
  createdAt: string;
  updatedAt: string;
  redacted: ProfileRedacted;
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

export function profileStorePath(): string {
  return process.env.LYTH_MCP_PROFILE_STORE || join(homedir(), ".lyth_mcp", "profiles.json");
}

export function profileLocalKeyPath(): string {
  return process.env.LYTH_MCP_PROFILE_KEY || join(homedir(), ".lyth_mcp", "profiles.key");
}

// -----------------------------------------------------------------------------
// Read / write
// -----------------------------------------------------------------------------

export async function readProfileStore(path = profileStorePath()): Promise<ProfileStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ProfileStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.profiles)) {
      throw new Error(`unsupported profile store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, profiles: [] };
    }
    throw err;
  }
}

export async function writeProfileStore(store: ProfileStore, path = profileStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function profileStoreInfo(path = profileStorePath()) {
  const store = await readProfileStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
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

export async function createProfile(args: {
  id: string;
  displayName: string;
  profile: ProfilePlaintext;
  passphrase?: string;
  allowLocalKey?: boolean;
  overwrite?: boolean;
}): Promise<ProfileSummary> {
  validateProfile(args.profile);
  const key = await resolveNewKey(args.passphrase, args.allowLocalKey === true);
  const store = await readProfileStore();
  const existing = store.profiles.find((p) => p.id === args.id);
  if (existing && !args.overwrite) {
    throw new Error(`profile '${args.id}' already exists`);
  }
  const now = new Date().toISOString();
  const record: ProfileRecord = {
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

export async function updateProfile(args: {
  id: string;
  displayName?: string;
  patch: Partial<ProfilePlaintext>;
  passphrase?: string;
}): Promise<ProfileSummary> {
  const store = await readProfileStore();
  const idx = store.profiles.findIndex((p) => p.id === args.id);
  if (idx < 0) throw new Error(`profile '${args.id}' not found`);
  const record = store.profiles[idx]!;
  const secret = await resolveKey(record, args.passphrase);
  const current = JSON.parse(decryptSecret(record.encryptedProfile, secret)) as ProfilePlaintext;
  const merged: ProfilePlaintext = mergeProfile(current, args.patch);
  validateProfile(merged);
  record.displayName = args.displayName ?? record.displayName;
  record.encryptedProfile = encryptSecret(JSON.stringify(merged), secret);
  record.redacted = redactProfile(merged);
  record.updatedAt = new Date().toISOString();
  store.profiles[idx] = record;
  await writeProfileStore(store);
  return summarizeProfile(record);
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  return (await readProfileStore()).profiles.map(summarizeProfile);
}

export async function getProfile(id: string): Promise<ProfileSummary> {
  const record = (await readProfileStore()).profiles.find((p) => p.id === id);
  if (!record) throw new Error(`profile '${id}' not found`);
  return summarizeProfile(record);
}

export async function revealProfile(id: string, passphrase?: string): Promise<ProfilePlaintext> {
  const record = (await readProfileStore()).profiles.find((p) => p.id === id);
  if (!record) throw new Error(`profile '${id}' not found`);
  const secret = await resolveKey(record, passphrase);
  return JSON.parse(decryptSecret(record.encryptedProfile, secret)) as ProfilePlaintext;
}

export async function deleteProfile(id: string, confirmId: string): Promise<{ deleted: boolean; storePath: string }> {
  if (id !== confirmId) throw new Error("confirmId must exactly match id");
  const store = await readProfileStore();
  const next = store.profiles.filter((p) => p.id !== id);
  if (next.length === store.profiles.length) {
    throw new Error(`profile '${id}' not found`);
  }
  await writeProfileStore({ schemaVersion: STORE_VERSION, profiles: next });
  return { deleted: true, storePath: profileStorePath() };
}

// -----------------------------------------------------------------------------
// Vendor integration helpers
// -----------------------------------------------------------------------------

export interface TravelerCustomerFields {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export function customerFieldsFromProfile(profile: ProfilePlaintext): TravelerCustomerFields {
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

function validateProfile(p: ProfilePlaintext): void {
  if (!p.legalFirstName?.trim()) throw new Error("legalFirstName is required");
  if (!p.legalLastName?.trim()) throw new Error("legalLastName is required");
  if (!p.contact?.email) throw new Error("contact.email is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.contact.email)) {
    throw new Error(`invalid contact.email: ${p.contact.email}`);
  }
  if (p.ticketDeliveryEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.ticketDeliveryEmail)) {
    throw new Error(`invalid ticketDeliveryEmail: ${p.ticketDeliveryEmail}`);
  }
  if (p.contact.alternateEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.contact.alternateEmail)) {
    throw new Error(`invalid contact.alternateEmail: ${p.contact.alternateEmail}`);
  }
  if (!p.contact.phone?.trim()) throw new Error("contact.phone is required");
  if (p.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth)) {
    throw new Error(`dateOfBirth must be YYYY-MM-DD: ${p.dateOfBirth}`);
  }
  for (const passport of p.passports ?? []) {
    if (!passport.number?.trim()) throw new Error("passport.number is required");
    if (!passport.countryOfIssue?.trim()) throw new Error("passport.countryOfIssue is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(passport.expiresOn)) {
      throw new Error(`passport.expiresOn must be YYYY-MM-DD: ${passport.expiresOn}`);
    }
  }
}

function mergeProfile(current: ProfilePlaintext, patch: Partial<ProfilePlaintext>): ProfilePlaintext {
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

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "•••";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "•".repeat(digits.length);
  const last4 = digits.slice(-4);
  return `${phone.replace(/\d/g, "•").slice(0, phone.length - last4.length)}${last4}`;
}

function maskPassport(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return trimmed.slice(-4);
}

function maskLastName(last: string): string {
  if (last.length <= 2) return last;
  return `${last.slice(0, 1)}${"•".repeat(last.length - 1)}`;
}

function maskDob(dob?: string): string | undefined {
  if (!dob) return undefined;
  const year = dob.slice(0, 4);
  return `${year}-••-••`;
}

export function redactProfile(p: ProfilePlaintext): ProfileRedacted {
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

function summarizeProfile(record: ProfileRecord): ProfileSummary {
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

function encryptSecret(secret: string, passphrase: string): ProfileEncryptedPayload {
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

function decryptSecret(payload: ProfileEncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(passphrase, salt, payload.params);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function deriveKey(passphrase: string, salt: Uint8Array, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }): Buffer {
  return scryptSync(passphrase, salt, params.keyLen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
}

async function resolveNewKey(
  passphrase: string | undefined,
  allowLocalKey: boolean,
): Promise<{ protection: "passphrase" | "local_machine_key"; secret: string }> {
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

async function resolveKey(record: ProfileRecord, passphrase?: string): Promise<string> {
  if (record.keyProtection === "local_machine_key") {
    return readOrCreateLocalKey();
  }
  const resolved = passphrase ?? process.env.LYTH_MCP_PROFILE_PASSPHRASE ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
  if (!resolved) throw new Error("profile passphrase missing; pass it explicitly or set LYTH_MCP_PROFILE_PASSPHRASE");
  if (resolved.length < 12) throw new Error("profile passphrase must be at least 12 characters");
  return resolved;
}

async function readOrCreateLocalKey(): Promise<string> {
  const path = profileLocalKeyPath();
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}
