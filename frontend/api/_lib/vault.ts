import {
  Contract,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadBytes,
  zeroPadValue,
  type ContractRunner,
  type Log,
} from 'ethers';
import { VAULT_ADDRESS, VAULT_DEPLOY_BLOCK, explorerBlockUrl, getProvider, getRelayerWallet, retry } from './config.js';

const ABI = [
  'function executeAdjudicatedIntent(uint64 nonce, address user, uint256 amount, bytes32 promptHash, (address pool, uint8 pct, bytes8 eco)[] legs)',
  'function rejectIntent(uint64 nonce, address user, uint256 amount, bytes32 promptHash)',
  'function pending(uint64 nonce) view returns (bytes32)',
  'function relayer() view returns (address)',
  'function intentCount() view returns (uint64)',
  'event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt)',
  'event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 totalAmount)',
  'event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded)',
  'event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded)',
] as const;

const LOG_CHUNK = 1000;
/** pallet-revive tracks native balances at 10^-14 POT. */
const GRANULARITY = 10_000n;
const MAX_REFUND_RETURN = 50n * 10n ** 18n;
/** Minimum time budget (ms) that must remain after settlement to attempt forwarding the refund. */
const REFUND_MIN_BUDGET_MS = 14_000;

export interface Intent {
  nonce: number;
  user: string;
  amount: bigint;
  prompt: string;
  blockNumber: number;
}

export interface Settlement {
  kind: 'executed' | 'rejected' | 'cancelled';
  txHash: string;
  blockNumber: number;
}

export interface VerdictLeg {
  target_pool: string;
  percentage: number;
  eco_score: string;
}

export function vault(runner: ContractRunner = getProvider()): Contract {
  return new Contract(getAddress(VAULT_ADDRESS()), ABI, runner);
}

const nonceTopic = (n: number): string => zeroPadValue(toBeHex(n), 32);

async function logs(topics: (string | string[])[], from: number, to: number): Promise<Log[]> {
  const p = getProvider();
  const address = getAddress(VAULT_ADDRESS());
  const out: Log[] = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    out.push(...(await retry(() => p.getLogs({ address, topics, fromBlock: start, toBlock: Math.min(start + LOG_CHUNK - 1, to) }))));
  }
  return out;
}

/** Load the deposit event for `nonce`. `hintBlock` (the deposit block) avoids scanning from deployment. */
export async function loadIntent(nonce: number, hintBlock?: number): Promise<Intent | null> {
  const v = vault();
  const topic = v.interface.getEvent('IntentDeposited')!.topicHash;
  const head = await retry(() => getProvider().getBlockNumber());

  const tryRange = async (from: number, to: number): Promise<Intent | null> => {
    for (const log of await logs([topic, nonceTopic(nonce)], from, to)) {
      const parsed = v.interface.parseLog(log);
      if (parsed?.name === 'IntentDeposited') {
        return {
          nonce,
          user: getAddress(String(parsed.args['user'])),
          amount: parsed.args['amount'] as bigint,
          prompt: String(parsed.args['prompt']),
          blockNumber: log.blockNumber,
        };
      }
    }
    return null;
  };

  if (hintBlock !== undefined && hintBlock > 0) {
    const hit = await tryRange(Math.max(0, hintBlock - 1), Math.min(head, hintBlock + 1));
    if (hit) return hit;
  }
  return tryRange(VAULT_DEPLOY_BLOCK(), head);
}

export async function isPending(nonce: number): Promise<boolean> {
  return BigInt((await vault().getFunction('pending')(nonce)) as string) !== 0n;
}

export async function findSettlement(nonce: number, fromBlock: number): Promise<Settlement | null> {
  const v = vault();
  const kinds: Array<[Settlement['kind'], string]> = [
    ['executed', v.interface.getEvent('IntentExecuted')!.topicHash],
    ['rejected', v.interface.getEvent('IntentRejected')!.topicHash],
    ['cancelled', v.interface.getEvent('IntentCancelled')!.topicHash],
  ];
  const head = await retry(() => getProvider().getBlockNumber());
  const found = await logs([kinds.map(([, t]) => t), nonceTopic(nonce)], fromBlock, head);
  const log = found[0];
  if (!log) return null;
  const kind = kinds.find(([, t]) => t === log.topics[0])?.[0];
  return kind ? { kind, txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
}

const promptHashOf = (prompt: string): string => keccak256(toUtf8Bytes(prompt));

function encodeEco(label: string): string {
  const bytes = toUtf8Bytes(label);
  if (bytes.length === 0 || bytes.length > 8) throw new Error(`eco score "${label}" does not fit bytes8`);
  return zeroPadBytes(bytes, 8);
}

export interface SettleResult {
  txHash: string;
  blockNumber: number;
  refund?: { amount: string; txHash: string };
}

/**
 * Send the relayer's settlement transaction (execute or reject) and wait for inclusion.
 * The call is simulated first; a vault error is surfaced by name (e.g. IntentNotPending when a
 * concurrent poll already settled it).
 */
export async function settle(intent: Intent, approved: boolean, legs: VerdictLeg[], waitMs: number, deadline: number): Promise<SettleResult> {
  const w = getRelayerWallet();
  const c = vault(w);
  const hash = promptHashOf(intent.prompt);

  let fn: ReturnType<Contract['getFunction']>;
  let args: unknown[];
  if (approved) {
    fn = c.getFunction('executeAdjudicatedIntent');
    args = [intent.nonce, intent.user, intent.amount, hash, legs.map((l) => ({ pool: getAddress(l.target_pool), pct: l.percentage, eco: encodeEco(l.eco_score) }))];
  } else {
    fn = c.getFunction('rejectIntent');
    args = [intent.nonce, intent.user, intent.amount, hash];
  }

  await fn.staticCall(...args);
  const tx = (await fn(...args)) as { hash: string };
  const receipt = await getProvider().waitForTransaction(tx.hash, 1, waitMs);
  if (!receipt) return { txHash: tx.hash, blockNumber: 0 };
  if (receipt.status !== 1) throw new Error(`Settlement ${tx.hash} reverted`);

  const result: SettleResult = { txHash: tx.hash, blockNumber: receipt.blockNumber };
  // Forward the refund only if enough of the function's time budget remains; otherwise skip it
  // rather than risk being killed mid-transaction.
  const remaining = deadline - Date.now();
  if (remaining < REFUND_MIN_BUDGET_MS) return result;
  try {
    const refund = await forwardStorageRefund(intent.user, receipt.blockNumber, receipt.fee, Math.min(remaining - 4_000, 25_000));
    if (refund) result.refund = refund;
  } catch (err) {
    console.error('[api] refund forwarding failed:', err instanceof Error ? err.message : err);
  }
  return result;
}

/**
 * Settling frees the intent's storage slot and the chain refunds that deposit to the relayer, though
 * the depositor paid it. With no daemon to track balances, measure it from the settlement block:
 * refund = balance(B) - balance(B-1) + fee, valid only if the relayer sent exactly one tx in block B.
 */
async function forwardStorageRefund(user: string, blockNumber: number, feeWei: bigint, waitMs: number): Promise<{ amount: string; txHash: string } | null> {
  const p = getProvider();
  const w = getRelayerWallet();
  const block = (await p.send('eth_getBlockByNumber', [toBeHex(blockNumber), true])) as { transactions: Array<{ from: string }> };
  const mine = block.transactions.filter((t) => t.from.toLowerCase() === w.address.toLowerCase()).length;
  if (mine !== 1) return null; // ambiguous: another relayer tx shares the block

  const bal = async (n: number): Promise<bigint> => BigInt((await p.send('eth_getBalance', [w.address, toBeHex(n)])) as string);
  let refund = (await bal(blockNumber)) - (await bal(blockNumber - 1)) + feeWei;
  if (refund <= 0n) return null;
  if (refund > MAX_REFUND_RETURN) refund = MAX_REFUND_RETURN;
  refund -= refund % GRANULARITY;
  if (refund === 0n) return null;

  const tx = await w.sendTransaction({ to: getAddress(user), value: refund });
  const rc = await p.waitForTransaction(tx.hash, 1, waitMs);
  if (!rc || rc.status !== 1) return null;
  return { amount: refund.toString(), txHash: tx.hash };
}

export { explorerBlockUrl };
