import { createServer, type Server } from 'node:http';
import { formatEther } from 'ethers';
import type { VerdictRecord, VerdictStore } from './verdict_store.js';

export interface HealthSource {
  relayerAddress: string;
  vault: string;
  genlayerContract: string;
  genlayerChain: string;
  chainId: number;
  balanceWei: () => Promise<bigint>;
  queueLength: () => number;
}

const STARTED = Date.now();

function stats(rows: VerdictRecord[]) {
  const done = rows.filter((r) => r.phase === 'executed' || r.phase === 'rejected');
  const settleMs = done.map((r) => r.updatedAt - r.receivedAt).sort((a, b) => a - b);
  const median = settleMs.length ? settleMs[Math.floor(settleMs.length / 2)] : null;
  return {
    total: rows.length,
    executed: rows.filter((r) => r.phase === 'executed').length,
    rejected: rows.filter((r) => r.phase === 'rejected').length,
    failed: rows.filter((r) => r.phase === 'failed').length,
    inFlight: rows.filter((r) => r.phase === 'adjudicating' || r.phase === 'settling').length,
    uniqueUsers: new Set(rows.map((r) => r.user.toLowerCase())).size,
    volumeWei: rows.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString(),
    medianEndToEndMs: median,
  };
}

/**
 * Read-only JSON API for the dApp: relayer health, per-intent verdict records (GenLayer votes,
 * decision trace, transaction links) and aggregate stats. It exposes no secrets and accepts no writes.
 */
export function startApi(store: VerdictStore, health: HealthSource, port: number): Server {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (req.method !== 'GET') return send(405, { error: 'read-only API' });

    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health') {
        const bal = await health.balanceWei();
        return send(200, {
          ok: true,
          relayer: health.relayerAddress,
          relayerBalance: formatEther(bal),
          vault: health.vault,
          genlayer: { chain: health.genlayerChain, contract: health.genlayerContract },
          chainId: health.chainId,
          uptimeSec: Math.round((Date.now() - STARTED) / 1000),
          queueLength: health.queueLength(),
          lastSettledAt: store.list(200).find((r) => r.phase === 'executed' || r.phase === 'rejected')?.updatedAt ?? null,
        });
      }
      if (url.pathname === '/stats') return send(200, stats(store.list(10_000)));
      if (url.pathname === '/metrics') {
        const st = stats(store.list(10_000));
        const bal = Number(formatEther(await health.balanceWei()));
        const last = store.list(200).find((r) => r.phase === 'executed' || r.phase === 'rejected')?.updatedAt;
        const g = (name: string, help: string, value: number, labels = '') => `# HELP ${name} ${help}
# TYPE ${name} gauge
${name}${labels} ${value}
`;
        const body =
          g('katalyst_up', 'The relayer process is running', 1) +
          g('katalyst_relayer_balance_tpot', 'Relayer gas balance in tPOT', bal) +
          g('katalyst_queue_length', 'Intents waiting or in flight', health.queueLength()) +
          g('katalyst_intents_executed', 'Intents routed since the store began', st.executed) +
          g('katalyst_intents_rejected', 'Intents rejected and refunded', st.rejected) +
          g('katalyst_intents_failed', 'Intents the relayer failed to process', st.failed) +
          g('katalyst_uptime_seconds', 'Relayer uptime', Math.round((Date.now() - STARTED) / 1000)) +
          g('katalyst_last_settlement_timestamp_seconds', 'Unix time of the last settlement', last ? Math.round(last / 1000) : 0) +
          g('katalyst_median_end_to_end_ms', 'Median deposit-seen to settled time', st.medianEndToEndMs ?? 0);
        return void res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
      }
      if (url.pathname === '/verdicts') {
        const user = url.searchParams.get('user')?.toLowerCase();
        const rows = store.list(500).filter((r) => !user || r.user.toLowerCase() === user);
        return send(200, rows.slice(0, 50));
      }
      const m = url.pathname.match(/^\/verdicts\/(\d+)$/);
      if (m) {
        const rec = store.get(Number(m[1]));
        return rec ? send(200, rec) : send(404, { error: 'unknown nonce' });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });
  server.listen(port, () => console.log(`[API] http://localhost:${port}  (/health /stats /verdicts /verdicts/:nonce)`));
  return server;
}
