import { useEffect, useState } from 'react';
import type { ValidatorStat } from '../sdk';
import { getKatalyst } from '../utils/katalyst';
import { GENLAYER_CONTRACT } from '../utils/genlayer';
import { shortAddress } from '../utils/types';
import { Badge, Skeleton } from './ui';

type State = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; stats: ValidatorStat[]; intents: number };

/**
 * GenLayer validator participation, computed from the solver's transaction records (no database):
 * how often each validator voted agree, and how often it sat out ("idle").
 */
export function ValidatorsCard({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (!GENLAYER_CONTRACT) {
      setState({ status: 'unavailable' });
      return;
    }
    let cancelled = false;
    getKatalyst()
      .validators()
      .then((res) => {
        if (cancelled) return;
        if (!res) setState({ status: 'unavailable' });
        else setState({ status: 'ready', stats: res.stats, intents: new Set(res.adjudications.map((a) => a.nonce)).size });
      })
      .catch(() => !cancelled && setState({ status: 'unavailable' }));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section className="card" aria-labelledby="validators-title">
      <div className="border-b border-line px-5 py-4">
        <h2 id="validators-title" className="text-base font-semibold">
          GenLayer validators
        </h2>
        <p className="text-sm text-muted">
          Who actually voted on Katalyst verdicts. "Idle" means a validator did not take part in that round; the verdict still stands when a majority agrees.
        </p>
      </div>

      {state.status === 'loading' && (
        <div className="space-y-3 p-5">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      )}

      {state.status === 'unavailable' && <p className="px-5 py-6 text-sm text-muted">This GenLayer network does not expose a transaction listing, so participation cannot be computed here.</p>}

      {state.status === 'ready' && state.stats.length === 0 && <p className="px-5 py-6 text-sm text-muted">No adjudications have reached consensus yet.</p>}

      {state.status === 'ready' && state.stats.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Validator</th>
                  <th className="text-right">Rounds</th>
                  <th>Agreement</th>
                  <th className="text-right">Idle</th>
                </tr>
              </thead>
              <tbody>
                {state.stats.map((s) => (
                  <tr key={s.address}>
                    <td>
                      <span className="mono">{shortAddress(s.address)}</span>
                    </td>
                    <td className="text-right tabular-nums">{s.participations}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${Math.round(s.reliability * 100)}% agree`}>
                          <div className="h-full" style={{ width: `${s.reliability * 100}%`, background: s.reliability >= 0.75 ? 'var(--accent)' : s.reliability >= 0.4 ? 'var(--warn)' : 'var(--danger)' }} />
                        </div>
                        <span className="tabular-nums text-sm">{Math.round(s.reliability * 100)}%</span>
                      </div>
                    </td>
                    <td className="text-right">{s.idle > 0 ? <Badge tone={s.idle / s.participations > 0.5 ? 'warn' : 'neutral'}>{s.idle}</Badge> : <span className="text-subtle">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-5 py-3 text-xs text-subtle">Across {state.intents} adjudicated intent{state.intents === 1 ? '' : 's'}, from the solver's own GenLayer transactions.</p>
        </>
      )}
    </section>
  );
}
