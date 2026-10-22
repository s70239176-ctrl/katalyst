import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { activeChain } from '../../utils/chains';
import { getKatalyst } from '../../utils/katalyst';
import { fetchLandingData, type LandingData, type SettlementRow } from '../../utils/recent';
import { explorerBlockUrl, pingNetwork } from '../../utils/substrate';
import { poolLabel, shortHash } from '../../utils/types';
import { isV2 } from '../../utils/vaultAbi';
import type { Page } from '../Header';
import { SettlementFlow, type FlowMeta } from './SettlementFlow';
import './landing.css';

const DOCS_URL = 'https://github.com/s70239176-ctrl/katalyst/tree/main/docs';
const DOC = (file: string) => `https://github.com/s70239176-ctrl/katalyst/blob/main/docs/${file}`;

type Navigate = (page: Page, nonce?: number) => void;

// ---------- small pieces ----------

const Arrow = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2 7h9M7.5 3L11.5 7l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M12 8h12v48H12z" fill="#c4ff42" /><path d="M24 36 52 8H40L24 24z" fill="#c4ff42" /><path d="M24 28 52 56H40L24 40z" fill="#35caff" />
    </svg>
  );
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const fmtTime = (unix: number | null): string => (unix === null ? 'n/a' : `~${new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false })}`);

const fmtDuration = (sec: number | null): string => {
  if (sec === null) return 'n/a';
  if (sec < 60) return `~${Math.round(sec)}s`;
  return `~${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
};

function routeText(r: SettlementRow): string {
  if (!r.route || r.route.length === 0) return 'None';
  return r.route.map((l) => `${poolLabel(l.pool)} ${l.pct}%`).join(' · ');
}

const STATUS: Record<string, { cls: string; label: string }> = {
  Executed: { cls: 'ok', label: 'Settled' },
  Pending: { cls: 'prog', label: 'In progress' },
  Rejected: { cls: 'bad', label: 'Rejected' },
  Cancelled: { cls: 'neutral', label: 'Cancelled' },
  Expired: { cls: 'neutral', label: 'Expired' },
  Vetoed: { cls: 'neutral', label: 'Vetoed' },
};

// ---------- page ----------

export default function Landing({ onNavigate }: { onNavigate: Navigate }) {
  const chain = activeChain();
  const [net, setNet] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [data, setData] = useState<LandingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await pingNetwork();
      if (!cancelled) setNet(ok ? 'online' : 'offline');
    };
    void check();
    const t = setInterval(() => void check(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await fetchLandingData(5));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settlements');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!isV2()) return;
    let cancelled = false;
    getKatalyst()
      .vault.hubPools()
      .then((p) => !cancelled && setRoutes(p.filter((x) => x.active).length))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  const latest = data?.rows.find((r) => r.status === 'Executed');
  const meta: FlowMeta = {
    hash: latest?.txHash ? shortHash(latest.txHash) : 'n/a',
    id: latest ? `#${latest.nonce}` : 'n/a',
    route: latest ? routeText(latest).split(' · ')[0] ?? 'n/a' : 'n/a',
    network: chain.name,
    settledIn: fmtDuration(latest?.elapsedSec ?? null),
  };

  const successPct = data && data.protocolOutcomes > 0 ? `${((data.routed / data.protocolOutcomes) * 100).toFixed(1)}%` : 'n/a';
  const netLabel = net === 'online' ? 'Testnet · online' : net === 'offline' ? 'Unreachable' : 'Connecting…';

  const metrics: Array<{ label: string; value: string; hint: string; icon: ReactNode }> = [
    {
      label: 'Intents processed',
      value: data ? data.intents.toLocaleString('en-US') : 'n/a',
      hint: 'recent, onchain',
      icon: (
        <Icon>
          <path d="M12 3l9 4.5-9 4.5L3 7.5z" />
          <path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" />
        </Icon>
      ),
    },
    {
      label: 'Settlement success',
      value: successPct,
      hint: data ? `${data.routed} of ${data.protocolOutcomes} decided` : 'routed ÷ decided',
      icon: (
        <Icon>
          <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />
          <path d="M8.5 12l2.5 2.5L16 9.5" />
        </Icon>
      ),
    },
    {
      label: 'Median settlement',
      value: data?.medianSec !== null && data?.medianSec !== undefined ? fmtDuration(data.medianSec) : 'n/a',
      hint: 'deposit to payout',
      icon: (
        <Icon>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5l3 2" />
        </Icon>
      ),
    },
    {
      label: 'Active routes',
      value: routes !== null ? String(routes) : 'n/a',
      hint: chain.version === 2 ? 'pools in the hub' : 'v2 only',
      icon: (
        <Icon>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="19" r="2.2" />
          <path d="M7.8 7.4L11 17M16.2 7.4L13 17M8.2 6h7.6" />
        </Icon>
      ),
    },
  ];

  return (
    <div className="kt">
      <header className="kt-header">
        <div className="inner">
          <button type="button" className="kt-brand" onClick={() => window.scrollTo({ top: 0 })} aria-label="Katalyst home">
            <Logo />
            <span className="word">KATALYST</span>
          </button>
          <nav className="kt-nav" aria-label="Primary">
            <button type="button" aria-current="page" onClick={() => window.scrollTo({ top: 0 })}>
              Protocol
            </button>
            <button type="button" onClick={() => scrollTo('how')}>
              How it works
            </button>
            <button type="button" onClick={() => onNavigate('network')}>
              Explorer
            </button>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
              Docs
            </a>
          </nav>
          <div className="kt-right">
            <div className="kt-net" role="status">
              <span className={`kt-dot ${net === 'online' ? 'live' : net === 'offline' ? 'bad' : 'warn'}`} />
              <div>
                <b>Portaldot</b>
                <span className="sub">{netLabel}</span>
              </div>
            </div>
            <button type="button" className="kt-btn primary" onClick={() => onNavigate('intent')}>
              Launch app <Arrow />
            </button>
          </div>
        </div>
      </header>

      <main className="wrap">
        <section className="kt-hero" aria-labelledby="kt-h1">
          <div>
            <p className="kt-eyebrow">Onchain intent settlement</p>
            <h1 className="kt-h1" id="kt-h1">
              Intent in.
              <span>Settlement out.</span>
            </h1>
            <p className="kt-lede">
              Katalyst turns user intents into verifiable execution across PortalDot. It connects you to the right liquidity, execution and settlement, with independent verification at every step.
            </p>
            <div className="kt-actions">
              <button type="button" className="kt-btn primary lg" onClick={() => scrollTo('how')}>
                Explore protocol <Arrow />
              </button>
              <button type="button" className="kt-btn ghost lg" onClick={() => scrollTo('settlements')}>
                View live activity <span className={`kt-dot ${net === 'online' ? 'live' : 'warn'}`} />
              </button>
            </div>
          </div>
          <SettlementFlow meta={meta} />
        </section>

        <section className="kt-metrics" aria-label="Network overview">
          <div className="ov">
            <div>
              <div className="ov-title">
                <span className={`kt-dot ${net === 'online' ? 'live' : net === 'offline' ? 'bad' : 'warn'}`} />
                PORTALDOT NETWORK
              </div>
              <p>Intent settlement on {chain.name}, decided by GenLayer validators and settled onchain.</p>
            </div>
          </div>
          {metrics.map((m) => (
            <div key={m.label}>
              <span className="ico">{m.icon}</span>
              <div>
                <div className="lab">{m.label}</div>
                <div className="val">{m.value}</div>
                <div className="hint">{m.hint}</div>
              </div>
            </div>
          ))}
        </section>

        <section id="settlements" aria-labelledby="kt-recent">
          <div className="kt-sec-head">
            <h2 id="kt-recent">
              <span className="kt-dot" /> Recent settlements <span className="kt-live">{net === 'online' ? 'Live' : 'Offline'}</span>
            </h2>
            <button type="button" className="kt-link" onClick={() => onNavigate('network')}>
              View all settlements →
            </button>
          </div>
          <div className="kt-table-wrap">
            <table className="kt-table">
              <thead>
                <tr>
                  <th scope="col" title="Estimated from block count and the current block time (the public RPC prunes old blocks)">Time</th>
                  <th scope="col">Intent ID</th>
                  <th scope="col">Route</th>
                  <th scope="col">Status</th>
                  <th scope="col" title="Estimated from block count and the current block time">Elapsed</th>
                  <th scope="col">Verified outcome</th>
                </tr>
              </thead>
              <tbody>
                {data === null && !error &&
                  [0, 1, 2].map((i) => (
                    <tr key={i}>
                      {[0, 1, 2, 3, 4, 5].map((j) => (
                        <td key={j}>
                          <span className="kt-skel" />
                        </td>
                      ))}
                    </tr>
                  ))}
                {error && (
                  <tr>
                    <td colSpan={6} className="kt-state">
                      Could not load settlements ({error.slice(0, 80)}).{' '}
                      <button type="button" className="kt-link" onClick={() => void load()}>
                        Retry
                      </button>
                    </td>
                  </tr>
                )}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="kt-state">
                      No intents yet on this vault.
                    </td>
                  </tr>
                )}
                {data?.rows.map((r) => {
                  const st = STATUS[r.status] ?? STATUS['Pending']!;
                  return (
                    <tr key={r.nonce}>
                      <td className="t mono">{fmtTime(r.time)}</td>
                      <td>
                        <button type="button" className="kt-link mono" style={{ color: 'var(--kt-text-secondary)' }} onClick={() => onNavigate('verify', r.nonce)} aria-label={`Verify intent ${r.nonce}`}>
                          intent #{r.nonce}
                        </button>
                      </td>
                      <td>
                        <span className="kt-route">
                          <i aria-hidden="true" />
                          {routeText(r)}
                        </span>
                      </td>
                      <td>
                        <span className={`kt-pill ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="mono">{fmtDuration(r.elapsedSec)}</td>
                      <td>
                        {r.txHash && r.settleBlock ? (
                          <a className="kt-outcome mono" href={explorerBlockUrl(r.settleBlock)} target="_blank" rel="noreferrer noopener" aria-label={`Open block ${r.settleBlock} in the explorer`}>
                            {shortHash(r.txHash)}
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                              <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </a>
                        ) : (
                          'n/a'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section id="how" className="kt-layers" aria-label="Protocol layers">
          <article className="kt-card lime">
            <span className="badge">
              <Icon>
                <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
                <circle cx="12" cy="12" r="2.4" />
              </Icon>
            </span>
            <div>
              <div className="num">01</div>
              <h3>Intent layer</h3>
            </div>
            <p>Users express what they want, not how to do it. Katalyst captures, validates and structures intents before any funds move.</p>
            <a className="more" href={DOC('ARCHITECTURE.md')} target="_blank" rel="noreferrer noopener">
              Learn more →
            </a>
          </article>
          <article className="kt-card blue">
            <span className="badge">
              <Icon>
                <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
                <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
              </Icon>
            </span>
            <div>
              <div className="num">02</div>
              <h3>Execution layer</h3>
            </div>
            <p>GenLayer validators agree on a route; deterministic code allocates it and the vault checks it again onchain before paying the pools.</p>
            <a className="more" href={DOC('V2_DESIGN.md')} target="_blank" rel="noreferrer noopener">
              Learn more →
            </a>
          </article>
          <article className="kt-card green">
            <span className="badge">
              <Icon>
                <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />
                <path d="M8.5 12l2.5 2.5L16 9.5" />
              </Icon>
            </span>
            <div>
              <div className="num">03</div>
              <h3>Proof layer</h3>
            </div>
            <p>Every settlement can be verified independently from onchain events and the validators&apos; own records, with nothing taken on trust.</p>
            <button type="button" className="more kt-link" style={{ color: 'var(--kt-green)' }} onClick={() => onNavigate('verify')}>
              Learn more →
            </button>
          </article>
        </section>
      </main>

      <footer className="kt-foot">
        <div className="wrap row">
          <span>Katalyst · testnet software, unaudited. Do not use funds you cannot lose.</span>
          <span>GenLayer decides · {chain.name} settles</span>
        </div>
      </footer>
    </div>
  );
}
