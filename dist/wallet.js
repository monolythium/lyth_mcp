import { buildEncryptedSubmission, bytesToHex, generatePqm1Mnemonic, hexToBytes, pqm1MnemonicToAddress, pqm1MnemonicToMlDsa65Backend, } from "@monolythium/core-sdk/crypto";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const STORE_VERSION = 1;
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
export function walletStorePath() {
    return process.env.LYTH_MCP_WALLET_STORE || join(homedir(), ".lyth_mcp", "wallets.json");
}
export function hotKeyPath() {
    return process.env.LYTH_MCP_HOT_KEY || join(homedir(), ".lyth_mcp", "hot.key");
}
export function localKeyPath() {
    return process.env.LYTH_MCP_LOCAL_KEY || join(homedir(), ".lyth_mcp", "local.key");
}
export function resolvePassphrase(passphrase) {
    const resolved = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
    if (!resolved) {
        throw new Error("wallet passphrase missing; pass it explicitly or set LYTH_MCP_WALLET_PASSPHRASE");
    }
    if (resolved.length < 12) {
        throw new Error("wallet passphrase must be at least 12 characters");
    }
    return resolved;
}
export async function readWalletStore(path = walletStorePath()) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.wallets)) {
            throw new Error(`unsupported wallet store shape at ${path}`);
        }
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { schemaVersion: STORE_VERSION, wallets: [] };
        }
        throw err;
    }
}
export async function writeWalletStore(store, path = walletStorePath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
}
export async function walletStoreInfo(path = walletStorePath()) {
    const store = await readWalletStore(path);
    let mode = null;
    try {
        mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
    }
    catch {
        mode = null;
    }
    return {
        path,
        walletCount: store.wallets.length,
        wallets: store.wallets.map(summarizeWallet),
        hotKeyPath: hotKeyPath(),
        localKeyPath: localKeyPath(),
        fileMode: mode,
    };
}
export async function createWallet(args) {
    const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
    const store = await readWalletStore();
    const existing = store.wallets.find((w) => w.name === args.name);
    if (existing && !args.overwrite) {
        throw new Error(`wallet '${args.name}' already exists`);
    }
    const mnemonic = generatePqm1Mnemonic();
    const backend = pqm1MnemonicToMlDsa65Backend(mnemonic);
    const record = {
        name: args.name,
        address: backend.getAddress(),
        publicKey: bytesToHex(backend.publicKey()),
        algorithm: "PQM1-MLDSA65",
        keyProtection: key.protection,
        createdAt: new Date().toISOString(),
        encryptedMnemonic: encryptSecret(mnemonic, key.secret),
    };
    if (args.lowValue?.enabled) {
        record.lowValue = await createLowValuePolicy(mnemonic, args.lowValue.maxAmount, args.lowValue.dailyLimit);
    }
    const next = existing
        ? store.wallets.map((w) => (w.name === args.name ? record : w))
        : [...store.wallets, record];
    await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
    return {
        ...summarizeWallet(record),
        mnemonic: args.revealMnemonic ? mnemonic : undefined,
        storePath: walletStorePath(),
    };
}
export async function importWallet(args) {
    const key = await resolveNewWalletKey(args.passphrase, args.allowLocalKey === true);
    const address = pqm1MnemonicToAddress(args.mnemonic);
    const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
    const store = await readWalletStore();
    const existing = store.wallets.find((w) => w.name === args.name);
    if (existing && !args.overwrite) {
        throw new Error(`wallet '${args.name}' already exists`);
    }
    const record = {
        name: args.name,
        address,
        publicKey: bytesToHex(backend.publicKey()),
        algorithm: "PQM1-MLDSA65",
        keyProtection: key.protection,
        createdAt: new Date().toISOString(),
        encryptedMnemonic: encryptSecret(args.mnemonic, key.secret),
    };
    if (args.lowValue?.enabled) {
        record.lowValue = await createLowValuePolicy(args.mnemonic, args.lowValue.maxAmount, args.lowValue.dailyLimit);
    }
    const next = existing
        ? store.wallets.map((w) => (w.name === args.name ? record : w))
        : [...store.wallets, record];
    await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
    return { ...summarizeWallet(record), storePath: walletStorePath() };
}
export async function listWallets() {
    return (await readWalletStore()).wallets.map(summarizeWallet);
}
export async function getWallet(name) {
    const record = (await readWalletStore()).wallets.find((w) => w.name === name);
    if (!record) {
        throw new Error(`wallet '${name}' not found`);
    }
    return record;
}
export async function exportMnemonic(name, passphrase) {
    const record = await getWallet(name);
    return decryptSecret(record.encryptedMnemonic, await resolveWalletKey(record, passphrase));
}
export async function configureLowValuePolicy(args) {
    const store = await readWalletStore();
    const index = store.wallets.findIndex((w) => w.name === args.name);
    if (index < 0) {
        throw new Error(`wallet '${args.name}' not found`);
    }
    const record = store.wallets[index];
    if (!args.enabled) {
        delete record.lowValue;
        await writeWalletStore(store);
        return summarizeWallet(record);
    }
    if (!args.maxAmount) {
        throw new Error("maxAmount is required when enabling low-value mode");
    }
    const mnemonic = decryptSecret(record.encryptedMnemonic, await resolveWalletKey(record, args.passphrase));
    record.lowValue = await createLowValuePolicy(mnemonic, args.maxAmount, args.dailyLimit);
    await writeWalletStore(store);
    return summarizeWallet(record);
}
export async function deleteWallet(name, confirmName) {
    if (name !== confirmName) {
        throw new Error("confirmName must exactly match name");
    }
    const store = await readWalletStore();
    const next = store.wallets.filter((w) => w.name !== name);
    if (next.length === store.wallets.length) {
        throw new Error(`wallet '${name}' not found`);
    }
    await writeWalletStore({ schemaVersion: STORE_VERSION, wallets: next });
    return { deleted: true, storePath: walletStorePath() };
}
export async function removeWalletStoreForTestsOnly(path) {
    await unlink(path);
}
export async function unlockBackend(name, passphrase) {
    const mnemonic = await exportMnemonic(name, passphrase);
    return pqm1MnemonicToMlDsa65Backend(mnemonic);
}
export async function buildTransfer(args) {
    const record = await getWallet(args.walletName);
    const tx = {
        chainId: BigInt(args.chainId),
        nonce: args.nonce,
        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
        maxFeePerGas: args.maxFeePerGas,
        gasLimit: args.gasLimit,
        to: args.to,
        value: args.amountUnits,
        input: args.input ?? "0x",
    };
    const built = {
        wallet: summarizeWallet(record),
        tx,
        walletRequest: {
            method: "eth_sendTransaction",
            params: [
                {
                    from: record.address,
                    to: args.to,
                    value: toQuantity(args.amountUnits),
                    data: args.input ?? "0x",
                    gas: toQuantity(args.gasLimit),
                    nonce: toQuantity(args.nonce),
                    chainId: toQuantity(BigInt(args.chainId)),
                    maxFeePerGas: toQuantity(args.maxFeePerGas),
                    maxPriorityFeePerGas: toQuantity(args.maxPriorityFeePerGas),
                },
            ],
        },
    };
    const signer = args.sign === false
        ? null
        : await resolveSigningBackend({
            walletName: args.walletName,
            amountUnits: args.amountUnits,
            passphrase: args.passphrase,
            allowLowValueSigning: args.allowLowValueSigning ?? true,
        });
    if (signer !== null) {
        if (!args.encryptionKey) {
            throw new Error("encryptionKey is required when signing an encrypted transaction");
        }
        const backend = signer.backend;
        const signed = backend.signEvmTx(tx);
        const encrypted = await buildEncryptedSubmission({
            backend,
            tx,
            encryptionKey: args.encryptionKey,
        });
        built.signed = {
            mode: signer.mode,
            signedInnerTxHex: `0x${signed.wireHex}`,
            innerSighashHex: encrypted.innerSighashHex,
            innerWireBytes: encrypted.innerWireBytes,
            encryptedEnvelopeHex: encrypted.envelopeWireHex,
        };
        if (signer.mode === "low_value") {
            const updated = await recordLowValueSpend(args.walletName, args.amountUnits);
            built.lowValuePolicy = {
                used: true,
                remainingToday: updated.remainingToday,
                warning: "Low-value mode signs without prompting for the passphrase. Keep only capped funds in this agent wallet.",
            };
        }
    }
    return built;
}
export function summarizeWallet(record) {
    return {
        name: record.name,
        address: record.address,
        publicKey: record.publicKey,
        algorithm: record.algorithm,
        keyProtection: walletKeyProtection(record),
        createdAt: record.createdAt,
        lowValue: record.lowValue
            ? {
                enabled: record.lowValue.enabled,
                asset: record.lowValue.asset,
                maxAmount: record.lowValue.maxAmount,
                dailyLimit: record.lowValue.dailyLimit,
                day: record.lowValue.day,
                spentToday: record.lowValue.spentToday,
                configuredAt: record.lowValue.configuredAt,
            }
            : undefined,
    };
}
export function toQuantity(value) {
    return `0x${value.toString(16)}`;
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
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString("utf8");
}
function deriveKey(passphrase, salt, params = { n: KDF_N, r: KDF_R, p: KDF_P, keyLen: KEY_LEN }) {
    return scryptSync(passphrase, salt, params.keyLen, {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: 64 * 1024 * 1024,
    });
}
export function encryptionKeyFromRpc(result) {
    return {
        algo: result.algo ?? "ml-kem-768",
        epoch: typeof result.epoch === "string" ? BigInt(result.epoch) : BigInt(result.epoch),
        encapsulationKey: hexToBytes(result.encapsulationKey, "encapsulationKey"),
    };
}
async function createLowValuePolicy(mnemonic, maxAmount, dailyLimit) {
    decimalToUnits(maxAmount);
    if (dailyLimit !== undefined) {
        decimalToUnits(dailyLimit);
    }
    return {
        enabled: true,
        asset: "LYTH",
        maxAmount,
        dailyLimit,
        day: todayKey(),
        spentToday: "0",
        configuredAt: new Date().toISOString(),
        encryptedMnemonic: encryptSecret(mnemonic, await readOrCreateKey(hotKeyPath())),
    };
}
async function resolveSigningBackend(args) {
    const record = await getWallet(args.walletName);
    if (walletKeyProtection(record) === "passphrase" && (args.passphrase !== undefined || process.env.LYTH_MCP_WALLET_PASSPHRASE)) {
        return {
            mode: "passphrase",
            backend: await unlockBackend(args.walletName, args.passphrase),
        };
    }
    if (!args.allowLowValueSigning) {
        return null;
    }
    const policy = record.lowValue;
    if (!policy?.enabled) {
        return null;
    }
    assertLowValueAllowed(policy, args.amountUnits);
    const mnemonic = decryptSecret(policy.encryptedMnemonic, await readOrCreateKey(hotKeyPath()));
    return {
        mode: "low_value",
        backend: pqm1MnemonicToMlDsa65Backend(mnemonic),
    };
}
function assertLowValueAllowed(policy, amountUnits) {
    const max = decimalToUnits(policy.maxAmount);
    if (amountUnits > max) {
        throw new Error(`amount exceeds low-value maxAmount ${policy.maxAmount} LYTH; passphrase required`);
    }
    if (policy.dailyLimit) {
        const today = todayKey();
        const spent = policy.day === today ? decimalToUnits(policy.spentToday ?? "0") : 0n;
        const daily = decimalToUnits(policy.dailyLimit);
        if (spent + amountUnits > daily) {
            throw new Error(`amount exceeds low-value dailyLimit ${policy.dailyLimit} LYTH; passphrase required`);
        }
    }
}
async function recordLowValueSpend(walletName, amountUnits) {
    const store = await readWalletStore();
    const record = store.wallets.find((w) => w.name === walletName);
    if (!record?.lowValue) {
        return {};
    }
    const today = todayKey();
    const current = record.lowValue.day === today ? decimalToUnits(record.lowValue.spentToday ?? "0") : 0n;
    const next = current + amountUnits;
    record.lowValue.day = today;
    record.lowValue.spentToday = unitsToDecimal(next);
    await writeWalletStore(store);
    if (!record.lowValue.dailyLimit) {
        return {};
    }
    const remaining = decimalToUnits(record.lowValue.dailyLimit) - next;
    return { remainingToday: unitsToDecimal(remaining < 0n ? 0n : remaining) };
}
function walletKeyProtection(record) {
    return record.keyProtection ?? "passphrase";
}
async function resolveNewWalletKey(passphrase, allowLocalKey) {
    const configured = passphrase ?? process.env.LYTH_MCP_WALLET_PASSPHRASE;
    if (configured) {
        return { protection: "passphrase", secret: resolvePassphrase(passphrase) };
    }
    if (allowLocalKey) {
        return { protection: "local_machine_key", secret: await readOrCreateKey(localKeyPath()) };
    }
    throw new Error("wallet passphrase missing; pass it explicitly, set LYTH_MCP_WALLET_PASSPHRASE, or use low-value local-key setup");
}
async function resolveWalletKey(record, passphrase) {
    if (walletKeyProtection(record) === "local_machine_key") {
        return readOrCreateKey(localKeyPath());
    }
    return resolvePassphrase(passphrase);
}
async function readOrCreateKey(path) {
    try {
        return (await readFile(path, "utf8")).trim();
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
    const key = randomBytes(32).toString("hex");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return key;
}
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}
function decimalToUnits(input, decimals = 18) {
    const trimmed = input.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(`invalid decimal amount: ${input}`);
    }
    const [whole, frac = ""] = trimmed.split(".");
    if (frac.length > decimals) {
        throw new Error(`too many decimal places for ${decimals}-decimal asset`);
    }
    return BigInt(whole + frac.padEnd(decimals, "0"));
}
function unitsToDecimal(value, decimals = 18) {
    const sign = value < 0n ? "-" : "";
    const raw = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = raw.slice(0, -decimals);
    const frac = raw.slice(-decimals).replace(/0+$/, "");
    return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
