export interface ProfileEncryptedPayload {
    cipher: "aes-256-gcm";
    kdf: "scrypt";
    params: {
        n: number;
        r: number;
        p: number;
        keyLen: number;
    };
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
}
export interface ProfilePassport {
    number: string;
    countryOfIssue: string;
    expiresOn: string;
    issuedOn?: string;
    fullNameOnPassport?: string;
}
export interface ProfileFrequentFlyer {
    airline: string;
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
    dateOfBirth?: string;
    nationality?: string;
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
    ticketDeliveryEmail?: string;
    mailingAddress?: ProfileMailingAddress;
    emergencyContact?: ProfileEmergencyContact;
    dietaryPreferences?: string;
    accessibilityNeeds?: string;
    notes?: string;
}
export interface ProfileRecord {
    id: string;
    displayName: string;
    keyProtection: "passphrase" | "local_machine_key";
    encryptedProfile: ProfileEncryptedPayload;
    redacted: ProfileRedacted;
    createdAt: string;
    updatedAt: string;
}
export interface ProfileRedacted {
    legalName: string;
    preferredName?: string;
    nationality?: string;
    dateOfBirth?: string;
    contact: {
        email: string;
        phone: string;
        hasAlternateEmail: boolean;
    };
    ticketDeliveryEmail?: string;
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
export declare function profileStorePath(): string;
export declare function profileLocalKeyPath(): string;
export declare function readProfileStore(path?: string): Promise<ProfileStore>;
export declare function writeProfileStore(store: ProfileStore, path?: string): Promise<void>;
export declare function profileStoreInfo(path?: string): Promise<{
    path: string;
    profileCount: number;
    profiles: ProfileSummary[];
    localKeyPath: string;
    fileMode: string | null;
}>;
export declare function createProfile(args: {
    id: string;
    displayName: string;
    profile: ProfilePlaintext;
    passphrase?: string;
    allowLocalKey?: boolean;
    overwrite?: boolean;
}): Promise<ProfileSummary>;
export declare function updateProfile(args: {
    id: string;
    displayName?: string;
    patch: Partial<ProfilePlaintext>;
    passphrase?: string;
}): Promise<ProfileSummary>;
export declare function listProfiles(): Promise<ProfileSummary[]>;
export declare function getProfile(id: string): Promise<ProfileSummary>;
export declare function revealProfile(id: string, passphrase?: string): Promise<ProfilePlaintext>;
export declare function deleteProfile(id: string, confirmId: string): Promise<{
    deleted: boolean;
    storePath: string;
}>;
export interface TravelerCustomerFields {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
}
export declare function customerFieldsFromProfile(profile: ProfilePlaintext): TravelerCustomerFields;
export declare function redactProfile(p: ProfilePlaintext): ProfileRedacted;
