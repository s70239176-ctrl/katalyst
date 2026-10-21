/**
 * Server-side configuration for the serverless relayer (Vercel Functions).
 * Secrets (RELAYER_PRIVATE_KEY, GENLAYER_PRIVATE_KEY) are read from server-only environment
 * variables and never reach the browser bundle.
 *
 * Multi-chain: `VAULTS` is a JSON array of settlement chains; when it is absent a single Portaldot vault
 * is built from the legacy variables (VAULT_CONTRACT_ADDRESS, PORTALDOT_EVM_RPC, ...).
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

export const GENLAYER_EXPLORER = optionalEnv('GENLAYER_EXPLORER_URL') ?? 'https://explorer-studio.genlayer.com';
const PORTALDOT_EXPLORER = 'https://node-console.portaldot.dev/#/explorer/query/{block}';

// ---- Chains --------------------------------------------------------------------------

/** One settlement chain: a vault, how to reach it and which key relays for it. */
export interface ChainCfg {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  vault: string;
  /** Contract generation: 1 = KatalystVault, 2 = KatalystVaultV2 + PoolHub. */
  version: 1 | 2;
  deployBlock: number;
  /** Template with a `{block}` placeholder. */
  explorerBlockUrl: string;
  /** Env var holding this chain's relayer key (default RELAYER_PRIVATE_KEY). */
  relayerKeyEnv: string;
}

let chainList: ChainCfg[] | undefined;

export function chains(): ChainCfg[] {
  if (chainList) return chainList;
  const raw = optionalEnv('VAULTS');
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(500, 'VAULTS is not valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new HttpError(500, 'VAULTS must be a non-empty array');
    chainList = parsed.map((c: Record<string, unknown>, i): ChainCfg => {
      const key = String(c['key'] ?? '');
      if (!/^[a-z0-9_-]{1,24}$/.test(key)) throw new HttpError(500, `VAULTS[${i}].key must be lowercase alphanumeric`);
      return {
        key,
        name: String(c['name'] ?? key),
        chainId: Number(c['chainId']),
        rpcUrl: String(c['rpcUrl']),
        vault: String(c['vault']),
        version: Number(c['version'] ?? 1) === 2 ? 2 : 1,
        deployBlock: Number(c['deployBlock'] ?? 0),
        explorerBlockUrl: String(c['explorerBlockUrl'] ?? ''),
        relayerKeyEnv: String(c['relayerKeyEnv'] ?? 'RELAYER_PRIVATE_KEY'),
      };
    });
  } else {
    chainList = [
      {
        key: 'portaldot',
        name: 'Portaldot V3 Testnet',
        chainId: Number(process.env['PORTALDOT_CHAIN_ID'] ?? 420420777),
        rpcUrl: optionalEnv('PORTALDOT_EVM_RPC', 'VITE_PORTALDOT_EVM_RPC') ?? 'https://test-evm-rpc-v3.portaldot.dev',
        vault: env('VAULT_CONTRACT_ADDRESS', 'VITE_VAULT_ADDRESS'),
        version: 1,
        deployBlock: Number(optionalEnv('VAULT_DEPLOY_BLOCK', 'VITE_VAULT_DEPLOY_BLOCK') ?? 0),
        explorerBlockUrl: PORTALDOT_EXPLORER,
        relayerKeyEnv: 'RELAYER_PRIVATE_KEY',
      },
    ];
  }
  return chainList;
}

export function chainByKey(key?: string | null): ChainCfg {
  const all = chains();
  if (!key) return all[0]!;
  const found = all.find((c) => c.key === key);
  if (!found) throw new HttpError(400, `Unknown chain "${key}"`);
  return found;
}

/** The solver's reference for an intent: unique across chains and vaults. */
export const intentRef = (chain: ChainCfg, nonce: number): string => `${chain.chainId}:${chain.vault.toLowerCase()}:${nonce}`;

export const explorerBlockUrl = (chain: ChainCfg, block: number): string =>
  chain.explorerBlockUrl ? chain.explorerBlockUrl.replace('{block}', String(block)) : '';

const providers = new Map<string, JsonRpcProvider>();
const wallets = new Map<string, Wallet>();

/** eth-rpc on Portaldot does not support JSON-RPC batching; fail fast so a hung call cannot eat the budget. */
export function getProvider(chain: ChainCfg): JsonRpcProvider {
  let p = providers.get(chain.key);
  if (!p) {
    const req = new FetchRequest(chain.rpcUrl);
    req.timeout = 12_000;
    p = new JsonRpcProvider(req, chain.chainId, { staticNetwork: true, batchMaxCount: 1 });
    providers.set(chain.key, p);
  }
  return p;
}

export function getRelayerWallet(chain: ChainCfg): Wallet {
  let w = wallets.get(chain.key);
  if (!w) {
    w = new Wallet(env(chain.relayerKeyEnv), getProvider(chain));
    wallets.set(chain.key, w);
  }
  return w;
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
