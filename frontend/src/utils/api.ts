import { activeChain } from './chains';
import { normalizeVerdictRecord, type IntentPhase, type RelayerHealth, type VerdictRecord } from './types';

/**
 * Two ways to run the relayer:
 *  - "daemon": an always-on process (relayer/) serving a read-only API at VITE_RELAYER_API.
 *  - "serverless": Vercel Functions at /api, driven by this client's polling. Used when
 *    VITE_RELAYER_API is unset in a production build.
 */
const DAEMON_URL: string = (import.meta.env.VITE_RELAYER_API ?? (import.meta.env.DEV ? 'http://localhost:8788' : '')).replace(/\/$/, '');
export const API_MODE: 'daemon' | 'serverless' = DAEMON_URL ? 'daemon' : 'serverless';
export const RELAYER_API: string = DAEMON_URL;

/** Delay between lifecycle polls: serverless polls do real work, so keep them gentler. */
export const POLL_INTERVAL_MS = API_MODE === 'serverless' ? 6000 : 4000;

const REQUEST_TIMEOUT_MS = 58_000;

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { status: res.status, body: (await res.json()) as T };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Health -----------------------------------------------------------------------

/** Relayer health, or null when unreachable. */
export async function fetchHealth(): Promise<RelayerHealth | null> {
  try {
    const { status, body } = await getJson<RelayerHealth>(API_MODE === 'daemon' ? `${DAEMON_URL}/health` : '/api/health');
    return status === 200 ? body : null;
  } catch {
    return null;
  }
}

// ---- Verdict records ---------------------------------------------------------------

interface RelayResponse {
  nonce?: number;
  phase?: string;
  user?: string;
  amount?: string;
  glTx?: string;
  genlayer?: VerdictRecord['genlayer'];
  verdict?: VerdictRecord['verdict'];
  portaldot?: VerdictRecord['portaldot'];
  refund?: VerdictRecord['refund'];
  error?: string;
}

// Keyed by chain + nonce: nonces repeat across settlement chains.
const glTxByNonce = new Map<string, string>();
const lastRecord = new Map<string, VerdictRecord>();
const consecutiveErrors = new Map<string, number>();
const k = (nonce: number): string => `${activeChain().key}:${nonce}`;

const cacheKey = (): string => `katalyst.verdicts.${activeChain().key}.${activeChain().vault || 'default'}`;

function readCache(): Record<string, VerdictRecord> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey()) ?? '{}') as Record<string, VerdictRecord>;
  } catch {
    return {};
  }
}

function remember(record: VerdictRecord): void {
  try {
    const all = readCache();
    all[String(record.nonce)] = record;
    localStorage.setItem(cacheKey(), JSON.stringify(all));
  } catch {
    /* storage unavailable: history simply won't have consensus details */
  }
}

function toRecord(nonce: number, r: RelayResponse): VerdictRecord | null {
  const phase: IntentPhase | null =
    r.phase === 'adjudicating' || r.phase === 'settling' || r.phase === 'executed' || r.phase === 'rejected'
      ? r.phase
      : r.phase === 'cancelled'
        ? 'rejected'
        : null;
  if (!phase) return null;
  const now = Date.now();
  return normalizeVerdictRecord({
    nonce,
    user: r.user ?? '',
    amount: r.amount ?? '0',
    prompt: '',
    phase,
    receivedAt: now,
    updatedAt: now,
    ...(r.genlayer ? { genlayer: r.genlayer } : {}),
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(r.portaldot ? { portaldot: r.portaldot } : {}),
    ...(r.refund ? { refund: r.refund } : {}),
  });
}

/**
 * Verdict record for one intent.
 * Serverless mode: each call also *advances* the intent (submit to GenLayer → settle), so callers
 * must pass the deposit block and keep polling until the chain reports the outcome.
 */
export async function fetchVerdict(nonce: number, hint?: { block?: number }): Promise<VerdictRecord | null> {
  if (API_MODE === 'daemon') {
    try {
      const { status, body } = await getJson<VerdictRecord>(`${DAEMON_URL}/verdicts/${nonce}`);
      return status === 200 ? normalizeVerdictRecord(body) : null;
    } catch {
      return null;
    }
  }

  const params = new URLSearchParams({ nonce: String(nonce), chain: activeChain().key });
  if (hint?.block) params.set('block', String(hint.block));
  const gl = glTxByNonce.get(k(nonce));
  if (gl) params.set('gl', gl);

  try {
    const { status, body } = await getJson<RelayResponse>(`/api/relay?${params}`);
    if (status === 404) return null;
    if (status >= 400) throw new Error(body.error ?? `HTTP ${status}`);
    consecutiveErrors.set(k(nonce), 0);

    const learned = body.glTx ?? body.genlayer?.txHash;
    if (learned) glTxByNonce.set(k(nonce), learned);
    const fresh = toRecord(nonce, body);
    if (!fresh) return null;
    // Only the poll that sent the settlement sees the refund and votes; keep them across later polls.
    const prev = lastRecord.get(k(nonce));
    const record: VerdictRecord = {
      ...fresh,
      ...(fresh.genlayer ?? prev?.genlayer ? { genlayer: (fresh.genlayer ?? prev?.genlayer)! } : {}),
      ...(fresh.verdict ?? prev?.verdict ? { verdict: (fresh.verdict ?? prev?.verdict)! } : {}),
      ...(fresh.refund ?? prev?.refund ? { refund: (fresh.refund ?? prev?.refund)! } : {}),
      ...(fresh.user ? {} : { user: prev?.user ?? '' }),
    };
    lastRecord.set(k(nonce), record);
    if (record.phase === 'executed' || record.phase === 'rejected') remember(record);
    return record;
  } catch (err) {
    // Tolerate transient failures; surface a persistent one so the UI can offer a refund.
    const n = (consecutiveErrors.get(k(nonce)) ?? 0) + 1;
    consecutiveErrors.set(k(nonce), n);
    if (n >= 4) {
      const now = Date.now();
      return { nonce, user: '', amount: '0', prompt: '', phase: 'failed', error: err instanceof Error ? err.message : 'Relayer error', receivedAt: now, updatedAt: now };
    }
    return null;
  }
}

export async function fetchUserVerdicts(user: string): Promise<VerdictRecord[]> {
  if (API_MODE === 'serverless') {
    return Object.values(readCache()).filter((r) => r.user.toLowerCase() === user.toLowerCase());
  }
  try {
    const { status, body } = await getJson<VerdictRecord[]>(`${DAEMON_URL}/verdicts?user=${encodeURIComponent(user)}`);
    return status === 200 ? body.map(normalizeVerdictRecord) : [];
  } catch {
    return [];
  }
}

// ---- Status (serverless mode) ---------------------------------------------------------

export interface StatusCheckView {
  id: string;
  label: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface StatusView {
  ok: boolean;
  generatedAt: string;
  checks: StatusCheckView[];
}

/** Operational checks from /api/status (serverless mode only; the daemon exposes /health and /metrics). */
export async function fetchStatus(): Promise<StatusView | null> {
  if (API_MODE !== 'serverless') return null;
  try {
    // 503 still carries the JSON body describing what is wrong.
    const { body } = await getJson<StatusView>('/api/status');
    return Array.isArray(body.checks) ? body : null;
  } catch {
    return null;
  }
}
