/**
 * v2 vault operations for the serverless relayer: settlement (immediate or proposed), finalisation after the
 * safety delay, rejection, refunds after expiry, and route-lock matching.
 */
import { getAddress, keccak256, solidityPacked, AbiCoder, toBeHex, zeroPadValue, type Log } from 'ethers';
import { getProvider, getRelayerWallet, retry, type ChainCfg } from './config.js';
import { encodeEco, forwardStorageRefund, logs, promptHashOf, REFUND_MIN_BUDGET_MS, vault, type Intent, type SettleResult, type VerdictLeg } from './vault.js';

const ZERO32 = '0x' + '00'.repeat(32);

interface Leg {
  pool: string;
  pct: number;
  eco: string;
}

export interface Proposal {
  legsHash: string;
  readyAt: number;
  blockNumber: number;
}

const toLegs = (legs: VerdictLeg[]): Leg[] => legs.map((l) => ({ pool: getAddress(l.target_pool), pct: l.percentage, eco: encodeEco(l.eco_score) }));

/** Chained hash of the route, as the vault computes it for a route lock. */
export function routeLockOf(legs: VerdictLeg[]): string {
  let h = ZERO32;
  for (const l of legs) h = keccak256(solidityPacked(['bytes32', 'address', 'uint8'], [h, getAddress(l.target_pool), l.percentage]));
  return h;
}

export function legsHashOf(legs: VerdictLeg[]): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address pool, uint8 pct, bytes8 eco)[]'], [toLegs(legs)]));
}

const struct = (i: Intent) => ({
  nonce: i.nonce,
  user: i.user,
  amount: i.amount,
  promptHash: promptHashOf(i.prompt),
  routeLock: i.routeLock ?? ZERO32,
  expiry: i.expiry ?? 0,
});

export const isLocked = (i: Intent): boolean => (i.routeLock ?? ZERO32) !== ZERO32;

/** Whether the vault currently holds a proposal for `nonce`, and its parameters (from the SettlementProposed event). */
export async function findProposal(chain: ChainCfg, nonce: number, fromBlock: number): Promise<Proposal | null> {
  const v = vault(chain);
  const live = BigInt((await v.getFunction('proposed')(nonce)) as string) !== 0n;
  if (!live) return null;
  const head = await retry(() => getProvider(chain).getBlockNumber());
  const topic = v.interface.getEvent('SettlementProposed')!.topicHash;
  const found: Log[] = await logs(chain, [topic, zeroPadValue(toBeHex(nonce), 32)], fromBlock, head);
  const log = found[found.length - 1];
  if (!log) return null;
  const parsed = v.interface.parseLog(log);
  return parsed ? { legsHash: String(parsed.args['legsHash']), readyAt: Number(parsed.args['readyAt']), blockNumber: log.blockNumber } : null;
}

async function send(chain: ChainCfg, name: string, args: unknown[], waitMs: number): Promise<{ txHash: string; blockNumber: number; fee: bigint }> {
  const c = vault(chain, getRelayerWallet(chain));
  const fn = c.getFunction(name);
  await fn.staticCall(...args);
  const tx = (await fn(...args)) as { hash: string };
  const receipt = await getProvider(chain).waitForTransaction(tx.hash, 1, waitMs);
  if (!receipt) return { txHash: tx.hash, blockNumber: 0, fee: 0n };
  if (receipt.status !== 1) throw new Error(`${name} ${tx.hash} reverted`);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber, fee: receipt.fee };
}

async function protocolFee(chain: ChainCfg): Promise<bigint> {
  return BigInt((await vault(chain).getFunction('feeWei')()) as bigint);
}

async function withRefund(chain: ChainCfg, intent: Intent, res: { txHash: string; blockNumber: number; fee: bigint }, income: bigint, deduct: bigint, deadline: number): Promise<SettleResult> {
  const out: SettleResult = { txHash: res.txHash, blockNumber: res.blockNumber };
  const remaining = deadline - Date.now();
  if (res.blockNumber === 0 || remaining < REFUND_MIN_BUDGET_MS) return out;
  try {
    // The relayer's protocol fee is its reward, not the storage refund: take it out before forwarding.
    const refund = await forwardStorageRefund(chain, intent.user, res.blockNumber, res.fee - income, Math.min(remaining - 4_000, 25_000), deduct);
    if (refund) out.refund = refund;
  } catch (err) {
    console.error('[api] refund forwarding failed:', err instanceof Error ? err.message : err);
  }
  return out;
}

export interface Settled extends SettleResult {
  /** Set when the vault recorded a proposal instead of paying (settlement delay). */
  proposed?: boolean;
}

/** Execute an approved route. With a settlement delay the vault only records a proposal. */
export async function executeV2(chain: ChainCfg, intent: Intent, legs: VerdictLeg[], waitMs: number, deadline: number): Promise<Settled> {
  const delay = Number(await vault(chain).getFunction('delay')());
  const res = await send(chain, 'executeAdjudicatedIntent', [struct(intent), toLegs(legs)], waitMs);
  if (delay > 0) return { txHash: res.txHash, blockNumber: res.blockNumber, proposed: true };
  return withRefund(chain, intent, res, await protocolFee(chain), 0n, deadline);
}

/** Pay a proposal whose delay has passed. Anyone may; the relayer does so to collect its fee. */
export async function finalizeV2(chain: ChainCfg, intent: Intent, legs: VerdictLeg[], proposal: Proposal, waitMs: number, deadline: number): Promise<SettleResult> {
  const res = await send(chain, 'finalizeSettlement', [struct(intent), toLegs(legs), proposal.readyAt], waitMs);
  // The freed `proposed` slot is the relayer's own money (it paid for the proposal), so it must not be forwarded.
  // Settling also spends part of the freed deposits on the user's new hub-position slots; whatever is left over
  // is the depositor's. Deduct the whole proposal cost (gas included, which the relayer is fairly recouping). If it
  // cannot be measured, forward nothing rather than risk paying out the relayer's own funds.
  let deduct: bigint | null = null;
  try {
    const topics = [vault(chain).interface.getEvent('SettlementProposed')!.topicHash, zeroPadValue(toBeHex(intent.nonce), 32)];
    const hash = (await logs(chain, topics, proposal.blockNumber, proposal.blockNumber))[0]?.transactionHash;
    const earlier = hash ? await getProvider(chain).getTransactionReceipt(hash) : null;
    if (earlier) deduct = earlier.fee;
  } catch {
    deduct = null;
  }
  if (deduct === null) return { txHash: res.txHash, blockNumber: res.blockNumber };
  return withRefund(chain, intent, res, await protocolFee(chain), deduct, deadline);
}

export async function rejectV2(chain: ChainCfg, intent: Intent, waitMs: number, deadline: number): Promise<SettleResult> {
  const res = await send(chain, 'rejectIntent', [struct(intent)], waitMs);
  return withRefund(chain, intent, res, await protocolFee(chain), 0n, deadline);
}

/** Refund an expired intent in full (anyone may call; the relayer pays the gas so the depositor does not have to). */
export async function refundExpiredV2(chain: ChainCfg, intent: Intent, waitMs: number): Promise<SettleResult> {
  const res = await send(chain, 'refundExpired', [struct(intent)], waitMs);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

