import { useCallback, useEffect, useState } from 'react';
import { fetchUserVerdicts } from '../utils/api';
import { activeChain, tokenSymbol } from '../utils/chains';
import { fetchUserIntents } from '../utils/history';
import { formatPot, type UserIntent, type VerdictRecord, type WalletState } from '../utils/types';
import { Badge, EmptyState, Skeleton } from './ui';

interface ActivityPageProps {
  wallet: WalletState | null;
  onConnect: () => void;
  onOpen: (intent: UserIntent, record: VerdictRecord | null) => void;
  /** Bumped by the parent when a new intent settles so the list refreshes. */
  refreshKey: number;
}

const statusTone = (s: string) => (s === 'Executed' ? 'ok' : s === 'Rejected' ? 'bad' : s === 'Cancelled' || s === 'Expired' || s === 'Vetoed' ? 'warn' : 'info');

export function ActivityPage({ wallet, onConnect, onOpen, refreshKey }: ActivityPageProps) {
  const [rows, setRows] = useState<UserIntent[] | null>(null);
  const [records, setRecords] = useState<Map<number, VerdictRecord>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      const [intents, verdicts] = await Promise.all([fetchUserIntents(wallet.address), fetchUserVerdicts(wallet.address)]);
      setRows(intents);
      setRecords(new Map(verdicts.map((v) => [v.nonce, v])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!wallet) {
    return (
      <div className="card">
        <EmptyState title="Connect a wallet to see your activity" action={<button type="button" className="btn btn-primary" onClick={onConnect}>Connect wallet</button>}>
          Your history is read directly from onchain vault events.
        </EmptyState>
      </div>
    );
  }

  return (
    <section className="card" aria-labelledby="activity-title">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h2 id="activity-title" className="text-lg font-semibold tracking-tight">
            Your intents
          </h2>
          <p className="text-sm text-muted">Read from vault events on {activeChain().name}. Select a row for the full receipt.</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p role="alert" className="px-5 py-4 text-sm text-danger">
          {error}
        </p>
      )}

      {rows === null && !error ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : rows && rows.length === 0 ? (
        <EmptyState title="No intents yet">Submit your first intent from the Intent tab.</EmptyState>
      ) : (
        rows && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Intent</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = r.outcome?.status ?? 'Pending';
                  return (
                    <tr
                      key={r.nonce}
                      className="row-link"
                      tabIndex={0}
                      onClick={() => onOpen(r, records.get(r.nonce) ?? null)}
                      onKeyDown={(e) => e.key === 'Enter' && onOpen(r, records.get(r.nonce) ?? null)}
                    >
                      <td className="tabular-nums text-muted">{r.nonce}</td>
                      <td className="max-w-[26rem] truncate">{r.prompt}</td>
                      <td className="text-right tabular-nums">
                        {formatPot(r.amount)} <span className="text-subtle">{tokenSymbol()}</span>
                      </td>
                      <td>
                        <Badge tone={statusTone(status)}>{status === 'Pending' ? 'In progress' : status}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}
