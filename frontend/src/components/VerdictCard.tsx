import { poolLabel, shortAddress, type VerdictLeg, type VerdictTrace } from '../utils/types';
import { Badge } from './ui';

interface VerdictCardProps {
  status: 'APPROVED' | 'REJECTED';
  reason?: string | undefined;
  allocations: VerdictLeg[];
  trace: VerdictTrace | null;
  /** Shown as a note above the table, e.g. "Preview — nothing was deposited". */
  note?: string;
}

const COLORS = ['var(--accent)', 'var(--info)', 'var(--warn)', '#b794f6'] as const;

export function VerdictCard({ status, reason, allocations, trace, note }: VerdictCardProps) {
  const approved = status === 'APPROVED';
  const c = trace?.constraints;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={approved ? 'ok' : 'bad'}>{approved ? 'Approved' : 'Rejected'}</Badge>
          {trace?.screen && (
            <Badge tone={trace.screen.startsWith('blocked') ? 'bad' : 'info'} title="Static prompt-injection screen">
              Guardrail: {trace.screen.startsWith('blocked') ? 'blocked' : 'passed'}
            </Badge>
          )}
        </div>
        {note && <span className="text-xs text-subtle">{note}</span>}
      </div>

      {!approved && reason && (
        <p className="rounded-lg border border-line bg-surface2 px-3 py-2.5 text-sm">
          <span className="text-muted">Reason: </span>
          {reason}
        </p>
      )}

      {c && (
        <section aria-label="Parsed constraints">
          <div className="card-title mb-2">Understood from your intent</div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={c.min_eco_tier ? 'info' : 'neutral'}>
              Eco tier: {c.min_eco_tier ? `${c.min_eco_tier}-Tier or better` : 'any'}
            </Badge>
            <Badge tone={c.min_apy !== null ? 'info' : 'neutral'}>
              Min APY: {c.min_apy !== null ? `${c.min_apy}%` : 'none'}
            </Badge>
            <Badge tone={c.maximize_yield ? 'info' : 'neutral'}>Strategy: {c.maximize_yield ? 'Maximise yield' : 'Diversify by APY'}</Badge>
          </div>
        </section>
      )}

      {approved && allocations.length > 0 && (
        <section aria-label="Allocation">
          <div className="card-title mb-2">Allocation</div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface2" role="img" aria-label={allocations.map((a) => `${poolLabel(a.target_pool)} ${a.percentage}%`).join(', ')}>
            {allocations.map((a, i) => (
              <div key={a.target_pool} style={{ width: `${a.percentage}%`, background: COLORS[i % COLORS.length] }} />
            ))}
          </div>
        </section>
      )}

      {trace && trace.pools.length > 0 && (
        <section aria-label="Pool decisions" className="overflow-x-auto rounded-xl border border-line">
          <table className="table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>APY</th>
                <th>Eco</th>
                <th>Decision</th>
                <th className="text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {trace.pools.map((p) => (
                <tr key={p.address}>
                  <td>
                    <div className="font-medium">{poolLabel(p.address)}</div>
                    <div className="mono text-xs text-subtle">{shortAddress(p.address)}</div>
                  </td>
                  <td className="tabular-nums">{p.apy.toFixed(1)}%</td>
                  <td>
                    <Badge tone={p.eco.startsWith('A') ? 'ok' : p.eco.startsWith('B') ? 'info' : 'warn'}>{p.eco}</Badge>
                  </td>
                  <td className="wrap">
                    <span className={p.decision === 'selected' ? 'text-accent' : 'text-muted'}>{p.decision === 'selected' ? 'Selected' : 'Excluded'}</span>
                    <div className="text-xs text-subtle">{p.reason}</div>
                  </td>
                  <td className="text-right font-medium tabular-nums">{p.percentage > 0 ? `${p.percentage}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
