import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { X402VendorPolicy } from "./x402.js";

const STORE_VERSION = 1;

export interface X402PolicyStore {
  schemaVersion: 1;
  policies: X402VendorPolicy[];
}

export interface X402AgentIdentityConfig {
  agentId?: string;
  rewardWallet?: string;
  updatedAt?: string;
}

export function x402StorePath(): string {
  return process.env.LYTH_MCP_X402_STORE || join(homedir(), ".lyth_mcp", "x402_policies.json");
}

export async function readX402Store(path = x402StorePath()): Promise<X402PolicyStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as X402PolicyStore;
    if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.policies)) {
      throw new Error(`unsupported x402 policy store shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: STORE_VERSION, policies: [] };
    }
    throw err;
  }
}

export async function writeX402Store(store: X402PolicyStore, path = x402StorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function upsertX402Policy(policy: X402VendorPolicy): Promise<X402VendorPolicy> {
  const store = await readX402Store();
  const idx = store.policies.findIndex((p) => p.vendorId === policy.vendorId);
  if (idx >= 0) {
    store.policies[idx] = policy;
  } else {
    store.policies.push(policy);
  }
  await writeX402Store(store);
  return policy;
}

export async function getX402Policy(vendorId: string): Promise<X402VendorPolicy> {
  const store = await readX402Store();
  const p = store.policies.find((x) => x.vendorId === vendorId);
  if (!p) throw new Error(`x402 vendor policy '${vendorId}' not found`);
  return p;
}

export async function listX402Policies(): Promise<X402VendorPolicy[]> {
  return (await readX402Store()).policies;
}

export async function removeX402Policy(vendorId: string): Promise<{ removed: boolean; path: string }> {
  const store = await readX402Store();
  const next = store.policies.filter((p) => p.vendorId !== vendorId);
  if (next.length === store.policies.length) {
    throw new Error(`x402 vendor policy '${vendorId}' not found`);
  }
  await writeX402Store({ schemaVersion: STORE_VERSION, policies: next });
  return { removed: true, path: x402StorePath() };
}

// ERC-8004 agent identity: tiny standalone store (no encryption — just config).
const AGENT_IDENTITY_KEY = "__agent_identity__";

export function agentIdentityPath(): string {
  return process.env.LYTH_MCP_AGENT_IDENTITY || join(homedir(), ".lyth_mcp", "agent_identity.json");
}

export async function readAgentIdentity(): Promise<X402AgentIdentityConfig> {
  try {
    const raw = await readFile(agentIdentityPath(), "utf8");
    return JSON.parse(raw) as X402AgentIdentityConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function writeAgentIdentity(config: X402AgentIdentityConfig): Promise<X402AgentIdentityConfig> {
  const out: X402AgentIdentityConfig = { ...config, updatedAt: new Date().toISOString() };
  const path = agentIdentityPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return out;
}

// Mark to silence unused warning if needed in the future.
export const X402_AGENT_KEY = AGENT_IDENTITY_KEY;
