/** The dApp's SDK instances (one per settlement chain), configured from Vite env. */
import { createKatalyst, type Katalyst } from '../sdk';
import { activeChain } from './chains';
import { GENLAYER_CONTRACT, previewKey } from './genlayer';

/** Earlier solver deployments, comma separated. Only chains with `legacyNonceRefs` consult them. */
const FALLBACKS = (import.meta.env.VITE_GENLAYER_FALLBACKS ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter((s: string) => /^0x[0-9a-fA-F]{40}$/.test(s));

const instances = new Map<string, Katalyst>();

export function getKatalyst(): Katalyst {
  const c = activeChain();
  let k = instances.get(c.key);
  if (!k) {
    k = createKatalyst({
      vault: c.vault,
      rpcUrl: c.rpcUrl,
      chainId: c.chainId,
      deployBlock: c.deployBlock,
      legacyNonceRefs: c.legacyNonceRefs,
      ...(GENLAYER_CONTRACT
        ? { genlayer: { contract: GENLAYER_CONTRACT, privateKey: previewKey(), ...(c.legacyNonceRefs && FALLBACKS.length ? { fallbackContracts: FALLBACKS } : {}) } }
        : {}),
    });
    instances.set(c.key, k);
  }
  return k;
}

export const katalystConfigured = (): boolean => activeChain().vault.length > 0;
