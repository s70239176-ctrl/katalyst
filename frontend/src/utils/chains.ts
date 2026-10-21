/**
 * Settlement-chain registry. One Katalyst deployment can settle on several EVM chains: each chain has its own
 * vault, while GenLayer (the decision layer) is shared. The user picks the active chain in the header; every
 * chain-dependent helper reads it through this module at call time.
 *
 * Configure with VITE_CHAINS, a JSON array (see .env.example). Without it, a single Portaldot V3 Testnet chain is
 * built from the legacy VITE_VAULT_ADDRESS / VITE_VAULT_DEPLOY_BLOCK / VITE_PORTALDOT_EVM_RPC variables.
 */

import { setPoolLabels } from './types';

export interface ChainEntry {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  vault: string;
  /** Contract generation: 1 = KatalystVault, 2 = KatalystVaultV2 + PoolHub (refunds, fee, route lock, delay + veto). */
  version: 1 | 2;
  /** v2: the PoolHub holding users' pool positions. */
  hub: string;
  /** Block the vault was deployed in (bounds log scans). */
  deployBlock: number;
  /** Block URL template with a `{block}` placeholder; empty when the chain has no explorer. */
  explorerBlockUrl: string;
  /** Native currency ticker shown next to amounts. */
  symbol: string;
  /** Portaldot's EVM addresses map to a native (SS58) account that holds the funds. */
  portaldotNative: boolean;
  /** This vault's earliest intents used bare-nonce solver refs (see the SDK's `legacyNonceRefs`). */
  legacyNonceRefs: boolean;
  /** Typical network fee for one intent, in native units (shown to the user). */
  feeEstimate: number;
  /** Balance to keep spare for gas, in native units. */
  gasReserve: number;
  /** Friendly names for known pool addresses (lowercase). */
  poolLabels: Record<string, string>;
}

const PORTALDOT_EXPLORER = 'https://node-console.portaldot.dev/#/explorer/query/{block}';

/**
 * The Portaldot node console opens on the *live* network by default, whose block numbers are unrelated to the testnet's.
 * Point links at the testnet node (`?rpc=`) so a block number from the EVM RPC opens the same block in the explorer.
 */
const TESTNET_NODE = 'wss%3A%2F%2Ftest-node-v3.portaldot.dev';
export function withTestnetNode(url: string): string {
  if (!url.includes('node-console.portaldot.dev') || /[?&]rpc=/.test(url)) return url;
  const i = url.indexOf('#');
  const base = i < 0 ? url : url.slice(0, i);
  const hash = i < 0 ? '' : url.slice(i);
  return `${base}${base.includes('?') ? '&' : '?'}rpc=${TESTNET_NODE}${hash}`;
}


function fromEnv(): ChainEntry[] {
  const raw = import.meta.env.VITE_CHAINS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((c): ChainEntry => {
          const portaldot = c['portaldotNative'] === true;
          return {
            key: String(c['key']),
            name: String(c['name'] ?? c['key']),
            chainId: Number(c['chainId']),
            rpcUrl: String(c['rpcUrl']),
            vault: String(c['vault'] ?? ''),
            version: Number(c['version'] ?? 1) === 2 ? 2 : 1,
            hub: String(c['hub'] ?? ''),
            deployBlock: Number(c['deployBlock'] ?? 0),
            explorerBlockUrl: withTestnetNode(String(c['explorerBlockUrl'] ?? '')),
            symbol: String(c['symbol'] ?? 'ETH'),
            portaldotNative: portaldot,
            legacyNonceRefs: c['legacyNonceRefs'] === true,
            feeEstimate: Number(c['feeEstimate'] ?? (portaldot ? 4 : 0.005)),
            gasReserve: Number(c['gasReserve'] ?? (portaldot ? 9 : 0.01)),
            poolLabels: Object.fromEntries(Object.entries((c['poolLabels'] as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
          };
        });
      }
    } catch {
      /* fall through to the single-chain default */
    }
  }
  return [
    {
      key: 'portaldot',
      name: 'Portaldot V3 Testnet',
      chainId: 420420777,
      rpcUrl: import.meta.env.VITE_PORTALDOT_EVM_RPC ?? 'https://test-evm-rpc-v3.portaldot.dev',
      vault: import.meta.env.VITE_VAULT_ADDRESS ?? '',
      version: 1,
      hub: '',
      deployBlock: Number(import.meta.env.VITE_VAULT_DEPLOY_BLOCK ?? 0),
      explorerBlockUrl: withTestnetNode(PORTALDOT_EXPLORER),
      symbol: 'tPOT',
      portaldotNative: true,
      legacyNonceRefs: true,
      feeEstimate: 4,
      gasReserve: 9,
      poolLabels: {},
    },
  ];
}

export const CHAINS: readonly ChainEntry[] = fromEnv();

const STORAGE_KEY = 'katalyst.chain';

function initialKey(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('chain');
    if (fromUrl && CHAINS.some((c) => c.key === fromUrl)) return fromUrl;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CHAINS.some((c) => c.key === saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return CHAINS[0]!.key;
}

let activeKey = initialKey();
setPoolLabels((CHAINS.find((c) => c.key === activeKey) ?? CHAINS[0]!).poolLabels);

export const activeChain = (): ChainEntry => CHAINS.find((c) => c.key === activeKey) ?? CHAINS[0]!;

/** Persist the choice. Callers reload the page so every cached provider and SDK instance is rebuilt. */
export function setActiveChain(key: string): void {
  if (!CHAINS.some((c) => c.key === key)) return;
  activeKey = key;
  setPoolLabels((CHAINS.find((c) => c.key === key) ?? CHAINS[0]!).poolLabels);
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* ignore */
  }
}

export const vaultAddress = (): string => activeChain().vault;
export const vaultDeployBlock = (): number => activeChain().deployBlock;
export const rpcUrl = (): string => activeChain().rpcUrl;

/**
 * RPC endpoint the dApp reads through. With the serverless relayer (no separate API configured) reads go through the
 * same-origin /api/rpc proxy, which avoids the public RPC's CORS failures under throttling and retries transient errors.
 * Wallets still talk to the chain's own RPC directly.
 */
export function readRpcUrl(c: ChainEntry = activeChain()): string {
  const serverless = !(import.meta.env.VITE_RELAYER_API ?? (import.meta.env.DEV ? 'http://localhost:8788' : ''));
  return serverless && typeof window !== 'undefined' ? `${window.location.origin}/api/rpc?chain=${encodeURIComponent(c.key)}` : c.rpcUrl;
}
export const chainId = (): number => activeChain().chainId;
export const tokenSymbol = (): string => activeChain().symbol;

/** Block URL for the active chain, or '' when it has no explorer. */
export const blockUrl = (block: number): string => {
  const t = activeChain().explorerBlockUrl;
  return t ? t.replace('{block}', String(block)) : '';
};
