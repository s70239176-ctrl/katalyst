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
  /**
   * Earlier solver deployments, consulted for intents adjudicated before the current one was deployed
   * (they answer the legacy nonce-only API). Only meaningful for a chain whose old intents used plain nonces.
   */
  fallbackContracts?: string[];
}

/** One `adjudicate_intent` transaction found on the solver, decoded back to its intent. */
export interface Adjudication {
  hash: string;
  /** The solver's key for the intent: "chainId:vault:nonce", or the bare nonce for the legacy API. */
  ref: string;
  /** Solver contract the transaction was sent to. */
  contract: string;
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

  /** The current solver first, then any earlier deployments. */
  private get contracts(): string[] {
    return [this.cfg.contract, ...(this.cfg.fallbackContracts ?? [])];
  }

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

  /**
   * Simulate any write method on any GenLayer contract (free; nothing is stored). Lets other dApps reuse the
   * same pattern with their own intelligent contracts. Returns the method's return value.
   */
  async simulate(method: string, args: unknown[], contract?: string): Promise<unknown> {
    return this.client().simulateWriteContract({
      address: (contract ?? this.cfg.contract) as `0x${string}`,
      functionName: method,
      args: args as never[],
    });
  }

  /**
   * Stored verdict JSON for an intent, or null if no solver has one. `ref` is "chainId:vault:nonce".
   * With `legacyNonce`, earlier nonce-only deployments are consulted too.
   */
  async result(ref: string, legacyNonce?: number): Promise<string | null> {
    const read = async (address: string, fn: string, arg: string | bigint): Promise<string | null> => {
      try {
        const raw = await this.client().readContract({
          address: address as `0x${string}`,
          functionName: fn,
          args: [arg],
          transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
        });
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
      } catch {
        return null; // an older deployment may not expose this method
      }
    };
    const direct = await read(this.cfg.contract, 'get_result_ref', ref);
    if (direct || legacyNonce === undefined) return direct;
    for (const address of this.contracts) {
      const hit = (await read(address, 'get_result_ref', String(legacyNonce))) ?? (await read(address, 'get_result', BigInt(legacyNonce)));
      if (hit) return hit;
    }
    return null;
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
   * Every adjudication transaction on the solver(s), decoded to (ref, nonce, prompt, amount) with its votes.
   * Uses Studio's `sim_getTransactionsForAddress`; returns null where the network does not offer it.
   */
  async adjudications(): Promise<Adjudication[] | null> {
    const request = this.client().request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    const out: Adjudication[] = [];
    let any = false;
    for (const contract of this.contracts) {
      let rows: unknown;
      try {
        rows = await request({ method: 'sim_getTransactionsForAddress', params: [contract] });
      } catch {
        continue;
      }
      if (!Array.isArray(rows)) continue;
      any = true;
      for (const row of rows as Array<Record<string, unknown>>) {
        const data = row['data'] as { calldata?: string } | undefined;
        if (!data?.calldata) continue;
        try {
          const decoded = abi.calldata.decode(Uint8Array.from(atob(data.calldata), (c) => c.charCodeAt(0))) as unknown;
          const call = decoded instanceof Map ? Object.fromEntries(decoded as Map<string, unknown>) : (decoded as Record<string, unknown>);
          const method = call['method'];
          if (method !== 'adjudicate_intent' && method !== 'adjudicate_ref') continue;
          const args = call['args'] as unknown[];
          const ref = String(args[0]);
          const nonce = Number(ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref);
          const votes = (row['consensus_data'] as { votes?: Record<string, string> } | undefined)?.votes ?? {};
          const values = Object.values(votes);
          out.push({
            hash: String(row['hash']),
            ref,
            contract,
            nonce,
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
    }
    return any ? out.sort((a, b) => b.nonce - a.nonce) : null;
  }

  /**
   * The adjudication transaction for an intent, preferring one that reached consensus. `legacyNonce` also
   * matches earlier nonce-only submissions (a bare numeric ref).
   */
  async findAdjudication(ref: string, legacyNonce?: number): Promise<Adjudication | null> {
    const all = await this.adjudications();
    if (!all) return null;
    const matches = all.filter((a) => a.ref === ref || (legacyNonce !== undefined && a.ref === String(legacyNonce)));
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
