import { useCallback, useEffect, useState } from 'react';
import { tokenSymbol } from '../utils/chains';
import { getKatalyst } from '../utils/katalyst';
import { explorerBlockUrl, withdrawPosition } from '../utils/substrate';
import { formatPot, poolLabel, shortHash, type WalletState } from '../utils/types';
import { Badge, EmptyState, ExternalLink, Skeleton, Spinner } from './ui';

interface Row {
  pool: string;
  eco: string;
  amountWei: bigint;
}

/**
 * v2: where a settled intent's funds live. Routes pay the PoolHub, which keeps a position per user and pool;
 * the user can pull any of it back at any time, even while the vault is paused.
 */
export function PositionsPage({ wallet, onConnect, refreshKey }: { wallet: WalletState | null; onConnect: () => void; refreshKey: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ pool: string; txHash: string; blockNumber: number } | null>(null);

  const load = useCallback(async () => {
    if (!wallet) return;
    try {
      setRows(await getKatalyst().vault.positions(wallet.address));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load positions');
    }
  }, [wallet]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load, refreshKey]);

  const withdraw = async (row: Row) => {
    setBusy(row.pool);
    setError(null);
    try {
      const hub = (await getKatalyst().vault.hub()).target as string;
      const res = await withdrawPosition(hub, row.pool, row.amountWei);
      setDone({ pool: row.pool, ...res });
      await load();
    } catch (err) {
      setError((err as { shortMessage?: string }).shortMessage ?? (err instanceof Error ? err.message : 'Withdrawal failed'));
    } finally {
      setBusy(null);
    }
  };

  if (!wallet) {
    return (
      <EmptyState title="Connect a wallet" action={<button type="button" className="btn btn-primary" onClick={onConnect}>Connect wallet</button>}>
        Your pool positions are tied to your address.
      </EmptyState>
    );
  }

  const total = rows?.reduce((s, r) => s + r.amountWei, 0n) ?? 0n;

  return (
    <section className="card" aria-labelledby="positions-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <div>
          <h2 id="positions-title" className="text-base font-semibold">
            Your pool positions
          </h2>
          <p className="text-sm text-muted">Settled intents are held in the PoolHub for you. Withdraw any position back to your wallet at any time.</p>
        </div>
        {rows && <Badge tone="info">{formatPot(total, 4)} {tokenSymbol()} total</Badge>}
      </div>

      {error && (
        <p role="alert" className="px-5 pt-4 text-sm text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="px-5 pt-4 text-sm text-muted">
          Withdrawn from {poolLabel(done.pool)} ·{' '}
          <ExternalLink href={explorerBlockUrl(done.blockNumber)} mono>
            {shortHash(done.txHash)}
          </ExternalLink>
        </p>
      )}

      {rows === null ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">No positions yet. Once an intent settles, the funds appear here.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Pool</th>
              <th>Eco</th>
              <th className="text-right">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pool}>
                <td className="font-medium">{poolLabel(r.pool)}</td>
                <td>
                  <Badge tone="ok">{r.eco}</Badge>
                </td>
                <td className="text-right tabular-nums">
                  {formatPot(r.amountWei, 4)} {tokenSymbol()}
                </td>
                <td className="text-right">
                  <button type="button" className="btn btn-sm" onClick={() => void withdraw(r)} disabled={busy !== null}>
                    {busy === r.pool ? <Spinner label="Withdrawing" /> : 'Withdraw'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
