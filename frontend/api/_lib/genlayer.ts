import { createAccount, createClient } from 'genlayer-js';
import * as chains from 'genlayer-js/chains';
import { TransactionHashVariant, transactionsStatusNumberToName } from 'genlayer-js/types';
import { GENLAYER_EXPLORER, HttpError, env, optionalEnv } from './config.js';
import type { VerdictLeg } from './vault.js';

type Client = ReturnType<typeof createClient>;
let cached: { client: Client; contract: `0x${string}` } | undefined;

function getClient(): { client: Client; contract: `0x${string}` } {
  if (cached) return cached;
  const name = optionalEnv('GENLAYER_CHAIN') ?? 'studionet';
  const chain = (chains as Record<string, unknown>)[name];
  if (!chain) throw new HttpError(500, `Unknown GENLAYER_CHAIN "${name}"`);
  const key = env('GENLAYER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new HttpError(500, 'GENLAYER_PRIVATE_KEY must be 0x-prefixed hex');
  const contract = env('GENLAYER_CONTRACT_ADDRESS', 'VITE_GENLAYER_CONTRACT');
  const client = createClient({ chain: chain as typeof chains.studionet, account: createAccount(key as `0x${string}`) });
  cached = { client, contract: contract as `0x${string}` };
  return cached;
}

export const genlayerChainName = (): string => optionalEnv('GENLAYER_CHAIN') ?? 'studionet';
export const genlayerContract = (): string => env('GENLAYER_CONTRACT_ADDRESS', 'VITE_GENLAYER_CONTRACT');
export const genlayerTxUrl = (hash: string): string => `${GENLAYER_EXPLORER}/tx/${hash}`;

/** Cheap liveness probe: read a view on the solver. Resolves to the admin string; throws if unreachable. */
export async function pingGenLayer(): Promise<string> {
  const { client, contract } = getClient();
  const raw = await client.readContract({ address: contract, functionName: 'get_admin', args: [] });
  return String(raw);
}

/** Submit `adjudicate_intent` and return the GenLayer transaction hash without waiting for consensus. */
export async function submitAdjudication(nonce: number, prompt: string, amountWei: bigint): Promise<string> {
  const { client, contract } = getClient();
  const hash = await client.writeContract({
    address: contract,
    functionName: 'adjudicate_intent',
    args: [BigInt(nonce), prompt, amountWei],
    value: 0n,
  });
  return String(hash);
}

export interface TxState {
  kind: 'pending' | 'ok' | 'failed';
  status: string;
  votes: Record<string, string>;
}

const FAILED = new Set(['UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT']);

/** Where a previously submitted adjudication stands. Handles name, string or numeric status codes. */
export async function txState(hash: string): Promise<TxState> {
  const { client } = getClient();
  const request = client.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  const tx = (await request({ method: 'eth_getTransactionByHash', params: [hash] })) as Record<string, unknown> | null;
  if (!tx) return { kind: 'pending', status: 'UNKNOWN', votes: {} };

  const raw = tx['status'];
  const table = transactionsStatusNumberToName as Record<string, string>;
  const status = typeof raw === 'string' && Number.isNaN(Number(raw)) ? raw : (table[String(raw)] ?? String(raw));
  const votesRaw = (tx['consensus_data'] as { votes?: Record<string, string> } | undefined)?.votes ?? {};
  const kind = status === 'ACCEPTED' || status === 'FINALIZED' ? 'ok' : FAILED.has(status) ? 'failed' : 'pending';
  return { kind, status, votes: votesRaw };
}

/** The stored verdict for `nonce` (read from the latest non-final state), or null if none yet. */
export async function readResult(nonce: number): Promise<string | null> {
  const { client, contract } = getClient();
  const raw = await client.readContract({
    address: contract,
    functionName: 'get_result',
    args: [BigInt(nonce)],
    transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
  });
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export interface Verdict {
  approved: boolean;
  reason?: string;
  allocations: VerdictLeg[];
  trace: unknown;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strictly validate the solver JSON before any funds move on its say-so. */
export function parseVerdict(raw: string, expectedNonce: number): Verdict {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(502, 'GenLayer returned non-JSON');
  }
  if (!isRecord(v) || v['nonce'] !== expectedNonce) throw new HttpError(502, 'GenLayer verdict nonce mismatch');
  const status = v['status'];
  if (status !== 'APPROVED' && status !== 'REJECTED') throw new HttpError(502, 'GenLayer verdict has unknown status');
  if (!Array.isArray(v['allocations'])) throw new HttpError(502, 'GenLayer verdict missing allocations');

  const allocations = v['allocations'].map((a: unknown, i): VerdictLeg => {
    if (!isRecord(a)) throw new HttpError(502, `allocation #${i} malformed`);
    const { target_pool, percentage, eco_score } = a;
    if (typeof target_pool !== 'string' || !EVM_ADDRESS.test(target_pool)) throw new HttpError(502, `allocation #${i}: bad pool`);
    if (typeof percentage !== 'number' || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) throw new HttpError(502, `allocation #${i}: bad percentage`);
    if (typeof eco_score !== 'string' || eco_score.length === 0 || eco_score.length > 8) throw new HttpError(502, `allocation #${i}: bad eco score`);
    return { target_pool, percentage, eco_score };
  });

  if (status === 'APPROVED') {
    if (allocations.reduce((s, a) => s + a.percentage, 0) !== 100) throw new HttpError(502, 'allocations do not sum to 100');
    if (new Set(allocations.map((a) => a.target_pool.toLowerCase())).size !== allocations.length) throw new HttpError(502, 'duplicate pools');
  }
  return {
    approved: status === 'APPROVED',
    ...(typeof v['reason'] === 'string' ? { reason: v['reason'] } : {}),
    allocations,
    trace: v['trace'] ?? null,
  };
}
