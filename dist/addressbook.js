import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const STORE_VERSION = 1;
export function addressbookPath() {
    return process.env.LYTH_MCP_ADDRESSBOOK || join(homedir(), ".lyth_mcp", "addressbook.json");
}
export async function readAddressbook(path = addressbookPath()) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.contacts)) {
            throw new Error(`unsupported addressbook shape at ${path}`);
        }
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { schemaVersion: STORE_VERSION, contacts: [] };
        }
        throw err;
    }
}
export async function writeAddressbook(store, path = addressbookPath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
}
export async function addressbookInfo(path = addressbookPath()) {
    const store = await readAddressbook(path);
    let mode = null;
    try {
        mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
    }
    catch {
        mode = null;
    }
    return {
        path,
        contactCount: store.contacts.length,
        fileMode: mode,
    };
}
export async function listAddressbookContacts(query) {
    const contacts = (await readAddressbook()).contacts;
    const q = query?.trim().toLowerCase();
    if (!q) {
        return contacts;
    }
    return contacts.filter((contact) => {
        const haystack = [
            contact.name,
            contact.address,
            contact.note ?? "",
            ...(contact.tags ?? []),
        ].join(" ").toLowerCase();
        return haystack.includes(q);
    });
}
export async function resolveAddressbookContact(value) {
    const needle = value.trim().toLowerCase();
    if (!needle) {
        return null;
    }
    const contacts = (await readAddressbook()).contacts;
    return contacts.find((contact) => (contact.name.toLowerCase() === needle || contact.address.toLowerCase() === needle)) ?? null;
}
export async function upsertAddressbookContact(args) {
    const name = args.name.trim();
    if (!name) {
        throw new Error("contact name is required");
    }
    const store = await readAddressbook();
    const index = store.contacts.findIndex((contact) => contact.name.toLowerCase() === name.toLowerCase());
    if (index >= 0 && args.overwrite === false) {
        throw new Error(`contact '${name}' already exists`);
    }
    const now = new Date().toISOString();
    const contact = {
        name,
        address: args.address,
        note: args.note,
        tags: args.tags,
        createdAt: index >= 0 ? store.contacts[index].createdAt : now,
        updatedAt: now,
    };
    if (index >= 0) {
        store.contacts[index] = contact;
    }
    else {
        store.contacts.push(contact);
    }
    store.contacts.sort((a, b) => a.name.localeCompare(b.name));
    await writeAddressbook(store);
    return { contact, created: index < 0, path: addressbookPath() };
}
export async function removeAddressbookContact(name) {
    const store = await readAddressbook();
    const next = store.contacts.filter((contact) => contact.name.toLowerCase() !== name.trim().toLowerCase());
    if (next.length === store.contacts.length) {
        throw new Error(`contact '${name}' not found`);
    }
    await writeAddressbook({ schemaVersion: STORE_VERSION, contacts: next });
    return { removed: true, path: addressbookPath() };
}
