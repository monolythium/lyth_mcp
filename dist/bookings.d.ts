export type BookingStatus = "requested" | "provider_requested" | "accepted_demo" | "escrow_prepared" | "paid" | "completed_demo" | "cancelled" | "disputed_demo";
export interface BookingEvent {
    at: string;
    type: string;
    note?: string;
    data?: unknown;
}
export interface BookingRecord {
    id: string;
    status: BookingStatus;
    network: string;
    chainId: number;
    createdAt: string;
    updatedAt: string;
    vendorId: string;
    vendorDisplayName?: string;
    vendorAddress?: string;
    service: string;
    amount: string;
    asset: string;
    registryHash: string;
    requestedWindow?: string;
    location?: string;
    bookingFields?: Record<string, unknown>;
    quote?: unknown;
    merchantRisk?: unknown;
    runbookId?: string;
    escrow?: {
        runbookId?: string;
        preparedAt?: string;
        txHash?: string;
    };
    paymentTxHash?: string;
    completion?: {
        confirmation: string;
        completedAt: string;
        deliverable?: string;
    };
    dispute?: {
        reason: string;
        openedAt: string;
    };
    cancelReason?: string;
    events: BookingEvent[];
}
export interface BookingStore {
    schemaVersion: 1;
    bookings: BookingRecord[];
}
export declare function bookingStorePath(): string;
export declare function readBookingStore(path?: string): Promise<BookingStore>;
export declare function writeBookingStore(store: BookingStore, path?: string): Promise<void>;
export declare function bookingStoreInfo(path?: string): Promise<{
    path: string;
    bookingCount: number;
    fileMode: string | null;
}>;
export declare function createBooking(args: Omit<BookingRecord, "id" | "status" | "createdAt" | "updatedAt" | "events">): Promise<BookingRecord>;
export declare function getBooking(id: string): Promise<BookingRecord>;
export declare function listBookings(args?: {
    status?: BookingStatus;
    vendorId?: string;
    limit?: number;
}): Promise<BookingRecord[]>;
export declare function updateBooking(id: string, patch: Partial<Omit<BookingRecord, "id" | "createdAt" | "events">>, event: Omit<BookingEvent, "at">): Promise<BookingRecord>;
