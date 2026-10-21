import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProofBundle } from '../sdk';
import { getKatalyst, katalystConfigured } from '../utils/katalyst';
import { tokenSymbol } from '../utils/chains';
import { formatPot, poolLabel } from '../utils/types';
import { Notice, Spinner } from './ui';

const W = 1200;
const H = 630;
const SEG = ['#3dd6a6', '#6aa9ff', '#f5b84b', '#b794f6'];

/** Fraction (0..100) of the deposit routed to A-Tier pools. */
export function aTierShare(proof: ProofBundle): number | null {
  const legs = proof.settlement?.legs;
  if (!legs?.length || proof.settlement?.kind !== 'executed') return null;
  return legs.filter((l) => l.eco.toUpperCase().startsWith('A')).reduce((s, l) => s + l.pct, 0);
}

function wrap(text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      out.push(cur.trim());
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = kept[lines - 1]!.slice(0, max - 1).trimEnd() + '…';
    return kept;
  }
  return out;
}

function ImpactCard({ proof, svgRef }: { proof: ProofBundle; svgRef: React.RefObject<SVGSVGElement | null> }) {
  const d = proof.deposit!;
  const s = proof.settlement!;
  const amount = BigInt(d.amountWei);
  const share = aTierShare(proof);
  const verified = proof.verdict === 'verified';
  const gl = proof.genlayer;
  const lines = wrap(d.prompt, 62, 3);
  const executed = s.kind === 'executed';

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Impact receipt for intent ${proof.nonce}`} xmlns="http://www.w3.org/2000/svg" fontFamily="Inter, system-ui, -apple-system, Segoe UI, sans-serif">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0f151d" />
          <stop offset="1" stopColor="#0a0d12" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} rx="28" fill="url(#bg)" />
      <rect x="1" y="1" width={W - 2} height={H - 2} rx="27" fill="none" stroke="#212a38" strokeWidth="2" />

      <rect x="64" y="60" width="44" height="44" rx="11" fill="#3dd6a6" />
      <text x="86" y="92" textAnchor="middle" fontSize="26" fontWeight="700" fill="#04120c">K</text>
      <text x="124" y="80" fontSize="24" fontWeight="600" fill="#e8edf4">Katalyst</text>
      <text x="124" y="102" fontSize="14" letterSpacing="2" fill="#6c788b">IMPACT RECEIPT</text>

      {verified && (
        <g>
          <rect x={W - 340} y="62" width="276" height="40" rx="20" fill="rgba(61,214,166,0.14)" />
          <text x={W - 202} y="88" textAnchor="middle" fontSize="18" fontWeight="600" fill="#3dd6a6">✓ Independently verified</text>
        </g>
      )}

      <text x="64" y="190" fontSize="64" fontWeight="700" fill="#e8edf4">
        {formatPot(amount)} {tokenSymbol()}
      </text>
      <text x="64" y="232" fontSize="22" fill="#9ba6b6">
        {executed ? `routed by GenLayer consensus · Intent #${proof.nonce}` : `${s.kind} and refunded · Intent #${proof.nonce}`}
      </text>

      {lines.map((l, i) => (
        <text key={i} x="64" y={282 + i * 30} fontSize="22" fontStyle="italic" fill="#c5cedb">
          {i === 0 ? '“' : ''}
          {l}
          {i === lines.length - 1 ? '”' : ''}
        </text>
      ))}

      {executed && (
        <g>
          <text x="64" y="404" fontSize="14" letterSpacing="2" fill="#6c788b">ROUTE</text>
          {(() => {
            let x = 64;
            return s.legs.map((leg, i) => {
              const w = ((W - 128) * leg.pct) / 100;
              const seg = <rect key={leg.pool} x={x} y="418" width={Math.max(w - 3, 2)} height="16" rx="8" fill={SEG[i % SEG.length]} />;
              x += w;
              return seg;
            });
          })()}
          {s.legs.map((leg, i) => (
            <g key={`t-${leg.pool}`}>
              <circle cx={74 + i * 300} cy="470" r="7" fill={SEG[i % SEG.length]} />
              <text x={90 + i * 300} y="476" fontSize="20" fill="#e8edf4">
                {poolLabel(leg.pool)} · {leg.pct}% · {leg.eco}
              </text>
            </g>
          ))}
        </g>
      )}

      <line x1="64" y1="520" x2={W - 64} y2="520" stroke="#212a38" strokeWidth="2" />
      <text x="64" y="568" fontSize="20" fill="#9ba6b6">
        {share !== null ? `${share}% in A-Tier pools` : 'Deposit returned in full'}
        {gl && gl.total > 0 ? `  ·  ${gl.agreed}/${gl.total} validators agreed` : ''}
      </text>
      <text x={W - 64} y="568" textAnchor="end" fontSize="16" fill="#6c788b">
        Portaldot V3 Testnet · block {s.blockNumber}
      </text>
    </svg>
  );
}

async function svgToPng(svg: SVGSVGElement): Promise<Blob> {
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface ReceiptPageProps {
  nonce: number | null;
  onNavigate: (page: 'verify' | 'receipt' | 'intent', nonce?: number) => void;
}

/** A shareable, independently verifiable receipt for one settled intent. */
export function ReceiptPage({ nonce, onNavigate }: ReceiptPageProps) {
  const [proof, setProof] = useState<ProofBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!nonce || !katalystConfigured()) return;
    let cancelled = false;
    setProof(null);
    setError(null);
    getKatalyst()
      .verify(nonce)
      .then((p) => !cancelled && setProof(p))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load the receipt'));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const link = useMemo(() => (nonce ? `${location.origin}${location.pathname}#/receipt/${nonce}` : ''), [nonce]);

  if (!nonce) {
    return (
      <div className="card mx-auto max-w-xl p-8 text-center">
        <p className="font-medium">Open a receipt from your Activity page.</p>
        <button type="button" className="btn mt-4" onClick={() => onNavigate('intent')}>
          Back to intent
        </button>
      </div>
    );
  }

  const settled = proof?.deposit && proof.settlement;

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: `Katalyst intent #${nonce}`, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* dismissed */
    }
  };

  const savePng = async () => {
    if (!svgRef.current) return;
    const blob = await svgToPng(svgRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `katalyst-receipt-${nonce}.png`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {error && <Notice tone="bad" title="Could not load the receipt">{error}</Notice>}
      {!proof && !error && (
        <div className="card flex items-center gap-3 p-6 text-sm text-muted">
          <Spinner label="Loading" /> Reading the evidence…
        </div>
      )}
      {proof && !settled && (
        <Notice tone="warn" title={proof.verdict === 'not_found' ? 'No such intent' : 'Not settled yet'}>
          {proof.verdict === 'not_found' ? `There is no deposit for intent #${nonce}.` : `Intent #${nonce} has not been settled, so there is no receipt yet.`}
        </Notice>
      )}
      {proof && settled && (
        <>
          <div className="card overflow-hidden p-2">
            <ImpactCard proof={proof} svgRef={svgRef} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void share()}>
              {copied ? 'Link copied' : 'Share link'}
            </button>
            <button type="button" className="btn" onClick={() => void savePng()}>
              Download image
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => onNavigate('verify', nonce)}>
              See the verification
            </button>
          </div>
        </>
      )}
    </div>
  );
}
