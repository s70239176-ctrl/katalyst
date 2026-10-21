import { useEffect, useState } from 'react';
import { RELAYER_API, fetchHealth } from '../utils/api';
import { GENLAYER_CONTRACT, GENLAYER_EXPLORER } from '../utils/genlayer';
import { fetchNetworkStats } from '../utils/history';
import { VAULT_ADDRESS, explorerBlockUrl } from '../utils/substrate';
import { POOL_LABELS, TOKEN_SYMBOL, formatPot, timeAgo, type NetworkStats, type RelayerHealth } from '../utils/types';
import { Badge, CopyButton, ExternalLink, Skeleton, Stat } from './ui';

export function NetworkPage({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [health, setHealth] = useState<RelayerHealth | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, h] = await Promise.all([fetchNetworkStats(), fetchHealth()]);
        if (cancelled) return;
        setStats(s);
        setHealth(h);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load network data');
      }
    };
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refreshKey]);

  const settled = stats ? stats.executed + stats.rejected + stats.cancelled : 0;

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats ? (
          <>
            <Stat label="Intents submitted" value={stats.deposits} hint="all time, on-chain" />
            <Stat label="Unique wallets" value={stats.uniqueUsers} />
            <Stat label="Volume deposited" value={`${formatPot(stats.volume, 2)}`} hint={`${TOKEN_SYMBOL}, all intents`} />
            <Stat
              label="Settled"
              value={settled}
              hint={`${stats.executed} routed · ${stats.rejected} rejected · ${stats.cancelled} cancelled`}
            />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="relayer-title">
          <div className="flex items-center justify-between">
            <h2 id="relayer-title" className="text-base font-semibold">
              Relayer
            </h2>
            {health === undefined ? <Skeleton className="h-6 w-16" /> : <Badge tone={health ? 'ok' : 'bad'}>{health ? 'Online' : 'Offline'}</Badge>}
          </div>
          {health ? (
            <dl className="mt-4 space-y-2 text-sm">
              <Line label="Account" value={<span className="mono">{health.relayer}</span>} />
              <Line label="Gas balance" value={`${Number(health.relayerBalance).toFixed(2)} ${TOKEN_SYMBOL}`} />
              <Line label="Queue" value={`${health.queueLength} in flight`} />
              <Line label="Uptime" value={`${Math.floor(health.uptimeSec / 60)} min`} />
              <Line label="Last settlement" value={health.lastSettledAt ? timeAgo(health.lastSettledAt) : '—'} />
            </dl>
          ) : (
            health === null && (
              <p className="mt-3 text-sm text-muted">
                The relayer API at <span className="mono">{RELAYER_API}</span> is not reachable. On-chain data above is unaffected; consensus details and live status need the relayer.
              </p>
            )
          )}
        </section>

        <section className="card p-5" aria-labelledby="contracts-title">
          <h2 id="contracts-title" className="text-base font-semibold">
            Contracts
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            <ContractLine label="Vault · Portaldot V3 (EVM)" address={VAULT_ADDRESS} />
            <ContractLine
              label="Solver · GenLayer Studionet"
              address={GENLAYER_CONTRACT}
              href={GENLAYER_CONTRACT ? `${GENLAYER_EXPLORER}/address/${GENLAYER_CONTRACT}` : undefined}
            />
          </dl>
          {stats && (
            <p className="mt-4 text-xs text-subtle">
              Head block <ExternalLink href={explorerBlockUrl(stats.headBlock)}>{stats.headBlock.toLocaleString('en-US')}</ExternalLink>
            </p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="pools-title">
        <div className="border-b border-line px-5 py-4">
          <h2 id="pools-title" className="text-base font-semibold">
            Whitelisted pools
          </h2>
          <p className="text-sm text-muted">The vault can only ever send funds to these addresses; the owner manages the list.</p>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Pool</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(POOL_LABELS).map(([addr, name]) => (
              <tr key={addr}>
                <td className="font-medium">{name}</td>
                <td>
                  <span className="mono text-muted">{addr}</span> <CopyButton value={addr} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-right">{value}</dd>
    </div>
  );
}

function ContractLine({ label, address, href }: { label: string; address: string; href?: string | undefined }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2">
        {address ? (
          <>
            <span className="mono break-all">{address}</span>
            <CopyButton value={address} />
            {href && <ExternalLink href={href}>Explorer</ExternalLink>}
          </>
        ) : (
          <span className="text-warn">Not configured</span>
        )}
      </dd>
    </div>
  );
}
