import type { ProfilePlaintext } from "./profiles.js";
export declare const DUFFEL_BASE_URL = "https://api.duffel.com";
export declare const DUFFEL_API_VERSION = "v2";
export interface DuffelEncryptedPayload {
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
export interface DuffelConfig {
    schemaVersion: 1;
    declaredEnvironment: "test" | "live";
    encryptedAccessToken: DuffelEncryptedPayload;
    defaultCurrency?: string;
    configuredAt: string;
    updatedAt: string;
}
export declare function duffelConfigPath(): string;
export declare function readDuffelConfig(path?: string): Promise<DuffelConfig | null>;
export declare function writeDuffelConfig(config: DuffelConfig, path?: string): Promise<void>;
export declare function configureDuffel(args: {
    declaredEnvironment: "test" | "live";
    accessToken: string;
    defaultCurrency?: string;
}): Promise<DuffelConfig>;
export declare function duffelConfigRedacted(): Promise<{
    declaredEnvironment: DuffelConfig["declaredEnvironment"];
    defaultCurrency?: string;
    accessTokenConfigured: boolean;
    configuredAt?: string;
    updatedAt?: string;
} | null>;
export type DuffelCabin = "economy" | "premium_economy" | "business" | "first";
export type DuffelPassengerType = "adult" | "child" | "infant_without_seat";
export type DuffelGender = "m" | "f";
export interface DuffelSlice {
    origin: string;
    destination: string;
    departure_date: string;
    departure_time?: {
        from: string;
        to: string;
    };
    arrival_time?: {
        from: string;
        to: string;
    };
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
    passengers: Array<DuffelSearchPassenger & {
        id: string;
    }>;
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
    owner: {
        iata_code: string;
        name: string;
    };
    slices: Array<{
        origin: {
            iata_code: string;
            name: string;
        };
        destination: {
            iata_code: string;
            name: string;
        };
        duration: string;
        segments: Array<{
            origin: {
                iata_code: string;
            };
            destination: {
                iata_code: string;
            };
            departing_at: string;
            arriving_at: string;
            marketing_carrier: {
                iata_code: string;
                name: string;
            };
            operating_carrier?: {
                iata_code: string;
                name: string;
            };
            flight_number?: string;
            aircraft?: {
                name: string;
            };
            passengers?: Array<{
                cabin_class: string;
                cabin_class_marketing_name?: string;
            }>;
        }>;
    }>;
    passengers?: Array<{
        id: string;
        type: DuffelPassengerType;
        age?: number;
    }>;
    conditions?: {
        refund_before_departure?: {
            allowed: boolean;
            penalty_amount?: string;
            penalty_currency?: string;
        };
        change_before_departure?: {
            allowed: boolean;
            penalty_amount?: string;
            penalty_currency?: string;
        };
    };
    available_services?: unknown;
}
export type DuffelIdentityDocumentType = "passport" | "tax_id" | "known_traveler_number" | "passenger_redress_number";
export interface DuffelIdentityDocument {
    unique_identifier: string;
    expires_on: string;
    issuing_country_code: string;
    type: DuffelIdentityDocumentType;
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
    identity_documents?: DuffelIdentityDocument[];
    loyalty_programme_accounts?: Array<{
        airline_iata_code: string;
        account_number: string;
    }>;
    infant_passenger_id?: string;
}
export interface DuffelOrder {
    id: string;
    booking_reference?: string;
    live_mode: boolean;
    created_at: string;
    total_amount: string;
    total_currency: string;
    payment_status?: {
        awaiting_payment?: boolean;
        payment_required_by?: string;
        price_guarantee_expires_at?: string;
    };
    passengers: Array<{
        id: string;
        given_name: string;
        family_name: string;
    }>;
    slices: Array<DuffelOffer["slices"][number]>;
    documents?: Array<{
        unique_identifier?: string;
        type?: string;
    }>;
    conditions?: DuffelOffer["conditions"];
    cancelled_at?: string;
}
export declare function duffelCreateOfferRequest(args: {
    slices: DuffelSlice[];
    passengers: DuffelSearchPassenger[];
    cabinClass?: DuffelCabin;
    maxConnections?: number;
    returnOffers?: boolean;
}): Promise<DuffelOfferRequest>;
export declare function duffelListOffers(args: {
    offerRequestId: string;
    limit?: number;
    sort?: "total_amount" | "total_duration";
}): Promise<DuffelOffer[]>;
export declare function duffelGetOffer(offerId: string, withServices?: boolean): Promise<DuffelOffer>;
export declare function duffelGetSeatMaps(offerId: string): Promise<unknown>;
export interface DuffelOrderCreate {
    type: "instant" | "hold";
    selected_offers: string[];
    passengers: DuffelOrderPassenger[];
    services?: Array<{
        id: string;
        quantity: number;
    }>;
    payments?: Array<{
        type: "balance" | "arc_bsp_cash";
        amount: string;
        currency: string;
    }>;
    metadata?: Record<string, string>;
}
export declare function duffelCreateOrder(args: DuffelOrderCreate): Promise<DuffelOrder>;
export declare function duffelGetOrder(orderId: string): Promise<DuffelOrder>;
export declare function duffelListOrders(args?: {
    limit?: number;
    awaitingPayment?: boolean;
}): Promise<DuffelOrder[]>;
export declare function duffelCancelOrder(orderId: string): Promise<unknown>;
export declare function duffelConfirmCancellation(cancellationId: string): Promise<unknown>;
export declare function duffelPayOrder(args: {
    orderId: string;
    amount: string;
    currency: string;
    type?: "balance" | "arc_bsp_cash";
}): Promise<unknown>;
export type DuffelIdentityDocumentPreference = "passport" | "known_traveler_number" | "passenger_redress_number" | "none";
export declare function duffelPassengerFromProfile(args: {
    profile: ProfilePlaintext;
    passengerId: string;
    type?: DuffelPassengerType;
    preferredPassportCountry?: string;
    /**
     * Which identity document to attach. Duffel limits the passenger to ONE
     * identity document; the airline's supported_passenger_identity_document_types
     * dictates which to send. Default: "passport".
     * - "none" omits identity_documents entirely (some domestic itineraries).
     */
    identityDocumentPreference?: DuffelIdentityDocumentPreference;
    /** Legacy alias for identityDocumentPreference === "none". Default true. */
    includePassport?: boolean;
    includeLoyalty?: boolean;
    /** Country code for KTN / redress (defaults to nationality, then 'US'). */
    ktnIssuingCountry?: string;
    redressIssuingCountry?: string;
}): DuffelOrderPassenger;
export declare function summarizeOffer(offer: DuffelOffer): {
    id: string;
    liveMode: boolean;
    total: string;
    expiresAt: string;
    owner: string;
    slices: {
        from: string;
        to: string;
        duration: string;
        segments: {
            from: string;
            to: string;
            carrier: string;
            flightNumber: string | undefined;
            departingAt: string;
            arrivingAt: string;
            cabin: string | undefined;
        }[];
    }[];
    refundable: boolean | undefined;
    changeable: boolean | undefined;
};
export declare function summarizeOrder(order: DuffelOrder): {
    id: string;
    liveMode: boolean;
    bookingReference: string | undefined;
    total: string;
    awaitingPayment: boolean | undefined;
    paymentRequiredBy: string | undefined;
    passengers: string[];
    slices: {
        from: string;
        to: string;
        duration: string;
        segments: string[];
    }[];
    cancelledAt: string | undefined;
};
