/**
 * Display decimals of $POT through the EVM RPC: native POT has 14 decimals and pallet-revive's
 * `nativeToEthRatio` is 10^4, so 1 POT = 10^18 wei in every EVM-facing number.
 */
export const POT_DECIMALS = 18;
export const SS58_PREFIX = 42;
// Chain-dependent values (chain id, token symbol, ...) live in ./chains. This module stays free of browser/Vite
// dependencies so the SDK and CLI can use it from Node.

export type IntentStatus = 'Pending' | 'Executed' | 'Rejected' | 'Cancelled';

export interface RouteAllocation {
  targetPool: string;
  percentage: number;
  ecoScore: string;
  /** Wei actually sent to this pool. */
  amount: bigint;
}

/** What the vault emitted when the intent was settled (or null route if it was refunded). */
export interface IntentOutcome {
  status: Exclude<IntentStatus, 'Pending'>;
  route: RouteAllocation[] | null;
  totalAmount: bigint;
  txHash: string;
  blockNumber: number;
}

export interface WalletState {
  /** EVM address (checksummed). */
  address: string;
  /** The mapped native account (SS58, prefix 42) that holds this address's $POT. */
  native: string;
}

export type NetworkStatus = 'connecting' | 'online' | 'offline';

/** Lifecycle of the intent currently being tracked in the UI. */
export type FlowStage = 'idle' | 'depositing' | 'adjudicating' | 'settling' | 'executed' | 'rejected' | 'error';

// ---- Verdict (solver output / relayer API) ----------------------------------------

export interface TracePool {
  name: string;
  address: string;
  apy: number;
  eco: string;
  decision: 'selected' | 'excluded';
  reason: string;
  percentage: number;
}

export interface TraceConstraints {
  min_eco_tier: string | null;
  min_apy: number | null;
  maximize_yield: boolean;
}

export interface VerdictTrace {
  screen: string;
  constraints: TraceConstraints | null;
  pools: TracePool[];
}

export interface VerdictLeg {
  target_pool: string;
  percentage: number;
  eco_score: string;
}

export interface VerdictPayload {
  status: 'APPROVED' | 'REJECTED';
  reason?: string;
  allocations: VerdictLeg[];
  trace: VerdictTrace | null;
}

export type IntentPhase = 'adjudicating' | 'settling' | 'executed' | 'rejected' | 'failed';

export interface ChainRef {
  txHash: string;
  explorerUrl: string;
  blockNumber?: number;
}

/** Record served by the relayer's read-only API. */
export interface VerdictRecord {
  nonce: number;
  user: string;
  amount: string;
  prompt: string;
  phase: IntentPhase;
  error?: string;
  receivedAt: number;
  updatedAt: number;
  genlayer?: ChainRef & { validatorsAgreed: number; validatorsTotal: number; votes: Record<string, string> };
  verdict?: { approved: boolean; reason?: string; allocations: VerdictLeg[]; trace: VerdictTrace | null };
  portaldot?: ChainRef;
  refund?: { amount: string; txHash: string };
}

export interface RelayerHealth {
  ok: boolean;
  relayer: string;
  relayerBalance: string;
  vault: string;
  genlayer: { chain: string; contract: string };
  chainId: number;
  /** "serverless" (Vercel Functions) or "daemon" (always-on process). */
  mode?: 'serverless' | 'daemon';
  /** Serverless only: false when the configured relayer key is not the vault's relayer. */
  relayerMatchesVault?: boolean;
  /** Daemon only. */
  uptimeSec?: number;
  queueLength?: number;
  lastSettledAt?: number | null;
}

export interface UserIntent {
  nonce: number;
  user: string;
  amount: bigint;
  prompt: string;
  depositTx: string;
  depositBlock: number;
  outcome: IntentOutcome | null;
}

export interface NetworkStats {
  deposits: number;
  executed: number;
  rejected: number;
  cancelled: number;
  uniqueUsers: number;
  volume: bigint;
  headBlock: number;
}

// ---- Parsing helpers -------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTrace(v: unknown): VerdictTrace | null {
  if (!isRecord(v)) return null;
  const pools = Array.isArray(v['pools'])
    ? v['pools'].filter(isRecord).map((p) => ({
        name: String(p['name'] ?? ''),
        address: String(p['address'] ?? ''),
        apy: Number(p['apy'] ?? 0),
        eco: String(p['eco'] ?? ''),
        decision: p['decision'] === 'selected' ? ('selected' as const) : ('excluded' as const),
        reason: String(p['reason'] ?? ''),
        percentage: Number(p['percentage'] ?? 0),
      }))
    : [];
  const c = v['constraints'];
  const constraints: TraceConstraints | null = isRecord(c)
    ? {
        min_eco_tier: typeof c['min_eco_tier'] === 'string' ? c['min_eco_tier'] : null,
        min_apy: typeof c['min_apy'] === 'number' ? c['min_apy'] : null,
        maximize_yield: c['maximize_yield'] === true,
      }
    : null;
  return { screen: String(v['screen'] ?? ''), constraints, pools };
}

/** Strictly parse the solver's JSON. Throws if the shape is wrong. */
export function parseVerdict(raw: string): VerdictPayload {
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v) || (v['status'] !== 'APPROVED' && v['status'] !== 'REJECTED')) {
    throw new Error('Unexpected verdict format');
  }
  const allocations: VerdictLeg[] = Array.isArray(v['allocations'])
    ? v['allocations'].filter(isRecord).map((a) => ({
        target_pool: String(a['target_pool']),
        percentage: Number(a['percentage']),
        eco_score: String(a['eco_score']),
      }))
    : [];
  return {
    status: v['status'],
    ...(typeof v['reason'] === 'string' ? { reason: v['reason'] } : {}),
    allocations,
    trace: parseTrace(v['trace']),
  };
}

export function normalizeVerdictRecord(r: VerdictRecord): VerdictRecord {
  return r.verdict ? { ...r, verdict: { ...r.verdict, trace: parseTrace(r.verdict.trace) } } : r;
}

// ---- Presentation helpers --------------------------------------------------------

export const POOL_LABELS: Readonly<Record<string, string>> = {
  '0xfb8b324c03b2ba5baf50a22dd1f8ac71c1d94dad': 'Pool Alpha',
  '0xc6d8bf349c0b98935b5aafc2c77309a77750b83f': 'Pool Beta',
  '0x036a137130b01ede1cde55752f22c4b358845f59': 'Pool Gamma',
};

let extraPoolLabels: Readonly<Record<string, string>> = {};

/** Registered by the chain registry: friendly names for the active chain's pools (lowercase addresses). */
export function setPoolLabels(labels: Readonly<Record<string, string>>): void {
  extraPoolLabels = labels;
}

export function poolLabel(address: string): string {
  const k = address.toLowerCase();
  return extraPoolLabels[k] ?? POOL_LABELS[k] ?? shortAddress(address);
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

/** Parse a decimal $POT string ("12.5") into wei. Throws on invalid input. */
export function parsePot(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Enter a positive amount');
  const [whole = '0', frac = ''] = trimmed.split('.');
  if (frac.length > POT_DECIMALS) throw new Error(`At most ${POT_DECIMALS} decimals`);
  return BigInt(whole) * 10n ** BigInt(POT_DECIMALS) + BigInt(frac.padEnd(POT_DECIMALS, '0'));
}

export function formatPot(wei: bigint, maxFraction = 4): string {
  const base = 10n ** BigInt(POT_DECIMALS);
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(POT_DECIMALS, '0').slice(0, maxFraction).replace(/0+$/, '');
  return frac.length > 0 ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
