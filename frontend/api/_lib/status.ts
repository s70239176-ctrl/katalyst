/**
 * Stateless operational status for the serverless relayer, computed from chain state at request time.
 * Backs /api/status (JSON for uptime monitors; HTTP 503 when unhealthy) and /api/metrics (Prometheus text).
 * With several settlement chains configured, every chain is checked independently.
 */
import { formatEther, getAddress, toBeHex } from 'ethers';
import { chains, getProvider, getRelayerWallet, optionalEnv, retry, type ChainCfg } from './config.js';
import { genlayerChainName, genlayerContract, pingGenLayer } from './genlayer.js';
import { vault } from './vault.js';

export type Level = 'ok' | 'warn' | 'fail';

export interface StatusCheck {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

export interface ChainMetrics {
  key: string;
  headBlock: number;
  blockTimeSec: number;
  relayerBalance: number;
  totalIntents: number;
  pending: number;
  oldestPendingMinutes: number;
  rpcLatencyMs: number;
}

export interface Status {
  ok: boolean;
  generatedAt: string;
  mode: 'serverless';
  genlayer: { chain: string; contract: string; latencyMs: number };
  chains: Array<{ key: string; name: string; chainId: number; vault: string }>;
  checks: StatusCheck[];
  metrics: ChainMetrics[];
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

async function checkChain(chain: ChainCfg, checks: StatusCheck[]): Promise<ChainMetrics> {
  const provider = getProvider(chain);
  const wallet = getRelayerWallet(chain);
  const v = vault(chain);
  const pre = chains().length > 1 ? `${chain.name}: ` : '';
  const id = (s: string) => (chains().length > 1 ? `${chain.key}_${s}` : s);
  const add = (s: string, label: string, level: Level, detail: string) => checks.push({ id: id(s), label: pre + label, level, detail });

  const minBalance = num('STATUS_MIN_BALANCE_TPOT', 2);
  const stuckMinutes = num('STATUS_STUCK_MINUTES', 15);
  const windowBlocks = num('STATUS_WINDOW_BLOCKS', 3000);

  const head = await timed(() => retry(() => provider.getBlockNumber(), 2));
  const m: ChainMetrics = { key: chain.key, headBlock: head.value ?? 0, blockTimeSec: 0, relayerBalance: 0, totalIntents: 0, pending: 0, oldestPendingMinutes: 0, rpcLatencyMs: head.ms };

  if (head.value === null) {
    add('rpc', 'RPC', 'fail', `Unreachable: ${head.error ?? 'no response'}`);
    return m;
  }
  add('rpc', 'RPC', head.ms > 6000 ? 'warn' : 'ok', `Block ${head.value} in ${head.ms} ms`);

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
    m.relayerBalance = Number(formatEther(balance.value));
    add('relayer_balance', 'Relayer gas balance', m.relayerBalance < minBalance ? (m.relayerBalance < minBalance / 2 ? 'fail' : 'warn') : 'ok', `${m.relayerBalance.toFixed(2)} (alert below ${minBalance})`);
  } else add('relayer_balance', 'Relayer gas balance', 'fail', 'Could not read the balance');
  m.totalIntents = total.value !== null ? Number(total.value) : 0;
  if (chain.version === 2) {
    const paused = await timed(() => v.getFunction('paused')() as Promise<boolean>);
    if (paused.value !== null) add('paused', 'Vault not paused', paused.value ? 'warn' : 'ok', paused.value ? 'The owner has paused deposits and settlement; refunds and withdrawals still work' : 'Accepting deposits');
  }

  // Block time from two recent blocks (recent blocks are always served; old ones may be pruned).
  try {
    const [a, b] = await Promise.all([
      provider.send('eth_getBlockByNumber', [toBeHex(head.value), false]) as Promise<{ timestamp: string }>,
      provider.send('eth_getBlockByNumber', [toBeHex(head.value - 40), false]) as Promise<{ timestamp: string }>,
    ]);
    m.blockTimeSec = Math.max(1, (Number(BigInt(a.timestamp)) - Number(BigInt(b.timestamp))) / 40);
  } catch {
    m.blockTimeSec = 8;
  }

  // Stuck intents: deposited in the recent window, not settled, and older than the threshold.
  try {
    const from = Math.max(chain.deployBlock, head.value - windowBlocks);
    const address = getAddress(chain.vault);
    const topic = (n: string) => v.interface.getEvent(n)!.topicHash;
    const scan = async (topics: (string | string[])[]) => {
      const out: Awaited<ReturnType<typeof provider.getLogs>> = [];
      for (let s = from; s <= head.value!; s += LOG_CHUNK) out.push(...(await retry(() => provider.getLogs({ address, topics, fromBlock: s, toBlock: Math.min(s + LOG_CHUNK - 1, head.value!) }))));
      return out;
    };
    const [deposits, settled] = await Promise.all([scan([topic('IntentDeposited')]), scan([[topic('IntentExecuted'), topic('IntentRejected'), topic('IntentCancelled'), ...(chain.version === 2 ? [topic('IntentExpired'), topic('SettlementVetoed')] : [])]])]);
    const done = new Set(settled.map((l) => BigInt(l.topics[1]!).toString()));
    const open = deposits.filter((l) => !done.has(BigInt(l.topics[1]!).toString()));
    m.pending = open.length;
    const oldest = open.reduce((min, l) => Math.min(min, l.blockNumber), head.value);
    m.oldestPendingMinutes = open.length ? Math.round(((head.value - oldest) * m.blockTimeSec) / 60) : 0;
    const stuck = m.oldestPendingMinutes >= stuckMinutes;
    add('stuck_intents', 'Pending intents', stuck ? 'fail' : 'ok', open.length ? `${open.length} pending, oldest ${m.oldestPendingMinutes} min${stuck ? ` (over the ${stuckMinutes} min limit)` : ''}` : 'None pending');
  } catch (err) {
    add('stuck_intents', 'Pending intents', 'warn', `Could not scan events: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`);
  }
  return m;
}

export async function computeStatus(): Promise<Status> {
  const checks: StatusCheck[] = [];
  const gl = await timed(() => pingGenLayer());
  checks.push({
    id: 'genlayer_rpc',
    label: 'GenLayer solver',
    level: gl.value === null ? 'fail' : gl.ms > 8000 ? 'warn' : 'ok',
    detail: gl.value === null ? `Unreachable: ${gl.error ?? 'no response'}` : `Solver reachable in ${gl.ms} ms`,
  });
  const metrics = await Promise.all(chains().map((c) => checkChain(c, checks)));
  return {
    ok: !checks.some((c) => c.level === 'fail'),
    generatedAt: new Date().toISOString(),
    mode: 'serverless',
    genlayer: { chain: genlayerChainName(), contract: genlayerContract(), latencyMs: gl.ms },
    chains: chains().map((c) => ({ key: c.key, name: c.name, chainId: c.chainId, vault: c.vault })),
    checks,
    metrics,
  };
}

/** Prometheus text exposition for the same data. */
export function toPrometheus(s: Status): string {
  const lines: string[] = [];
  const g = (name: string, help: string, rows: Array<[string, number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${value}`);
  };
  const per = (pick: (m: ChainMetrics) => number): Array<[string, number]> => s.metrics.map((m) => [`{chain="${m.key}"}`, pick(m)]);
  g('katalyst_up', '1 when every health check passes', [['', s.ok ? 1 : 0]]);
  g('katalyst_genlayer_latency_ms', 'GenLayer solver read latency', [['', s.genlayer.latencyMs]]);
  g('katalyst_head_block', 'Latest block per settlement chain', per((m) => m.headBlock));
  g('katalyst_rpc_latency_ms', 'RPC latency per settlement chain', per((m) => m.rpcLatencyMs));
  g('katalyst_relayer_balance', 'Relayer gas balance in native units', per((m) => m.relayerBalance));
  g('katalyst_intents_total', 'Intents ever deposited in the vault', per((m) => m.totalIntents));
  g('katalyst_intents_pending', 'Intents deposited but not yet settled (recent window)', per((m) => m.pending));
  g('katalyst_oldest_pending_minutes', 'Age of the oldest pending intent', per((m) => m.oldestPendingMinutes));
  lines.push('# HELP katalyst_check 1 when the named check is ok', '# TYPE katalyst_check gauge');
  for (const c of s.checks) lines.push(`katalyst_check{id="${c.id}",level="${c.level}"} ${c.level === 'ok' ? 1 : 0}`);
  return lines.join('\n') + '\n';
}
