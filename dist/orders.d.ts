export type OrderStatus = "created" | "payment_prepared" | "paid" | "fulfillment_requested" | "fulfilled_demo" | "fulfilled_manual" | "cancelled";
export interface OrderEvent {
    at: string;
    type: string;
    note?: string;
    data?: unknown;
}
export interface OrderRecord {
    id: string;
    status: OrderStatus;
    network: string;
    chainId: number;
    createdAt: string;
    updatedAt: string;
    vendorId: string;
    vendorDisplayName?: string;
    vendorAddress?: string;
    itemId?: string;
    itemName?: string;
    quantity: number;
    amount: string;
    asset: string;
    registryHash: string;
    fulfillmentFields?: Record<string, unknown>;
    quote: unknown;
    payment?: {
        txHash?: string;
        runbookId?: string;
        preparedAt?: string;
    };
    fulfillment?: {
        adapter: "dry_run" | "manual" | "webhook";
        confirmation: string;
        fulfilledAt?: string;
        requestedAt?: string;
        note?: string;
        connectorId?: string;
        responseStatus?: number;
        responseHash?: string;
    };
    cancelReason?: string;
    events: OrderEvent[];
}
export interface OrderStore {
    schemaVersion: 1;
    orders: OrderRecord[];
}
export declare function orderStorePath(): string;
export declare function readOrderStore(path?: string): Promise<OrderStore>;
export declare function writeOrderStore(store: OrderStore, path?: string): Promise<void>;
export declare function orderStoreInfo(path?: string): Promise<{
    path: string;
    orderCount: number;
    fileMode: string | null;
}>;
export declare function createOrder(args: Omit<OrderRecord, "id" | "status" | "createdAt" | "updatedAt" | "events">): Promise<OrderRecord>;
export declare function listOrders(args?: {
    status?: OrderStatus;
    vendorId?: string;
    limit?: number;
}): Promise<OrderRecord[]>;
export declare function getOrder(id: string): Promise<OrderRecord>;
export declare function updateOrder(id: string, patch: Partial<Omit<OrderRecord, "id" | "createdAt" | "events">>, event: Omit<OrderEvent, "at">): Promise<OrderRecord>;
