import { useEffect, useState } from 'react';
import { activeChain, tokenSymbol } from '../utils/chains';
import { RELAYER_API, fetchHealth, fetchStatus, type StatusView } from '../utils/api';
import { GENLAYER_CONTRACT, GENLAYER_EXPLORER } from '../utils/genlayer';
import { fetchNetworkStats } from '../utils/history';
import { vaultAddress, explorerBlockUrl } from '../utils/substrate';
import { POOL_LABELS, formatPot, timeAgo, type NetworkStats, type RelayerHealth } from '../utils/types';
import { Badge, CopyButton, ExternalLink, Skeleton, Stat } from './ui';
import { ValidatorsCard } from './ValidatorsCard';
import type { VaultPolicy } from '../sdk/vault';
import { getKatalyst } from '../utils/katalyst';

export function NetworkPage({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [health, setHealth] = useState<RelayerHealth | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [policy, setPolicy] = useState<VaultPolicy | null>(null);
  const [hubHeld, setHubHeld] = useState<bigint | null>(null);

  useEffect(() => {
    if (activeChain().version !== 2) return;
    let cancelled = false;
    void (async () => {
      try {
        const k = getKatalyst().vault;
        const p = await k.policy();
        const held = BigInt(await k.provider.send('eth_getBalance', [p.hub, 'latest']));
        if (!cancelled) {
          setPolicy(p);
          setHubHeld(held);
        }
      } catch {
        /* optional card */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, h, st] = await Promise.all([fetchNetworkStats(), fetchHealth(), fetchStatus()]);
        if (cancelled) return;
        setStats(s);
        setHealth(h);
        setStatus(st);
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
            <Stat label="Volume deposited" value={`${formatPot(stats.volume, 2)}`} hint={`${tokenSymbol()}, all intents`} />
            <Stat
              label="Settled"
              value={settled}
              hint={`${stats.executed} routed · ${stats.rejected} rejected · ${stats.cancelled} refunded`}
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
            {health === undefined ? <Skeleton className="h-6 w-16" /> : <Badge tone={health && health.ok ? 'ok' : 'bad'}>{health ? (health.ok ? 'Online' : 'Misconfigured') : 'Offline'}</Badge>}
          </div>
          {health ? (
            <dl className="mt-4 space-y-2 text-sm">
              <Line label="Account" value={<span className="mono">{health.relayer}</span>} />
              <Line label="Gas balance" value={`${Number(health.relayerBalance).toFixed(2)} ${tokenSymbol()}`} />
              <Line label="Mode" value={health.mode === 'serverless' ? 'Serverless (Vercel Functions)' : 'Always-on relayer'} />
              {health.queueLength !== undefined && <Line label="Queue" value={`${health.queueLength} in flight`} />}
              {health.uptimeSec !== undefined && <Line label="Uptime" value={`${Math.floor(health.uptimeSec / 60)} min`} />}
              {health.lastSettledAt !== undefined && <Line label="Last settlement" value={health.lastSettledAt ? timeAgo(health.lastSettledAt) : '—'} />}
              {health.relayerMatchesVault === false && (
                <Line label="Key check" value={<Badge tone="bad">Relayer key does not match the vault</Badge>} />
              )}
            </dl>
          ) : (
            health === null && (
              <p className="mt-3 text-sm text-muted">
                {RELAYER_API ? (
                  <>
                    The relayer API at <span className="mono">{RELAYER_API}</span> is not reachable.
                  </>
                ) : (
                  'No relayer API is configured for this deployment.'
                )}{' '}
                On-chain data above is unaffected; consensus details and live status need the relayer.
              </p>
            )
          )}
        </section>

        <section className="card p-5" aria-labelledby="contracts-title">
          <h2 id="contracts-title" className="text-base font-semibold">
            Contracts
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            <ContractLine label={`Vault · ${activeChain().name}`} address={vaultAddress()} />
            {policy && <ContractLine label="PoolHub · pool positions" address={policy.hub} />}
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

      {policy && (
        <section className="card p-5" aria-labelledby="policy-title">
          <div className="flex items-center justify-between">
            <h2 id="policy-title" className="text-base font-semibold">
              Vault rules
            </h2>
            <Badge tone={policy.paused ? 'warn' : 'ok'}>{policy.paused ? 'Paused' : 'Active'}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">Fixed when the vault was deployed. Nobody, including the owner, can change them.</p>
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
            <Line label="Protocol fee" value={`${formatPot(policy.feeWei, 4)} ${tokenSymbol()}`} />
            <Line label="Per-deposit cap" value={policy.maxDepositWei > 0n ? `${formatPot(policy.maxDepositWei, 2)} ${tokenSymbol()}` : 'None'} />
            <Line label="Refund timeout" value={`${Math.round(policy.ttlSeconds / 60)} min`} />
            <Line label="Settlement delay (owner veto window)" value={`${policy.delaySeconds}s`} />
            <Line label="Owner" value={<span className="mono">{policy.owner}</span>} />
            <Line label="Held in pools (PoolHub)" value={hubHeld !== null ? `${formatPot(hubHeld, 2)} ${tokenSymbol()}` : '…'} />
          </dl>
        </section>
      )}

      {status && (
        <section className="card" aria-labelledby="status-title">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 id="status-title" className="text-base font-semibold">
              System status
            </h2>
            <Badge tone={status.ok ? 'ok' : 'bad'}>{status.ok ? 'All systems operational' : 'Degraded'}</Badge>
          </div>
          <ul className="divide-y divide-line">
            {status.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: c.level === 'ok' ? 'var(--accent)' : c.level === 'warn' ? 'var(--warn)' : 'var(--danger)' }} aria-hidden="true" />
                <div>
                  <p className="font-medium">
                    {c.label} <span className="sr-only">({c.level})</span>
                  </p>
                  <p className="text-muted">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ValidatorsCard refreshKey={refreshKey} />

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
