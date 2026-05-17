import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;

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

export function orderStorePath(): string {
  return process.env.LYTH_MCP_ORDER_STORE || join(homedir(), ".lyth_mcp", "orders.json");
}

export async function readOrderStore(path = orderStorePath()): Promise<OrderStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as OrderStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.orders)) {
      throw new Error(`unsupported order store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, orders: [] };
    }
    throw err;
  }
}

export async function writeOrderStore(store: OrderStore, path = orderStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function orderStoreInfo(path = orderStorePath()) {
  const store = await readOrderStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
    mode = null;
  }
  return {
    path,
    orderCount: store.orders.length,
    fileMode: mode,
  };
}

export async function createOrder(args: Omit<OrderRecord, "id" | "status" | "createdAt" | "updatedAt" | "events">): Promise<OrderRecord> {
  const now = new Date().toISOString();
  const order: OrderRecord = {
    ...args,
    id: `order_${Date.now()}_${randomUUID().slice(0, 8)}`,
    status: "created",
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, type: "created", data: args.quote }],
  };
  const store = await readOrderStore();
  store.orders.unshift(order);
  await writeOrderStore(store);
  return order;
}

export async function listOrders(args: { status?: OrderStatus; vendorId?: string; limit?: number } = {}): Promise<OrderRecord[]> {
  const orders = (await readOrderStore()).orders;
  return orders
    .filter((order) => !args.status || order.status === args.status)
    .filter((order) => !args.vendorId || order.vendorId === args.vendorId)
    .slice(0, args.limit ?? 50);
}

export async function getOrder(id: string): Promise<OrderRecord> {
  const order = (await readOrderStore()).orders.find((item) => item.id === id);
  if (!order) {
    throw new Error(`order '${id}' not found`);
  }
  return order;
}

export async function updateOrder(id: string, patch: Partial<Omit<OrderRecord, "id" | "createdAt" | "events">>, event: Omit<OrderEvent, "at">): Promise<OrderRecord> {
  const store = await readOrderStore();
  const index = store.orders.findIndex((order) => order.id === id);
  if (index < 0) {
    throw new Error(`order '${id}' not found`);
  }
  const now = new Date().toISOString();
  const order = store.orders[index]!;
  const next: OrderRecord = {
    ...order,
    ...patch,
    updatedAt: now,
    events: [{ at: now, ...event }, ...order.events],
  };
  store.orders[index] = next;
  await writeOrderStore(store);
  return next;
}
