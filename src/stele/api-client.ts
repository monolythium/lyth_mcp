import { z } from "zod";

export const STELE_PRODUCTION_ORIGIN = "https://stele.monolythium.com";

const HASH_32 = /^0x[0-9a-f]{64}$/u;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_IPV4_OCTET = "(?:0|[1-9][0-9]{0,2})";
const PRIVATE_LAN_ORIGIN = new RegExp(
  `^http:\/\/(${CANONICAL_IPV4_OCTET}\\.${CANONICAL_IPV4_OCTET}\\.${CANONICAL_IPV4_OCTET}\\.${CANONICAL_IPV4_OCTET})(?::80)?$`,
  "u",
);
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHAIN_ADDRESS = /^[a-z][a-z0-9]{0,30}1[023456789acdefghjklmnpqrstuvwxyz]{6,90}$/u;

const nfcBoundedString = (minimum: number, maximum: number, maximumBytes: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value.normalize("NFC") === value)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes)
    .refine(hasNoControlCharacters);
const CanonicalUint256Schema = z
  .string()
  .regex(CANONICAL_UINT)
  .max(MAX_UINT256.length)
  .refine((value) => value.length < MAX_UINT256.length || value <= MAX_UINT256);

export const SteleMetaSchema = z
  .object({
    product: z.literal("stele"),
    stage: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u),
    network: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u),
    chainId: CanonicalUint256Schema,
    genesisHash: z.string().regex(HASH_32),
    walletAuthEnabled: z.boolean(),
    economicWritesEnabled: z.boolean(),
    hostedSigningEnabled: z.literal(false),
  })
  .strict();

export type SteleMeta = z.infer<typeof SteleMetaSchema>;

const StartingPriceSchema = z
  .object({
    assetId: z.string().min(1).max(128),
    atomicAmount: CanonicalUint256Schema,
    displayAmount: z.string().min(1).max(128),
    assetSymbol: z.string().min(1).max(24),
    assetVerification: z.enum(["verified", "unverified", "warning"]),
  })
  .strict();

const PublicServiceSchema = z
  .object({
    id: z.string().regex(UUID_V7),
    slug: z.string().min(3).max(80).regex(SLUG),
    title: nfcBoundedString(3, 120, 240),
    providerDisplayName: z.string().min(8).max(122).regex(CHAIN_ADDRESS),
    category: z.string().min(1).max(96).regex(IDENTIFIER),
    workflowKind: z.enum([
      "order",
      "appointment",
      "project",
      "reservation",
      "automated_agent",
    ]),
    startingPrice: StartingPriceSchema.optional(),
  })
  .strict();

const ServicePageSchema = z
  .object({
    items: z.array(PublicServiceSchema).max(25),
    nextCursor: z.string().min(1).max(2_048).refine(hasNoControlCharacters).optional(),
  })
  .strict();

export const StelePublicServiceOutputSchema = PublicServiceSchema.extend({
  publicUrl: z
    .string()
    .min(1)
    .max(2_048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      const rawOrigin = value.slice(0, value.length - url.pathname.length);
      const permittedOrigin =
        rawOrigin === STELE_PRODUCTION_ORIGIN ||
        privateLanOrigin(rawOrigin) !== null;
      return (
        permittedOrigin &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        /^\/services\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(url.pathname)
      );
    }),
}).strict();

export const SteleServiceSearchPageOutputSchema = z
  .object({
    items: z.array(StelePublicServiceOutputSchema).max(25),
    nextCursor: z.string().min(1).max(2_048).refine(hasNoControlCharacters).optional(),
  })
  .strict();

export const SteleServiceSearchInputSchema = z
  .object({
    query: nfcBoundedString(1, 200, 400).optional(),
    category: z.string().min(1).max(96).regex(IDENTIFIER).optional(),
    cursor: z.string().min(1).max(2_048).refine(hasNoControlCharacters).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type SteleServiceSearchInput = z.input<typeof SteleServiceSearchInputSchema>;

export type StelePublicService = z.infer<typeof StelePublicServiceOutputSchema>;

export interface SteleServiceSearchPage {
  readonly items: readonly StelePublicService[];
  readonly nextCursor?: string;
}

export interface SteleApiReader {
  getMeta(): Promise<SteleMeta>;
  searchServices(input: SteleServiceSearchInput): Promise<SteleServiceSearchPage>;
}

export interface SteleApiClientConfig {
  readonly apiOrigin?: string;
  readonly publicOrigin?: string;
  readonly allowInsecureLan?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class SteleApiBoundaryError extends Error {
  override readonly name = "SteleApiBoundaryError";
  readonly safeCode = "stele_unavailable";

  constructor() {
    super("Stele API request failed");
  }
}

export class SteleApiConfigurationError extends Error {
  override readonly name = "SteleApiConfigurationError";

  constructor() {
    super("Stele API configuration is invalid");
  }
}

export class SteleApiClient implements SteleApiReader {
  readonly #apiOrigin: URL;
  readonly #publicOrigin: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(config: SteleApiClientConfig = {}, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    const allowInsecureLan = config.allowInsecureLan === true;
    const apiOrigin = config.apiOrigin ?? STELE_PRODUCTION_ORIGIN;
    const publicOrigin = config.publicOrigin ?? STELE_PRODUCTION_ORIGIN;
    this.#apiOrigin = exactSteleOrigin(
      apiOrigin,
      allowInsecureLan,
    );
    this.#publicOrigin = exactSteleOrigin(
      publicOrigin,
      allowInsecureLan,
    );
    const usesLanOrigin = this.#apiOrigin.origin !== STELE_PRODUCTION_ORIGIN;
    if (
      this.#apiOrigin.origin !== this.#publicOrigin.origin ||
      (usesLanOrigin && apiOrigin !== publicOrigin)
    ) {
      throw new SteleApiConfigurationError();
    }
    this.#timeoutMs = boundedInteger(config.timeoutMs ?? 3_000, 100, 10_000);
    this.#maxResponseBytes = boundedInteger(config.maxResponseBytes ?? 262_144, 1_024, 1_048_576);
    this.#fetch = fetchImpl;
  }

  async getMeta(): Promise<SteleMeta> {
    const raw = await this.#get("/api/v1/meta");
    const parsed = SteleMetaSchema.safeParse(raw);
    if (!parsed.success) throw new SteleApiBoundaryError();
    return parsed.data;
  }

  async searchServices(input: SteleServiceSearchInput): Promise<SteleServiceSearchPage> {
    const parsedInput = SteleServiceSearchInputSchema.safeParse(input);
    if (!parsedInput.success) throw new SteleApiBoundaryError();

    const url = new URL("/api/v1/services", this.#apiOrigin);
    url.searchParams.set("limit", String(parsedInput.data.limit));
    if (parsedInput.data.query !== undefined) url.searchParams.set("q", parsedInput.data.query);
    if (parsedInput.data.category !== undefined) {
      url.searchParams.set("category", parsedInput.data.category);
    }
    if (parsedInput.data.cursor !== undefined) url.searchParams.set("cursor", parsedInput.data.cursor);

    const raw = await this.#request(url);
    const parsed = ServicePageSchema.safeParse(raw);
    if (!parsed.success) throw new SteleApiBoundaryError();

    const items = parsed.data.items.map((item) => ({
      ...item,
      publicUrl: new URL(`/services/${encodeURIComponent(item.slug)}`, this.#publicOrigin).toString(),
    }));
    return {
      items,
      ...(parsed.data.nextCursor === undefined ? {} : { nextCursor: parsed.data.nextCursor }),
    };
  }

  async #get(path: string): Promise<unknown> {
    return this.#request(new URL(path, this.#apiOrigin));
  }

  async #request(url: URL): Promise<unknown> {
    const requestController = new AbortController();
    const requestTimer = setTimeout(() => requestController.abort(), this.#timeoutMs);
    let response: Response | undefined;
    try {
      response = await startWithAbort(
        () => this.#fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            "user-agent": "lyth-stele-mcp/0.1.0",
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: requestController.signal,
        }),
        requestController.signal,
        () => undefined,
        cancelResponseBody,
      );

      if (
        response.status !== 200 ||
        !isJsonContentType(response.headers.get("content-type")) ||
        response.headers.get("content-encoding") !== null
      ) {
        cancelResponseBody(response);
        throw new SteleApiBoundaryError();
      }

      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        if (!CANONICAL_UINT.test(declaredLength)) {
          cancelResponseBody(response);
          throw new SteleApiBoundaryError();
        }
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length > this.#maxResponseBytes) {
          cancelResponseBody(response);
          throw new SteleApiBoundaryError();
        }
      }

      const bytes = await readBoundedBody(
        response,
        this.#maxResponseBytes,
        requestController.signal,
      );
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return JSON.parse(body) as unknown;
    } catch {
      cancelResponseBody(response);
      throw new SteleApiBoundaryError();
    } finally {
      clearTimeout(requestTimer);
    }
  }
}

export function steleApiClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): SteleApiClient {
  return new SteleApiClient(
    {
      apiOrigin: environment.LYTH_MCP_STELE_API_ORIGIN,
      publicOrigin: environment.LYTH_MCP_STELE_PUBLIC_ORIGIN,
      allowInsecureLan: environment.LYTH_MCP_STELE_ALLOW_INSECURE_LAN === "1",
      timeoutMs: optionalEnvironmentInteger(environment.LYTH_MCP_STELE_TIMEOUT_MS),
      maxResponseBytes: optionalEnvironmentInteger(environment.LYTH_MCP_STELE_MAX_RESPONSE_BYTES),
    },
    fetchImpl,
  );
}

export function exactSteleOrigin(value: string, allowInsecureLan: boolean): URL {
  if (value === STELE_PRODUCTION_ORIGIN) return new URL(value);
  if (allowInsecureLan) {
    const lan = privateLanOrigin(value);
    if (lan !== null) return lan;
  }
  throw new SteleApiConfigurationError();
}

function privateLanOrigin(value: string): URL | null {
  const match = PRIVATE_LAN_ORIGIN.exec(value);
  if (match === null) return null;
  const octets = match[1].split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null;
  const [first, second] = octets;
  const isPrivate =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (!isPrivate) return null;

  const url = new URL(value);
  return url.protocol === "http:" && url.port === "" ? url : null;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) throw new SteleApiBoundaryError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await startWithAbort(
        () => reader.read(),
        signal,
        () => cancelReader(reader),
        () => cancelReader(reader),
      );
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        throw new SteleApiBoundaryError();
      }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    throw new SteleApiBoundaryError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream cannot make cleanup cross the public boundary.
    }
  }

  if (total === 0) throw new SteleApiBoundaryError();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function startWithAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  onAbort: () => void = () => undefined,
  onLateValue: (value: T) => void = () => undefined,
): Promise<T> {
  if (signal.aborted) {
    safelyInvoke(onAbort);
    throw new SteleApiBoundaryError();
  }

  let promise: Promise<T>;
  try {
    promise = Promise.resolve(start());
  } catch {
    throw new SteleApiBoundaryError();
  }

  return await new Promise<T>((resolve, reject) => {
    let finished = false;
    const aborted = () => {
      if (finished) return;
      finished = true;
      safelyInvoke(onAbort);
      reject(new SteleApiBoundaryError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (finished || signal.aborted) {
          finished = true;
          safelyInvoke(() => onLateValue(value));
          reject(new SteleApiBoundaryError());
          return;
        }
        finished = true;
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        if (finished) return;
        finished = true;
        reject(new SteleApiBoundaryError());
      },
    );
  });
}

function cancelResponseBody(response: Response | undefined): void {
  if (response?.body === null || response?.body === undefined) return;
  safelyIgnorePromise(() => response.body!.cancel());
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  safelyIgnorePromise(() => reader.cancel());
}

function safelyIgnorePromise(start: () => Promise<unknown>): void {
  try {
    void Promise.resolve(start()).catch(() => undefined);
  } catch {
    // Cleanup is best-effort and must never delay or replace a safe failure.
  }
}

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Cleanup hooks never cross the public boundary.
  }
}

function optionalEnvironmentInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new SteleApiConfigurationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new SteleApiConfigurationError();
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SteleApiConfigurationError();
  }
  return value;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
  });
}
