import type { ReactNode } from 'react';
import { Spinner } from './ui';

export type StepState = 'done' | 'active' | 'pending' | 'failed';

export interface Step {
  title: string;
  state: StepState;
  /** Supporting line, e.g. "4/5 validators agreed". */
  detail?: ReactNode;
}

function Marker({ state, index }: { state: StepState; index: number }) {
  if (state === 'active') {
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full border border-accent bg-[var(--accent-soft)]">
        <Spinner label="In progress" />
      </span>
    );
  }
  const style =
    state === 'done'
      ? 'border-accent bg-accent text-[var(--accent-ink)]'
      : state === 'failed'
        ? 'border-danger bg-[var(--danger-soft)] text-danger'
        : 'border-line2 text-subtle';
  return (
    <span className={`grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold ${style}`} aria-hidden="true">
      {state === 'done' ? '✓' : state === 'failed' ? '!' : index + 1}
    </span>
  );
}

/** Vertical lifecycle tracker: deposit → consensus → settlement. */
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-0" aria-label="Intent lifecycle">
      {steps.map((s, i) => (
        <li key={s.title} className="relative flex gap-3 pb-5 last:pb-0" aria-current={s.state === 'active' ? 'step' : undefined}>
          {i < steps.length - 1 && (
            <span
              className="absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px"
              style={{ background: s.state === 'done' ? 'var(--accent)' : 'var(--line-2)' }}
              aria-hidden="true"
            />
          )}
          <Marker state={s.state} index={i} />
          <div className="min-w-0 pt-0.5">
            <p className={`text-sm font-medium ${s.state === 'pending' ? 'text-subtle' : ''}`}>{s.title}</p>
            {s.detail && <div className="mt-0.5 text-sm text-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
