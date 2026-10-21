import { useCallback, useEffect, useState } from 'react';
import type { Check, CheckStatus, ProofBundle } from '../sdk';
import { getKatalyst, katalystConfigured } from '../utils/katalyst';
import { explorerBlockUrl } from '../utils/substrate';
import { shortAddress, shortHash } from '../utils/types';
import { GENLAYER_EXPLORER } from '../utils/genlayer';
import { Badge, ExternalLink, Notice, Spinner } from './ui';

const ICON: Record<CheckStatus, { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: 'var(--accent)' },
  fail: { glyph: '✕', color: 'var(--danger)' },
  warn: { glyph: '!', color: 'var(--warn)' },
  skip: { glyph: '–', color: 'var(--subtle)' },
};

const VERDICT: Record<ProofBundle['verdict'], { label: string; tone: 'ok' | 'bad' | 'warn' | 'neutral'; text: string }> = {
  verified: { label: 'Verified', tone: 'ok', text: 'Every check passed against the on-chain evidence.' },
  failed: { label: 'Failed', tone: 'bad', text: 'At least one check failed. Review the details below.' },
  pending: { label: 'Pending', tone: 'warn', text: 'This intent has not been settled yet.' },
  not_found: { label: 'Not found', tone: 'neutral', text: 'No deposit exists for this intent number.' },
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface VerifyPageProps {
  initialNonce: number | null;
  onNavigate: (page: 'verify' | 'receipt', nonce?: number) => void;
}

/** Re-derives an intent's outcome from independent on-chain evidence and shows each check. */
export function VerifyPage({ initialNonce, onNavigate }: VerifyPageProps) {
  const [input, setInput] = useState(initialNonce ? String(initialNonce) : '');
  const [rerun, setRerun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<ProofBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (nonce: number, withRerun: boolean) => {
      setBusy(true);
      setError(null);
      setProof(null);
      try {
        setProof(await getKatalyst().verify(nonce, { rerun: withRerun }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed to run');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialNonce) {
      setInput(String(initialNonce));
      if (katalystConfigured()) void run(initialNonce, false);
    }
  }, [initialNonce, run]);

  const parsed = Number(input);
  const valid = Number.isSafeInteger(parsed) && parsed >= 1;

  const submit = () => {
    if (!valid) return;
    onNavigate('verify', parsed);
    void run(parsed, rerun);
  };

  const v = proof ? VERDICT[proof.verdict] : null;
  const counts = proof ? { pass: proof.checks.filter((c) => c.status === 'pass').length, total: proof.checks.filter((c) => c.status !== 'skip').length } : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="card p-6" aria-labelledby="verify-title">
        <h2 id="verify-title" className="text-lg font-semibold tracking-tight">
          Verify an intent
        </h2>
        <p className="mt-1 text-sm text-muted">
          Don't take our word for it. This page re-derives the outcome from the vault's on-chain events and the GenLayer validators' own records, then checks that they agree with each other. Nothing here comes from Katalyst's servers.
        </p>
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="min-w-[10rem] flex-1">
            <label htmlFor="verify-nonce" className="mb-1.5 block text-sm font-medium">
              Intent number
            </label>
            <input id="verify-nonce" className="input tabular-nums" inputMode="numeric" placeholder="e.g. 8" value={input} onChange={(e) => setInput(e.target.value.trim())} aria-invalid={input !== '' && !valid} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!valid || busy || !katalystConfigured()}>
            {busy ? (
              <>
                <Spinner label="Verifying" /> Verifying…
              </>
            ) : (
              'Verify'
            )}
          </button>
        </form>
        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />
          Also re-run the adjudication now and compare (takes a few seconds)
        </label>
        {!katalystConfigured() && <p className="mt-3 text-sm text-warn">The vault address is not configured for this deployment.</p>}
      </section>

      {error && <Notice tone="bad" title="Could not verify">{error}</Notice>}

      {proof && v && counts && (
        <>
          <section className="card p-6" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Badge tone={v.tone}>{v.label}</Badge>
                <span className="text-sm text-muted">{v.text}</span>
              </div>
              <span className="text-sm tabular-nums text-subtle">
                {counts.pass}/{counts.total} checks passed
              </span>
            </div>

            <ul className="mt-5 divide-y divide-line">
              {proof.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              <button type="button" className="btn btn-sm" onClick={() => download(`katalyst-proof-intent-${proof.nonce}.json`, JSON.stringify(proof, null, 2))}>
                Download proof (JSON)
              </button>
              {proof.settlement && (
                <button type="button" className="btn btn-sm" onClick={() => onNavigate('receipt', proof.nonce)}>
                  View impact receipt
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/verify/${proof.nonce}`)}>
                Copy link
              </button>
            </div>
          </section>

          <Evidence proof={proof} />
        </>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  const i = ICON[check.status];
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold" style={{ color: i.color, border: `1px solid ${i.color}` }} aria-hidden="true">
        {i.glyph}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {check.label} <span className="sr-only">({check.status})</span>
        </p>
        <p className="text-sm text-muted">{check.detail}</p>
      </div>
    </li>
  );
}

function Evidence({ proof }: { proof: ProofBundle }) {
  return (
    <section className="card p-6" aria-labelledby="evidence-title">
      <h3 id="evidence-title" className="card-title mb-3">
        Evidence
      </h3>
      <dl className="space-y-2 text-sm">
        {proof.deposit && (
          <Row label="Deposit">
            <ExternalLink href={explorerBlockUrl(proof.deposit.blockNumber)} mono>
              {shortHash(proof.deposit.txHash)}
            </ExternalLink>{' '}
            <span className="text-subtle">by {shortAddress(proof.deposit.user)}</span>
          </Row>
        )}
        {proof.genlayer?.txHash && (
          <Row label="GenLayer consensus">
            <ExternalLink href={`${GENLAYER_EXPLORER}/tx/${proof.genlayer.txHash}`} mono>
              {shortHash(proof.genlayer.txHash)}
            </ExternalLink>{' '}
            <span className="text-subtle">
              {proof.genlayer.agreed}/{proof.genlayer.total} agree
            </span>
          </Row>
        )}
        {proof.settlement && (
          <Row label={proof.settlement.kind === 'executed' ? 'Settlement' : proof.settlement.kind === 'rejected' ? 'Refund (rejected)' : proof.settlement.kind === 'expired' ? 'Refund (timed out)' : proof.settlement.kind === 'vetoed' ? 'Refund (vetoed)' : 'Refund (cancelled)'}>
            <ExternalLink href={explorerBlockUrl(proof.settlement.blockNumber)} mono>
              block {proof.settlement.blockNumber}
            </ExternalLink>
          </Row>
        )}
        <Row label="Vault">
          <span className="mono break-all">{proof.network.vault}</span>
        </Row>
        {proof.network.genlayerContract && (
          <Row label="Solver">
            <span className="mono break-all">{proof.network.genlayerContract}</span>
          </Row>
        )}
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
