import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type IntentPhase = 'adjudicating' | 'settling' | 'executed' | 'rejected' | 'failed';

export interface ChainRef {
  txHash: string;
  explorerUrl: string;
  blockNumber?: number;
}

/** Everything the relayer knows about one intent, served to the dApp by the read-only API. */
export interface VerdictRecord {
  nonce: number;
  user: string;
  /** wei, decimal string */
  amount: string;
  prompt: string;
  phase: IntentPhase;
  error?: string;
  receivedAt: number;
  updatedAt: number;
  genlayer?: ChainRef & {
    validatorsAgreed: number;
    validatorsTotal: number;
    votes: Record<string, string>;
  };
  verdict?: {
    approved: boolean;
    reason?: string;
    allocations: Array<{ target_pool: string; percentage: number; eco_score: string }>;
    trace: unknown;
  };
  portaldot?: ChainRef;
  refund?: { amount: string; txHash: string };
}

const FILE = path.resolve(process.env['RELAYER_DATA_DIR'] ?? 'data', 'verdicts.json');

/** Small JSON-file store: survives restarts, no external database needed for a single relayer. */
export class VerdictStore {
  private records = new Map<number, VerdictRecord>();

  constructor() {
    try {
      if (existsSync(FILE)) {
        const rows = JSON.parse(readFileSync(FILE, 'utf8')) as VerdictRecord[];
        for (const r of rows) this.records.set(r.nonce, r);
      }
    } catch (err) {
      console.error('[STORE] could not load verdicts.json, starting empty:', err instanceof Error ? err.message : err);
    }
  }

  get(nonce: number): VerdictRecord | undefined {
    return this.records.get(nonce);
  }

  list(limit = 100): VerdictRecord[] {
    return [...this.records.values()].sort((a, b) => b.nonce - a.nonce).slice(0, limit);
  }

  upsert(nonce: number, patch: Partial<VerdictRecord> & Pick<VerdictRecord, 'user' | 'amount' | 'prompt'>): VerdictRecord {
    const now = Date.now();
    const prev = this.records.get(nonce);
    const next: VerdictRecord = {
      phase: 'adjudicating',
      receivedAt: now,
      ...prev,
      ...patch,
      nonce,
      updatedAt: now,
    };
    this.records.set(nonce, next);
    this.flush();
    return next;
  }

  private flush(): void {
    try {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify([...this.records.values()], null, 2));
    } catch (err) {
      console.error('[STORE] flush failed:', err instanceof Error ? err.message : err);
    }
  }
}
