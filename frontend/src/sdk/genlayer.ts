/**
 * GenLayer side of the Katalyst SDK. Environment-agnostic (browser and Node): no import.meta.env, no window.
 */
import { abi, createAccount, createClient, generatePrivateKey } from 'genlayer-js';
import * as chains from 'genlayer-js/chains';
import { TransactionHashVariant, transactionsStatusNumberToName } from 'genlayer-js/types';
import { parseVerdict, type VerdictPayload } from '../utils/types';

export interface GenLayerConfig {
  /** Deployed IntelligentVaultSolver address. */
  contract: string;
  /** studionet (default) | testnetAsimov | testnetBradbury | localnet */
  chain?: string;
  /** Optional; simulations and reads work with a throwaway key. */
  privateKey?: `0x${string}`;
}

/** One `adjudicate_intent` transaction found on the solver, decoded back to its intent. */
export interface Adjudication {
  hash: string;
  nonce: number;
  amountWei: string;
  prompt: string;
  status: string;
  createdAt: string | null;
  votes: Record<string, string>;
  agreed: number;
  total: number;
}

export interface ValidatorStat {
  address: string;
  participations: number;
  agree: number;
  disagree: number;
  idle: number;
  /** agree / participations, 0..1 */
  reliability: number;
}

const FAILED = new Set(['UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT']);

export const isSuccessStatus = (s: string): boolean => s === 'ACCEPTED' || s === 'FINALIZED';
export const isFailedStatus = (s: string): boolean => FAILED.has(s);

export function normalizeStatus(raw: unknown): string {
  const table = transactionsStatusNumberToName as Record<string, string>;
  return typeof raw === 'string' && Number.isNaN(Number(raw)) ? raw : (table[String(raw)] ?? String(raw));
}

type Client = ReturnType<typeof createClient>;

export class GenLayerReader {
  private cached: Client | undefined;

  constructor(private readonly cfg: GenLayerConfig) {}

  get contract(): `0x${string}` {
    return this.cfg.contract as `0x${string}`;
  }

  private client(): Client {
    if (!this.cached) {
      const name = this.cfg.chain ?? 'studionet';
      const chain = (chains as Record<string, unknown>)[name];
      if (!chain) throw new Error(`Unknown GenLayer chain "${name}"`);
      this.cached = createClient({
        chain: chain as typeof chains.studionet,
        account: createAccount(this.cfg.privateKey ?? generatePrivateKey()),
      });
    }
    return this.cached;
  }

  /** Free adjudication preview: runs the solver's full logic without storing anything. */
  async preview(prompt: string): Promise<VerdictPayload> {
    const raw = await this.client().simulateWriteContract({
      address: this.contract,
      functionName: 'preview_intent',
      args: [prompt],
    });
    if (typeof raw !== 'string') throw new Error('Unexpected preview response');
    return parseVerdict(raw);
  }

  /** Stored verdict JSON for an intent nonce, or null if the solver has none. */
  async result(nonce: number): Promise<string | null> {
    const raw = await this.client().readContract({
      address: this.contract,
      functionName: 'get_result',
      args: [BigInt(nonce)],
      transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
    });
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  /** Where a GenLayer transaction stands, with its validator votes. */
  async txState(hash: string): Promise<{ status: string; votes: Record<string, string> } | null> {
    const request = this.client().request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    const tx = (await request({ method: 'eth_getTransactionByHash', params: [hash] })) as Record<string, unknown> | null;
    if (!tx) return null;
    const votes = (tx['consensus_data'] as { votes?: Record<string, string> } | undefined)?.votes ?? {};
    return { status: normalizeStatus(tx['status']), votes };
  }

  /**
   * Every `adjudicate_intent` transaction on the solver, decoded to (nonce, prompt, amount) with its votes.
   * Uses Studio's `sim_getTransactionsForAddress`; returns null where the network does not offer it.
   */
  async adjudications(): Promise<Adjudication[] | null> {
    const request = this.client().request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    let rows: unknown;
    try {
      rows = await request({ method: 'sim_getTransactionsForAddress', params: [this.cfg.contract] });
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;

    const out: Adjudication[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const data = row['data'] as { calldata?: string } | undefined;
      if (!data?.calldata) continue;
      try {
        const decoded = abi.calldata.decode(Uint8Array.from(atob(data.calldata), (c) => c.charCodeAt(0))) as unknown;
        const call = decoded instanceof Map ? Object.fromEntries(decoded as Map<string, unknown>) : (decoded as Record<string, unknown>);
        if (call['method'] !== 'adjudicate_intent') continue;
        const args = call['args'] as unknown[];
        const votes = (row['consensus_data'] as { votes?: Record<string, string> } | undefined)?.votes ?? {};
        const values = Object.values(votes);
        out.push({
          hash: String(row['hash']),
          nonce: Number(args[0]),
          amountWei: String(args[2]),
          prompt: String(args[1]),
          status: normalizeStatus(row['status']),
          createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : null,
          votes,
          agreed: values.filter((v) => v.toLowerCase() === 'agree').length,
          total: values.length,
        });
      } catch {
        /* not an adjudication call */
      }
    }
    return out.sort((a, b) => b.nonce - a.nonce);
  }

  /** The adjudication transaction for `nonce`, preferring one that reached consensus. */
  async findAdjudication(nonce: number): Promise<Adjudication | null> {
    const all = await this.adjudications();
    if (!all) return null;
    const matches = all.filter((a) => a.nonce === nonce);
    return matches.find((a) => isSuccessStatus(a.status)) ?? matches[0] ?? null;
  }
}

/** Per-validator participation across adjudications that reached consensus. */
export function validatorStats(rows: Adjudication[]): ValidatorStat[] {
  const map = new Map<string, ValidatorStat>();
  for (const row of rows) {
    if (!isSuccessStatus(row.status)) continue;
    for (const [address, vote] of Object.entries(row.votes)) {
      const s = map.get(address) ?? { address, participations: 0, agree: 0, disagree: 0, idle: 0, reliability: 0 };
      s.participations += 1;
      const v = vote.toLowerCase();
      if (v === 'agree') s.agree += 1;
      else if (v === 'idle') s.idle += 1;
      else s.disagree += 1;
      map.set(address, s);
    }
  }
  return [...map.values()]
    .map((s) => ({ ...s, reliability: s.participations ? s.agree / s.participations : 0 }))
    .sort((a, b) => b.participations - a.participations || b.reliability - a.reliability);
}
