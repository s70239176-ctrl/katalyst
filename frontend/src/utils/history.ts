/**
 * Trustless reads straight from the vault's events: per-wallet intent history and network-wide
 * statistics. No indexer or database is involved; the relayer API only enriches this data.
 */
import { Contract, getAddress, toBeHex, toUtf8String, zeroPadValue, type Log } from 'ethers';
import { vaultAddress, vaultDeployBlock, getReadProvider } from './substrate';
import type { IntentOutcome, NetworkStats, RouteAllocation, UserIntent } from './types';

const LOG_CHUNK_BLOCKS = 1000;

const ABI = [
  'event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt)',
  'event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 totalAmount)',
  'event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount)',
  'event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded)',
  'event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded)',
] as const;

function vault(): Contract {
  return new Contract(getAddress(vaultAddress()), ABI, getReadProvider());
}

const topic = (c: Contract, name: string): string => c.interface.getEvent(name)!.topicHash;

async function scan(topics: (string | string[] | null)[]): Promise<Log[]> {
  const p = getReadProvider();
  const head = await p.getBlockNumber();
  const address = getAddress(vaultAddress());
  const all: Log[] = [];
  for (let from = vaultDeployBlock(); from <= head; from += LOG_CHUNK_BLOCKS) {
    const to = Math.min(from + LOG_CHUNK_BLOCKS - 1, head);
    all.push(...(await p.getLogs({ address, topics, fromBlock: from, toBlock: to })));
  }
  return all;
}

function parse(c: Contract, log: Log) {
  try {
    return c.interface.parseLog(log);
  } catch {
    return null;
  }
}

function routeFrom(c: Contract, legs: Log[]): RouteAllocation[] {
  return legs
    .map((l) => parse(c, l))
    .filter((p): p is NonNullable<typeof p> => p?.name === 'RouteLeg')
    .map((p) => ({
      targetPool: getAddress(String(p.args['pool'])),
      percentage: Number(p.args['pct']),
      ecoScore: toUtf8String(String(p.args['eco'])).replace(/\0+$/g, ''),
      amount: p.args['amount'] as bigint,
    }));
}

/** Every intent a wallet has deposited, newest first, with its settlement outcome when there is one. */
export async function fetchUserIntents(user: string): Promise<UserIntent[]> {
  const c = vault();
  const userTopic = zeroPadValue(getAddress(user), 32);

  const [deposits, settled, legs] = await Promise.all([
    scan([topic(c, 'IntentDeposited'), null, userTopic]),
    scan([[topic(c, 'IntentExecuted'), topic(c, 'IntentRejected'), topic(c, 'IntentCancelled')], null, userTopic]),
    scan([topic(c, 'RouteLeg')]),
  ]);

  const legsByTx = new Map<string, Log[]>();
  for (const l of legs) legsByTx.set(l.transactionHash, [...(legsByTx.get(l.transactionHash) ?? []), l]);

  const outcomes = new Map<number, IntentOutcome>();
  for (const log of settled) {
    const parsed = parse(c, log);
    if (!parsed) continue;
    const nonce = Number(parsed.args['nonce']);
    if (parsed.name === 'IntentExecuted') {
      outcomes.set(nonce, {
        status: 'Executed',
        route: routeFrom(c, legsByTx.get(log.transactionHash) ?? []).filter(() => true),
        totalAmount: parsed.args['totalAmount'] as bigint,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    } else {
      outcomes.set(nonce, {
        status: parsed.name === 'IntentRejected' ? 'Rejected' : 'Cancelled',
        route: null,
        totalAmount: parsed.args['refunded'] as bigint,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
  }

  return deposits
    .map((log) => {
      const parsed = parse(c, log);
      if (!parsed) return null;
      const nonce = Number(parsed.args['nonce']);
      const intent: UserIntent = {
        nonce,
        user: getAddress(String(parsed.args['user'])),
        amount: parsed.args['amount'] as bigint,
        prompt: String(parsed.args['prompt']),
        depositTx: log.transactionHash,
        depositBlock: log.blockNumber,
        outcome: outcomes.get(nonce) ?? null,
      };
      return intent;
    })
    .filter((i): i is UserIntent => i !== null)
    .sort((a, b) => b.nonce - a.nonce);
}

/** Network-wide counters derived from vault events since deployment. */
export async function fetchNetworkStats(): Promise<NetworkStats> {
  const c = vault();
  const head = await getReadProvider().getBlockNumber();
  const [deposits, executed, rejected, cancelled] = await Promise.all([
    scan([topic(c, 'IntentDeposited')]),
    scan([topic(c, 'IntentExecuted')]),
    scan([topic(c, 'IntentRejected')]),
    scan([topic(c, 'IntentCancelled')]),
  ]);

  const users = new Set<string>();
  let volume = 0n;
  for (const log of deposits) {
    const parsed = parse(c, log);
    if (!parsed) continue;
    users.add(String(parsed.args['user']).toLowerCase());
    volume += parsed.args['amount'] as bigint;
  }
  return {
    deposits: deposits.length,
    executed: executed.length,
    rejected: rejected.length,
    cancelled: cancelled.length,
    uniqueUsers: users.size,
    volume,
    headBlock: head,
  };
}

export const nonceTopic = (nonce: number): string => zeroPadValue(toBeHex(nonce), 32);
