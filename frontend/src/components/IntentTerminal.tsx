import { useMemo, useRef, type UIEvent } from 'react';
import { TOKEN_SYMBOL, formatPot, parsePot } from '../utils/types';
import { Spinner } from './ui';

const TOKEN_RE = new RegExp(
  [
    String.raw`(?<c>\b[A-C]\s*-\s*Tier(?:\s+Carbon)?\b|\bmax(?:imum|imi[sz]e)?\s+(?:yield|apy|return)\b|\b(?:min(?:imum)?\s+)?\d+(?:\.\d+)?\s*%\s*APY\b|\b(?:low|medium|high|zero)\s+(?:risk|carbon)\b)`,
    String.raw`(?<a>\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:\$?t?POT|USD[CT]?|tokens?)\b)`,
  ].join('|'),
  'gi',
);

type Segment = { text: string; kind: 'plain' | 'amount' | 'constraint' };

function tokenize(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), kind: 'plain' });
    out.push({ text: m[0], kind: m.groups?.['c'] ? 'constraint' : 'amount' });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}

export const EXAMPLES: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: 'Max yield, A-Tier only', prompt: 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.' },
  { label: 'Diversify across green pools', prompt: 'Split across the greenest pools. A-Tier only.' },
  { label: 'Highest yield, any tier', prompt: 'Max yield, I accept any eco tier.' },
];

/** Typical network fee on the Portaldot testnet (gas + a storage deposit that is refunded to you). */
const FEE_ESTIMATE = 4;
/** Balance the chain reserves up-front for gas before refunding the unused part. */
const UPFRONT_RESERVE = 9;

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

interface IntentTerminalProps {
  prompt: string;
  onPromptChange: (v: string) => void;
  amount: string;
  onAmountChange: (v: string) => void;
  /** Free balance in wei, null when no wallet is connected. */
  balance: bigint | null;
  canSubmit: boolean;
  busy: boolean;
  disabledReason?: string;
  preview: PreviewState;
  onPreview: () => void;
  onSubmit: () => void;
}

export function IntentTerminal({
  prompt,
  onPromptChange,
  amount,
  onAmountChange,
  balance,
  canSubmit,
  busy,
  disabledReason,
  preview,
  onPreview,
  onSubmit,
}: IntentTerminalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => tokenize(prompt), [prompt]);

  let wei: bigint | null = null;
  try {
    wei = parsePot(amount);
  } catch {
    wei = null;
  }
  const amountValid = wei !== null && wei > 0n;
  const requiredReserve = BigInt(UPFRONT_RESERVE) * 10n ** 18n;
  const short = balance !== null && wei !== null && balance < wei + requiredReserve;
  const promptReady = prompt.trim().length > 0;

  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  const setMax = () => {
    if (balance === null) return;
    const room = balance > requiredReserve ? balance - requiredReserve : 0n;
    onAmountChange(formatPot(room, 4).replace(/,/g, ''));
  };

  return (
    <section className="card p-6" aria-labelledby="composer-title">
      <div className="flex items-baseline justify-between">
        <h2 id="composer-title" className="text-lg font-semibold tracking-tight">
          Describe what you want
        </h2>
        <span className="text-xs tabular-nums text-subtle">{prompt.length}/2048</span>
      </div>
      <p className="mt-1 text-sm text-muted">
        Plain language is fine. Validators on GenLayer read it, pick pools, and agree on a route before any funds move.
      </p>

      <div className="relative mt-4 rounded-xl border border-line2 bg-bg focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-3.5 text-[15px] leading-relaxed"
        >
          {segments.map((s, i) =>
            s.kind === 'plain' ? (
              <span key={i}>{s.text}</span>
            ) : (
              <span key={i} className="rounded-sm" style={{ background: s.kind === 'amount' ? 'var(--accent-soft)' : 'var(--info-soft)' }}>
                {s.text}
              </span>
            ),
          )}
          {'\n'}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value.slice(0, 2048))}
          onScroll={sync}
          spellCheck={false}
          rows={5}
          aria-label="Intent"
          placeholder="e.g. Maximize yield, but only pools with an A-Tier carbon score."
          className="relative block w-full resize-y whitespace-pre-wrap break-words bg-transparent p-3.5 text-[15px] leading-relaxed text-transparent caret-[var(--fg)] outline-none placeholder:text-subtle"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex.label} type="button" className="badge cursor-pointer hover:border-subtle hover:text-fg" onClick={() => onPromptChange(ex.prompt)}>
            {ex.label}
          </button>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label htmlFor="amount" className="mb-1.5 flex items-baseline justify-between text-sm font-medium">
            <span>Amount to deposit</span>
            {balance !== null && <span className="text-xs font-normal text-subtle">Balance {formatPot(balance)} {TOKEN_SYMBOL}</span>}
          </label>
          <div className="relative">
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value.trim())}
              aria-invalid={!amountValid}
              aria-describedby="amount-help"
              className="input pr-24 text-right tabular-nums"
            />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle">{TOKEN_SYMBOL}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {['1', '5', '10'].map((v) => (
            <button key={v} type="button" className="btn btn-sm" onClick={() => onAmountChange(v)}>
              {v}
            </button>
          ))}
          <button type="button" className="btn btn-sm" onClick={setMax} disabled={balance === null}>
            Max
          </button>
        </div>
      </div>

      <p id="amount-help" className="mt-2 text-xs text-subtle">
        Estimated network fee ≈ {FEE_ESTIMATE} {TOKEN_SYMBOL}, including a storage deposit that the relayer returns to you after settlement. Keep about {UPFRONT_RESERVE} {TOKEN_SYMBOL} spare for gas.
      </p>
      {short && (
        <p role="status" className="mt-2 text-sm text-warn">
          Your balance may not cover this deposit plus gas.
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <button type="button" className="btn" onClick={onPreview} disabled={!promptReady || preview.status === 'loading'}>
          {preview.status === 'loading' ? (
            <>
              <Spinner label="Previewing" /> Asking validators…
            </>
          ) : (
            'Preview verdict (free)'
          )}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={!canSubmit || busy || !amountValid || !promptReady}>
          {busy ? 'Waiting for confirmation…' : 'Deposit & submit'}
        </button>
      </div>
      {!canSubmit && disabledReason && <p className="mt-3 text-sm text-warn">{disabledReason}</p>}
      {preview.status === 'error' && (
        <p role="alert" className="mt-3 text-sm text-danger">
          Preview failed: {preview.message}
        </p>
      )}
    </section>
  );
}
