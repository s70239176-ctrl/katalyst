import { normalizeVerdictRecord, type RelayerHealth, type VerdictRecord } from './types';

/**
 * Base URL of the relayer's read-only API. In dev it defaults to localhost; in a production build it
 * must be provided (VITE_RELAYER_API) or the dApp runs in chain-only mode without consensus details.
 */
export const RELAYER_API: string = (import.meta.env.VITE_RELAYER_API ?? (import.meta.env.DEV ? 'http://localhost:8788' : '')).replace(/\/$/, '');

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!RELAYER_API) throw new Error('Relayer API not configured');
  const res = await fetch(`${RELAYER_API}${path}`, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Relayer API ${res.status}`);
  return (await res.json()) as T;
}

/** Relayer health, or null when the API is unconfigured or unreachable. */
export async function fetchHealth(): Promise<RelayerHealth | null> {
  try {
    return await getJson<RelayerHealth>('/health');
  } catch {
    return null;
  }
}

/** Verdict record for one intent; null if the relayer has not seen it (or is offline). */
export async function fetchVerdict(nonce: number): Promise<VerdictRecord | null> {
  try {
    return normalizeVerdictRecord(await getJson<VerdictRecord>(`/verdicts/${nonce}`));
  } catch {
    return null;
  }
}

export async function fetchUserVerdicts(user: string): Promise<VerdictRecord[]> {
  try {
    const rows = await getJson<VerdictRecord[]>(`/verdicts?user=${encodeURIComponent(user)}`);
    return rows.map(normalizeVerdictRecord);
  } catch {
    return [];
  }
}
