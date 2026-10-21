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
            deployBlock: Number(c['deployBlock'] ?? 0),
            explorerBlockUrl: String(c['explorerBlockUrl'] ?? ''),
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
      deployBlock: Number(import.meta.env.VITE_VAULT_DEPLOY_BLOCK ?? 0),
      explorerBlockUrl: PORTALDOT_EXPLORER,
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
export const chainId = (): number => activeChain().chainId;
export const tokenSymbol = (): string => activeChain().symbol;

/** Block URL for the active chain, or '' when it has no explorer. */
export const blockUrl = (block: number): string => {
  const t = activeChain().explorerBlockUrl;
  return t ? t.replace('{block}', String(block)) : '';
};
