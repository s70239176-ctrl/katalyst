import { useEffect, useState } from 'react';
import type { Adjudication } from '../sdk';
import { GENLAYER_CONTRACT, GENLAYER_EXPLORER } from '../utils/genlayer';
import { getKatalyst } from '../utils/katalyst';
import { explorerBlockUrl } from '../utils/substrate';
import { TOKEN_SYMBOL, formatPot, shortAddress, shortHash, type UserIntent, type VerdictRecord } from '../utils/types';
import { VerdictCard } from './VerdictCard';
import { Badge, ExternalLink } from './ui';

interface GreyboxModalProps {
  intent: UserIntent | null;
  /** Relayer-side record (validator votes, decision trace, GenLayer link) when available. */
  record: VerdictRecord | null;
  onClose: () => void;
  /** Navigate to the verify or receipt page for this intent. */
  onNavigate?: (page: 'verify' | 'receipt', nonce: number) => void;
}

/** Full receipt for one intent: consensus, guardrail result, route and every transaction link. */
export function GreyboxModal({ intent, record, onClose, onNavigate }: GreyboxModalProps) {
  // Without a relayer record (e.g. serverless history), read the validators' votes from GenLayer itself.
  const [adj, setAdj] = useState<Adjudication | null>(null);
  const nonce = intent?.nonce ?? null;
  useEffect(() => {
    setAdj(null);
    if (nonce === null || record?.genlayer || !GENLAYER_CONTRACT) return;
    let cancelled = false;
    getKatalyst()
      .genlayer?.findAdjudication(nonce)
      .then((a) => !cancelled && setAdj(a))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nonce, record?.genlayer]);

  useEffect(() => {
    if (!intent) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [intent, onClose]);

  if (!intent) return null;

  const gl =
    record?.genlayer ??
    (adj ? { txHash: adj.hash, explorerUrl: `${GENLAYER_EXPLORER}/tx/${adj.hash}`, validatorsAgreed: adj.agreed, validatorsTotal: adj.total, votes: adj.votes } : undefined);
  const verdict = record?.verdict;
  const threats = verdict?.trace?.screen.startsWith('blocked') ? 1 : 0;
  const outcome = intent.outcome;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="receipt-title" className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="card-title">Intent receipt</div>
            <h3 id="receipt-title" className="mt-1 text-xl font-semibold tracking-tight">
              Intent #{intent.nonce}
            </h3>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <p className="mt-3 rounded-lg border border-line bg-surface2 px-3 py-2.5 text-sm">{intent.prompt}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="neutral">
            {formatPot(intent.amount)} {TOKEN_SYMBOL}
          </Badge>
          {outcome && <Badge tone={outcome.status === 'Executed' ? 'ok' : outcome.status === 'Rejected' ? 'bad' : 'warn'}>{outcome.status}</Badge>}
          {gl ? (
            <Badge tone="ok" title="Validators that voted agree on the leader's result">
              {gl.validatorsAgreed}/{gl.validatorsTotal} validators agreed
            </Badge>
          ) : (
            <Badge tone="neutral" title="The relayer has no consensus record for this intent">
              Consensus details unavailable
            </Badge>
          )}
          {verdict && <Badge tone={threats === 0 ? 'info' : 'bad'}>{threats} threat vectors detected</Badge>}
        </div>

        <div className="mt-6">
          {verdict ? (
            <VerdictCard status={verdict.approved ? 'APPROVED' : 'REJECTED'} reason={verdict.reason} allocations={verdict.allocations} trace={verdict.trace} />
          ) : outcome?.route ? (
            <div className="space-y-2">
              <div className="card-title">Settled route</div>
              {outcome.route.map((leg) => (
                <div key={leg.targetPool} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                  <span>
                    {shortAddress(leg.targetPool)} <span className="text-subtle">· {leg.ecoScore}</span>
                  </span>
                  <span className="tabular-nums">
                    {leg.percentage}% · {formatPot(leg.amount)} {TOKEN_SYMBOL}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {gl && Object.keys(gl.votes).length > 0 && (
          <section className="mt-6" aria-label="Validator votes">
            <div className="card-title mb-2">Validator votes</div>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {Object.entries(gl.votes).map(([addr, vote]) => (
                <li key={addr} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-sm">
                  <span className="mono text-muted">{shortAddress(addr)}</span>
                  <Badge tone={vote.toLowerCase() === 'agree' ? 'ok' : vote.toLowerCase() === 'idle' ? 'neutral' : 'bad'}>{vote}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6" aria-label="Transactions">
          <div className="card-title mb-2">Transactions</div>
          <dl className="space-y-1.5 text-sm">
            <Row label="Deposit">
              <ExternalLink href={explorerBlockUrl(intent.depositBlock)} mono>
                {shortHash(intent.depositTx)}
              </ExternalLink>
            </Row>
            {gl && (
              <Row label="GenLayer consensus">
                <ExternalLink href={gl.explorerUrl} mono>
                  {shortHash(gl.txHash)}
                </ExternalLink>
              </Row>
            )}
            {outcome && (
              <Row label={outcome.status === 'Executed' ? 'Settlement' : outcome.status}>
                <ExternalLink href={explorerBlockUrl(outcome.blockNumber)} mono>
                  {shortHash(outcome.txHash)}
                </ExternalLink>
              </Row>
            )}
            {record?.refund && (
              <Row label="Storage refund returned">
                <span className="tabular-nums">
                  {formatPot(BigInt(record.refund.amount))} {TOKEN_SYMBOL}
                </span>
              </Row>
            )}
          </dl>
        </section>

        {onNavigate && outcome && (
          <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
            <button type="button" className="btn btn-sm" onClick={() => onNavigate('verify', intent.nonce)}>
              Verify independently
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onNavigate('receipt', intent.nonce)}>
              Share receipt
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-1.5 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
