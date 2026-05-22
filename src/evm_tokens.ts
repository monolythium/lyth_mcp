// Canonical EVM token contract addresses, by chain id and symbol.
// Sourced from issuer-published addresses (Circle, Tether). Verified on
// etherscan/basescan before commit. Keep this list short and conservative —
// expand only after confirming the issuer-published address.

export interface EvmTokenRecord {
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  issuer: string;
  native?: boolean;
  notes?: string;
}

const TOKENS: EvmTokenRecord[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    chainId: 1,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    issuer: "Circle",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    chainId: 1,
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    issuer: "Tether",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    chainId: 8453,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    issuer: "Circle",
    native: true,
    notes: "Native USDC on Base. Use this for Travala x402 USDC payments.",
  },
];

export function listEvmTokens(chainId?: number): EvmTokenRecord[] {
  return chainId ? TOKENS.filter((t) => t.chainId === chainId) : TOKENS.slice();
}

export function findEvmToken(chainId: number, symbol: string): EvmTokenRecord | null {
  const sym = symbol.toUpperCase();
  return TOKENS.find((t) => t.chainId === chainId && t.symbol === sym) ?? null;
}

export function requireEvmToken(chainId: number, symbol: string): EvmTokenRecord {
  const token = findEvmToken(chainId, symbol);
  if (!token) {
    throw new Error(`no canonical address for ${symbol.toUpperCase()} on chain ${chainId}`);
  }
  return token;
}
