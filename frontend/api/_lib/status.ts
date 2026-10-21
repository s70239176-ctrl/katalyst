/**
 * Stateless operational status for the serverless relayer, computed from chain state at request time.
 * Backs /api/status (JSON for uptime monitors; HTTP 503 when unhealthy) and /api/metrics (Prometheus text).
 */
import { formatEther, getAddress, toBeHex } from 'ethers';
import { CHAIN_ID, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK, getProvider, getRelayerWallet, optionalEnv, retry } from './config.js';
import { genlayerChainName, genlayerContract, pingGenLayer } from './genlayer.js';
import { vault } from './vault.js';

export type Level = 'ok' | 'warn' | 'fail';

export interface StatusCheck {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

export interface StatusMetrics {
  headBlock: number;
  blockTimeSec: number;
  relayerBalanceTpot: number;
  totalIntents: number;
  windowDeposits: number;
  windowSettled: number;
  pending: number;
  oldestPendingMinutes: number;
  portaldotLatencyMs: number;
  genlayerLatencyMs: number;
}

export interface Status {
  ok: boolean;
  generatedAt: string;
  mode: 'serverless';
  chainId: number;
  vault: string;
  genlayer: { chain: string; contract: string };
  checks: StatusCheck[];
  metrics: StatusMetrics;
}

const num = (name: string, fallback: number): number => {
  const v = Number(optionalEnv(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const LOG_CHUNK = 1000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error?: string }> {
  const t = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t };
  } catch (err) {
    return { value: null, ms: Date.now() - t, error: err instanceof Error ? err.message.slice(0, 120) : 'error' };
  }
}

export async function computeStatus(): Promise<Status> {
  const provider = getProvider();
  const wallet = getRelayerWallet();
  const v = vault();
  const checks: StatusCheck[] = [];
  const add = (id: string, label: string, level: Level, detail: string) => checks.push({ id, label, level, detail });

  const minBalance = num('STATUS_MIN_BALANCE_TPOT', 2);
  const stuckMinutes = num('STATUS_STUCK_MINUTES', 15);
  const windowBlocks = num('STATUS_WINDOW_BLOCKS', 3000);

  // Portaldot RPC + GenLayer RPC, in parallel.
  const [head, gl] = await Promise.all([timed(() => retry(() => provider.getBlockNumber(), 2)), timed(() => pingGenLayer())]);

  const metrics: StatusMetrics = {
    headBlock: head.value ?? 0,
    blockTimeSec: 0,
    relayerBalanceTpot: 0,
    totalIntents: 0,
    windowDeposits: 0,
    windowSettled: 0,
    pending: 0,
    oldestPendingMinutes: 0,
    portaldotLatencyMs: head.ms,
    genlayerLatencyMs: gl.ms,
  };

  if (head.value === null) {
    add('portaldot_rpc', 'Portaldot RPC', 'fail', `Unreachable: ${head.error ?? 'no response'}`);
  } else {
    add('portaldot_rpc', 'Portaldot RPC', head.ms > 6000 ? 'warn' : 'ok', `Block ${head.value} in ${head.ms} ms`);
  }
  add('genlayer_rpc', 'GenLayer solver', gl.value === null ? 'fail' : gl.ms > 8000 ? 'warn' : 'ok', gl.value === null ? `Unreachable: ${gl.error ?? 'no response'}` : `Solver reachable in ${gl.ms} ms`);

  if (head.value === null) return finish(checks, metrics);

  // Relayer key + gas balance + vault counters.
  const [relayerOnChain, balance, total] = await Promise.all([
    timed(() => v.getFunction('relayer')() as Promise<string>),
    timed(() => provider.getBalance(wallet.address)),
    timed(() => v.getFunction('intentCount')() as Promise<bigint>),
  ]);
  if (relayerOnChain.value === null) add('relayer_key', 'Relayer key', 'fail', 'Could not read the vault relayer');
  else {
    const match = getAddress(relayerOnChain.value) === wallet.address;
    add('relayer_key', 'Relayer key', match ? 'ok' : 'fail', match ? `${wallet.address} is the vault's relayer` : `Configured key ${wallet.address} is not the vault relayer ${relayerOnChain.value}`);
  }
  if (balance.value !== null) {
    metrics.relayerBalanceTpot = Number(formatEther(balance.value));
    add('relayer_balance', 'Relayer gas balance', metrics.relayerBalanceTpot < minBalance ? (metrics.relayerBalanceTpot < minBalance / 2 ? 'fail' : 'warn') : 'ok', `${metrics.relayerBalanceTpot.toFixed(2)} tPOT (alert below ${minBalance})`);
  } else add('relayer_balance', 'Relayer gas balance', 'fail', 'Could not read the balance');
  metrics.totalIntents = total.value !== null ? Number(total.value) : 0;

  // Block time from two recent blocks (recent blocks are always served; old ones are pruned).
  try {
    const [a, b] = await Promise.all([
      provider.send('eth_getBlockByNumber', [toBeHex(head.value), false]) as Promise<{ timestamp: string }>,
      provider.send('eth_getBlockByNumber', [toBeHex(head.value - 40), false]) as Promise<{ timestamp: string }>,
    ]);
    metrics.blockTimeSec = Math.max(1, (Number(BigInt(a.timestamp)) - Number(BigInt(b.timestamp))) / 40);
  } catch {
    metrics.blockTimeSec = 8;
  }

  // Stuck intents: deposited in the recent window, not settled, and older than the threshold.
  try {
    const from = Math.max(VAULT_DEPLOY_BLOCK(), head.value - windowBlocks);
    const address = getAddress(VAULT_ADDRESS());
    const topic = (n: string) => v.interface.getEvent(n)!.topicHash;
    const scan = async (topics: (string | string[])[]) => {
      const out: Awaited<ReturnType<typeof provider.getLogs>> = [];
      for (let s = from; s <= head.value!; s += LOG_CHUNK) out.push(...(await retry(() => provider.getLogs({ address, topics, fromBlock: s, toBlock: Math.min(s + LOG_CHUNK - 1, head.value!) }))));
      return out;
    };
    const [deposits, settled] = await Promise.all([scan([topic('IntentDeposited')]), scan([[topic('IntentExecuted'), topic('IntentRejected'), topic('IntentCancelled')]])]);
    const done = new Set(settled.map((l) => BigInt(l.topics[1]!).toString()));
    const open = deposits.filter((l) => !done.has(BigInt(l.topics[1]!).toString()));
    metrics.windowDeposits = deposits.length;
    metrics.windowSettled = settled.length;
    metrics.pending = open.length;
    const oldest = open.reduce((m, l) => Math.min(m, l.blockNumber), head.value);
    metrics.oldestPendingMinutes = open.length ? Math.round(((head.value - oldest) * metrics.blockTimeSec) / 60) : 0;
    const stuck = metrics.oldestPendingMinutes >= stuckMinutes;
    add('stuck_intents', 'Pending intents', stuck ? 'fail' : open.length ? 'warn' : 'ok', open.length ? `${open.length} pending, oldest ${metrics.oldestPendingMinutes} min${stuck ? ` (over the ${stuckMinutes} min limit)` : ''}` : 'None pending');
    // Informational: a pending intent that is young is normal, so only an old one fails the check above.
    if (!stuck && open.length) checks[checks.length - 1]!.level = 'ok';
  } catch (err) {
    add('stuck_intents', 'Pending intents', 'warn', `Could not scan events: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`);
  }

  return finish(checks, metrics);
}

function finish(checks: StatusCheck[], metrics: StatusMetrics): Status {
  return {
    ok: !checks.some((c) => c.level === 'fail'),
    generatedAt: new Date().toISOString(),
    mode: 'serverless',
    chainId: CHAIN_ID,
    vault: VAULT_ADDRESS(),
    genlayer: { chain: genlayerChainName(), contract: genlayerContract() },
    checks,
    metrics,
  };
}

/** Prometheus text exposition for the same data. */
export function toPrometheus(s: Status): string {
  const m = s.metrics;
  const lines: string[] = [];
  const g = (name: string, help: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
  };
  g('katalyst_up', '1 when every health check passes', s.ok ? 1 : 0);
  g('katalyst_portaldot_head_block', 'Latest Portaldot block', m.headBlock);
  g('katalyst_portaldot_latency_ms', 'Portaldot RPC latency', m.portaldotLatencyMs);
  g('katalyst_genlayer_latency_ms', 'GenLayer solver read latency', m.genlayerLatencyMs);
  g('katalyst_relayer_balance_tpot', 'Relayer gas balance in tPOT', m.relayerBalanceTpot);
  g('katalyst_intents_total', 'Intents ever deposited in the vault', m.totalIntents);
  g('katalyst_intents_pending', 'Intents deposited but not yet settled (recent window)', m.pending);
  g('katalyst_oldest_pending_minutes', 'Age of the oldest pending intent', m.oldestPendingMinutes);
  for (const c of s.checks) lines.push(`katalyst_check{id="${c.id}",level="${c.level}"} ${c.level === 'ok' ? 1 : 0}`);
  return lines.join('\n') + '\n';
}
