export interface AddressbookContact {
    name: string;
    address: string;
    note?: string;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
}
export interface AddressbookStore {
    schemaVersion: 1;
    contacts: AddressbookContact[];
}
export declare function addressbookPath(): string;
export declare function readAddressbook(path?: string): Promise<AddressbookStore>;
export declare function writeAddressbook(store: AddressbookStore, path?: string): Promise<void>;
export declare function addressbookInfo(path?: string): Promise<{
    path: string;
    contactCount: number;
    fileMode: string | null;
}>;
export declare function listAddressbookContacts(query?: string): Promise<AddressbookContact[]>;
export declare function resolveAddressbookContact(value: string): Promise<AddressbookContact | null>;
export declare function upsertAddressbookContact(args: {
    name: string;
    address: string;
    note?: string;
    tags?: string[];
    overwrite?: boolean;
}): Promise<{
    contact: AddressbookContact;
    created: boolean;
    path: string;
}>;
export declare function removeAddressbookContact(name: string): Promise<{
    removed: boolean;
    path: string;
}>;
