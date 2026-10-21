/**
 * Landing-page data, read straight from the active vault's events (no indexer, no fabricated values):
 * recent settlements with their route, outcome and elapsed time, plus the counts the headline metrics use.
 */
import { Contract, getAddress, toBeHex, toUtf8String, type Log } from 'ethers';
import { getReadProvider, vaultAddress, vaultDeployBlock } from './substrate';
import type { IntentStatus } from './types';
import { settledEventNames, statusOfEvent, vaultAbi } from './vaultAbi';

const LOG_CHUNK = 1000;
/** Look-back bound so the landing page stays cheap as the chain grows (about a day of blocks at ~6 s). */
const WINDOW_BLOCKS = 15_000;

export interface SettlementRow {
  nonce: number;
  status: IntentStatus;
  /** Pools paid and their share, when the intent was routed. */
  route: Array<{ pool: string; pct: number; eco: string }> | null;
  depositBlock: number;
  settleBlock: number | null;
  txHash: string | null;
  /** Estimated unix seconds of the settlement (or of the deposit while pending). */
  time: number | null;
  /** Estimated seconds between deposit and settlement (block count × block time). */
  elapsedSec: number | null;
}

export interface LandingData {
  rows: SettlementRow[];
  intents: number;
  routed: number;
  /** Intents the protocol itself ended: routed, rejected, vetoed or expired. User cancellations are not counted. */
  protocolOutcomes: number;
  medianSec: number | null;
  headBlock: number;
}

const topicOf = (c: Contract, name: string): string => c.interface.getEvent(name)!.topicHash;

async function scan(address: string, topics: (string | string[])[], from: number, to: number): Promise<Log[]> {
  const p = getReadProvider();
  const out: Log[] = [];
  for (let s = from; s <= to; s += LOG_CHUNK) out.push(...(await p.getLogs({ address, topics, fromBlock: s, toBlock: Math.min(s + LOG_CHUNK - 1, to) })));
  return out;
}

/**
 * Seconds per block, measured from two recent blocks. The public RPC prunes older blocks, so times and durations of
 * past intents are estimated from block counts; the UI marks them with "~".
 */
async function secondsPerBlock(head: number): Promise<number> {
  const p = getReadProvider();
  try {
    const [a, b] = await Promise.all([
      p.send('eth_getBlockByNumber', [toBeHex(head), false]) as Promise<{ timestamp: string }>,
      p.send('eth_getBlockByNumber', [toBeHex(head - 60), false]) as Promise<{ timestamp: string }>,
    ]);
    const bt = (Number(BigInt(a.timestamp)) - Number(BigInt(b.timestamp))) / 60;
    return bt > 0 && bt < 120 ? bt : 6;
  } catch {
    return 6;
  }
}

export async function fetchLandingData(limit = 5): Promise<LandingData> {
  const address = getAddress(vaultAddress());
  const c = new Contract(address, vaultAbi(), getReadProvider());
  const head = await getReadProvider().getBlockNumber();
  const from = Math.max(vaultDeployBlock(), head - WINDOW_BLOCKS);

  const [deposits, settled, legs] = await Promise.all([
    scan(address, [topicOf(c, 'IntentDeposited')], from, head),
    scan(address, [settledEventNames().map((n) => topicOf(c, n))], from, head),
    scan(address, [topicOf(c, 'RouteLeg')], from, head),
  ]);

  const legsByTx = new Map<string, Log[]>();
  for (const l of legs) legsByTx.set(l.transactionHash, [...(legsByTx.get(l.transactionHash) ?? []), l]);

  const outcome = new Map<number, { status: IntentStatus; block: number; tx: string }>();
  for (const log of settled) {
    const parsed = c.interface.parseLog(log);
    if (parsed) outcome.set(Number(parsed.args['nonce']), { status: statusOfEvent(parsed.name), block: log.blockNumber, tx: log.transactionHash });
  }

  const all: SettlementRow[] = [];
  for (const log of deposits) {
    const parsed = c.interface.parseLog(log);
    if (!parsed) continue;
    const nonce = Number(parsed.args['nonce']);
    const o = outcome.get(nonce);
    const route =
      o?.status === 'Executed'
        ? (legsByTx.get(o.tx) ?? [])
            .map((l) => c.interface.parseLog(l))
            .filter((p): p is NonNullable<typeof p> => p?.name === 'RouteLeg' && Number(p.args['nonce']) === nonce)
            .map((p) => ({ pool: getAddress(String(p.args['pool'])), pct: Number(p.args['pct']), eco: toUtf8String(String(p.args['eco'])).replace(/\0+$/g, '') }))
        : null;
    all.push({ nonce, status: o?.status ?? 'Pending', route, depositBlock: log.blockNumber, settleBlock: o?.block ?? null, txHash: o?.tx ?? null, time: null, elapsedSec: null });
  }
  all.sort((a, b) => b.nonce - a.nonce);

  const rows = all.slice(0, limit);
  const executed = all.filter((r) => r.status === 'Executed');
  const bt = await secondsPerBlock(head);
  const now = Math.floor(Date.now() / 1000);
  const elapsed = (r: SettlementRow): number | null => (r.settleBlock ? Math.round((r.settleBlock - r.depositBlock) * bt) : null);
  for (const r of rows) {
    r.elapsedSec = elapsed(r);
    r.time = Math.round(now - (head - (r.settleBlock ?? r.depositBlock)) * bt);
  }

  const durations = executed.slice(0, 20).map(elapsed).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianSec = durations.length === 0 ? null : durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;

  const count = (s: IntentStatus) => all.filter((r) => r.status === s).length;
  return {
    rows,
    intents: all.length,
    routed: executed.length,
    protocolOutcomes: executed.length + count('Rejected') + count('Vetoed') + count('Expired'),
    medianSec,
    headBlock: head,
  };
}
