import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;

export type BookingStatus =
  | "requested"
  | "provider_requested"
  | "accepted_demo"
  | "escrow_prepared"
  | "paid"
  | "completed_demo"
  | "cancelled"
  | "disputed_demo";

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
  assetPolicy?: unknown;
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

export function bookingStorePath(): string {
  return process.env.LYTH_MCP_BOOKING_STORE || join(homedir(), ".lyth_mcp", "bookings.json");
}

export async function readBookingStore(path = bookingStorePath()): Promise<BookingStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as BookingStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.bookings)) {
      throw new Error(`unsupported booking store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, bookings: [] };
    }
    throw err;
  }
}

export async function writeBookingStore(store: BookingStore, path = bookingStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function bookingStoreInfo(path = bookingStorePath()) {
  const store = await readBookingStore(path);
  let mode: string | null = null;
  try {
    mode = `0${(await stat(path)).mode.toString(8).slice(-3)}`;
  } catch {
    mode = null;
  }
  return {
    path,
    bookingCount: store.bookings.length,
    fileMode: mode,
  };
}

export async function createBooking(args: Omit<BookingRecord, "id" | "status" | "createdAt" | "updatedAt" | "events">): Promise<BookingRecord> {
  const now = new Date().toISOString();
  const booking: BookingRecord = {
    ...args,
    id: `booking_${Date.now()}_${randomUUID().slice(0, 8)}`,
    status: "requested",
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, type: "requested", data: args.quote }],
  };
  const store = await readBookingStore();
  store.bookings.unshift(booking);
  await writeBookingStore(store);
  return booking;
}

export async function getBooking(id: string): Promise<BookingRecord> {
  const booking = (await readBookingStore()).bookings.find((item) => item.id === id);
  if (!booking) {
    throw new Error(`booking '${id}' not found`);
  }
  return booking;
}

export async function listBookings(args: { status?: BookingStatus; vendorId?: string; limit?: number } = {}): Promise<BookingRecord[]> {
  return (await readBookingStore()).bookings
    .filter((booking) => !args.status || booking.status === args.status)
    .filter((booking) => !args.vendorId || booking.vendorId === args.vendorId)
    .slice(0, args.limit ?? 50);
}

export async function updateBooking(id: string, patch: Partial<Omit<BookingRecord, "id" | "createdAt" | "events">>, event: Omit<BookingEvent, "at">): Promise<BookingRecord> {
  const store = await readBookingStore();
  const index = store.bookings.findIndex((booking) => booking.id === id);
  if (index < 0) {
    throw new Error(`booking '${id}' not found`);
  }
  const now = new Date().toISOString();
  const booking = store.bookings[index]!;
  const next: BookingRecord = {
    ...booking,
    ...patch,
    updatedAt: now,
    events: [{ at: now, ...event }, ...booking.events],
  };
  store.bookings[index] = next;
  await writeBookingStore(store);
  return next;
}
