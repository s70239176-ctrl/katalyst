import { createAccount, createClient, generatePrivateKey } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { parseVerdict, type VerdictPayload } from './types';

export const GENLAYER_CONTRACT: string = import.meta.env.VITE_GENLAYER_CONTRACT ?? '';
export const GENLAYER_EXPLORER = 'https://explorer-studio.genlayer.com';

const KEY_STORAGE = 'katalyst.genlayer.previewKey';

/** A throwaway key is enough: simulations are free and Studionet is gasless. */
function previewKey(): `0x${string}` {
  try {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) return saved as `0x${string}`;
    const fresh = generatePrivateKey();
    localStorage.setItem(KEY_STORAGE, fresh);
    return fresh;
  } catch {
    return generatePrivateKey();
  }
}

let client: ReturnType<typeof createClient> | undefined;

function getClient() {
  client ??= createClient({ chain: studionet, account: createAccount(previewKey()) });
  return client;
}

/**
 * Ask the GenLayer solver for a verdict without depositing or persisting anything
 * (`simulateWriteContract` runs the same adjudication code as the real transaction).
 */
export async function previewIntent(prompt: string): Promise<VerdictPayload> {
  if (!GENLAYER_CONTRACT) throw new Error('VITE_GENLAYER_CONTRACT is not configured');
  const raw = await getClient().simulateWriteContract({
    address: GENLAYER_CONTRACT as `0x${string}`,
    functionName: 'preview_intent',
    args: [prompt],
  });
  if (typeof raw !== 'string') throw new Error('Unexpected preview response');
  return parseVerdict(raw);
}
