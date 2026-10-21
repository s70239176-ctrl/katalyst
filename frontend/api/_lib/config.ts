/**
 * Server-side configuration for the serverless relayer (Vercel Functions).
 * Secrets (RELAYER_PRIVATE_KEY, GENLAYER_PRIVATE_KEY) are read from server-only environment
 * variables and never reach the browser bundle.
 */
import { FetchRequest, JsonRpcProvider, Wallet } from 'ethers';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** First defined, non-empty environment variable among `names`. */
export function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  throw new HttpError(500, `${names[0]} is not configured`);
}

export function optionalEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export const CHAIN_ID = Number(process.env['PORTALDOT_CHAIN_ID'] ?? 420420777);
export const VAULT_ADDRESS = (): string => env('VAULT_CONTRACT_ADDRESS', 'VITE_VAULT_ADDRESS');
export const VAULT_DEPLOY_BLOCK = (): number => Number(optionalEnv('VAULT_DEPLOY_BLOCK', 'VITE_VAULT_DEPLOY_BLOCK') ?? 0);
export const EXPLORER = 'https://node-console.portaldot.dev';
export const GENLAYER_EXPLORER = optionalEnv('GENLAYER_EXPLORER_URL') ?? 'https://explorer-studio.genlayer.com';

export const explorerBlockUrl = (n: number): string => `${EXPLORER}/#/explorer/query/${n}`;

let provider: JsonRpcProvider | undefined;
let wallet: Wallet | undefined;

/** eth-rpc on Portaldot does not support JSON-RPC batching. */
export function getProvider(): JsonRpcProvider {
  if (!provider) {
    // Fail fast: a hung RPC call must error long before the function's own time limit.
    const req = new FetchRequest(optionalEnv('PORTALDOT_EVM_RPC', 'VITE_PORTALDOT_EVM_RPC') ?? 'https://test-evm-rpc-v3.portaldot.dev');
    req.timeout = 12_000;
    provider = new JsonRpcProvider(req, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  }
  return provider;
}

/** Retry a transient RPC failure (timeouts, dropped sockets) a couple of times. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

export function getRelayerWallet(): Wallet {
  wallet ??= new Wallet(env('RELAYER_PRIVATE_KEY'), getProvider());
  return wallet;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  const message = err instanceof Error ? err.message : 'internal error';
  console.error('[api] unhandled:', message);
  return json({ error: message }, 500);
}
