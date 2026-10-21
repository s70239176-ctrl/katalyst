import { useState, type ReactNode } from 'react';

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? 'Loading'} />;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'bad' | 'warn' | 'info'; children: ReactNode; title?: string }) {
  const cls = tone === 'ok' ? 'badge-ok' : tone === 'bad' ? 'badge-bad' : tone === 'warn' ? 'badge-warn' : tone === 'info' ? 'badge-info' : '';
  return (
    <span className={`badge ${cls}`} {...(title ? { title } : {})}>
      {children}
    </span>
  );
}

export function ExternalLink({ href, children, mono = false }: { href: string; children: ReactNode; mono?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1 text-info underline-offset-2 hover:underline ${mono ? 'mono' : ''}`}
    >
      {children}
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm !h-6 !px-1.5 text-xs"
      aria-label={`${label}: ${value}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          })
          .catch(() => undefined);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card px-5 py-4">
      <div className="card-title">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-subtle">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full border border-line2 text-subtle" aria-hidden="true">
        ○
      </div>
      <p className="font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone, title, children, action }: { tone: 'warn' | 'bad' | 'info'; title: string; children?: ReactNode; action?: ReactNode }) {
  const color = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--info)';
  const bg = tone === 'bad' ? 'var(--danger-soft)' : tone === 'warn' ? 'var(--warn-soft)' : 'var(--info-soft)';
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className="flex items-start justify-between gap-4 rounded-xl border px-4 py-3" style={{ borderColor: color, background: bg }}>
      <div>
        <p className="text-sm font-medium" style={{ color }}>
          {title}
        </p>
        {children && <p className="mt-0.5 text-sm text-muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}
