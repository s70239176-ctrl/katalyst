import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
  zeroPadBytes,
  type EventLog,
  type Log,
} from 'ethers';
import { VAULT_ABI } from './vault_abi.js';

export const PORTALDOT_EVM_RPC = process.env['PORTALDOT_EVM_RPC'] ?? 'https://test-evm-rpc-v3.portaldot.dev';
export const PORTALDOT_CHAIN_ID = Number(process.env['PORTALDOT_CHAIN_ID'] ?? 420420777);

const POLL_INTERVAL_MS = Number(process.env['PORTALDOT_POLL_INTERVAL_MS'] ?? 4000);
const LOG_CHUNK_BLOCKS = 1000;
const BACKFILL_BLOCKS = Number(process.env['PORTALDOT_BACKFILL_BLOCKS'] ?? 5000);
const TX_TIMEOUT_MS = 180_000;

export interface RouteAllocation {
  target_pool: string;
  percentage: number;
  eco_score: string;
}

/** An `IntentDeposited` event, i.e. everything the vault needs back to settle the intent. */
export interface DepositedIntent {
  nonce: number;
  user: string;
  /** Wei-denominated (18 decimals) decimal string, as emitted by the vault. */
  amount: string;
  prompt: string;
  blockNumber: number;
}

export interface InclusionReceipt {
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
  /** Gas fee the relayer paid for this transaction, in wei. */
  feeWei: bigint;
}

let provider: JsonRpcProvider | undefined;
let wallet: Wallet | undefined;

export function getProvider(): JsonRpcProvider {
  // eth-rpc on Portaldot does not support JSON-RPC batching.
  provider ??= new JsonRpcProvider(PORTALDOT_EVM_RPC, PORTALDOT_CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  return provider;
}

export function getRelayerWallet(): Wallet {
  if (!wallet) {
    const key = process.env['RELAYER_PRIVATE_KEY']?.trim();
    if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set (see .env.example)');
    wallet = new Wallet(key, getProvider());
  }
  return wallet;
}

function vaultContract(address: string, runner: Wallet | JsonRpcProvider): Contract {
  return new Contract(getAddress(address), VAULT_ABI, runner);
}

export function promptHashOf(prompt: string): string {
  return keccak256(toUtf8Bytes(prompt));
}

/** "A-Tier" -> bytes8, right-padded with zero bytes (matches the Solidity `bytes8 eco`). */
export function encodeEco(label: string): string {
  const bytes = toUtf8Bytes(label);
  if (bytes.length === 0 || bytes.length > 8) throw new Error(`eco score "${label}" does not fit bytes8`);
  return zeroPadBytes(bytes, 8);
}

export function explorerUrlForBlock(blockNumber: number): string {
  const base = (process.env['PORTALDOT_EXPLORER_URL']?.trim() || 'https://node-console.portaldot.dev').replace(/\/$/, '');
  // The console defaults to the live network; the testnet's blocks need its own node.
  const node = base.includes('node-console.portaldot.dev') ? '?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev' : '';
  return `${base}/${node}#/explorer/query/${blockNumber}`;
}

/** True while the intent's commitment is still stored, i.e. not yet executed/rejected/cancelled. */
export async function isIntentPending(contractAddress: string, nonce: number): Promise<boolean> {
  const c = vaultContract(contractAddress, getProvider());
  const commitment = (await c['pending']!(nonce)) as string;
  return BigInt(commitment) !== 0n;
}

function toIntent(log: Log | EventLog, contract: Contract): DepositedIntent | null {
  const parsed = contract.interface.parseLog(log);
  if (!parsed || parsed.name !== 'IntentDeposited') return null;
  const nonce = Number(parsed.args['nonce']);
  if (!Number.isSafeInteger(nonce)) return null;
  return {
    nonce,
    user: getAddress(String(parsed.args['user'])),
    amount: (parsed.args['amount'] as bigint).toString(),
    prompt: String(parsed.args['prompt']),
    blockNumber: log.blockNumber,
  };
}

/**
 * Poll the vault for `IntentDeposited` events (eth-rpc has no log filters/subscriptions).
 * Starts `BACKFILL_BLOCKS` back (or at VAULT_START_BLOCK) so a restarted relayer picks up intents
 * that are still pending. Returns a stop function.
 */
export async function listenToVaultEvents(
  contractAddress: string,
  callback: (intent: DepositedIntent) => void,
): Promise<() => void> {
  const p = getProvider();
  const contract = vaultContract(contractAddress, p);
  const topic = contract.interface.getEvent('IntentDeposited')!.topicHash;

  const head = await p.getBlockNumber();
  const configured = process.env['VAULT_START_BLOCK'];
  let cursor = configured ? Number(configured) : Math.max(0, head - BACKFILL_BLOCKS);
  let stopped = false;

  const tick = async (): Promise<void> => {
    try {
      const latest = await p.getBlockNumber();
      while (cursor <= latest && !stopped) {
        const to = Math.min(cursor + LOG_CHUNK_BLOCKS - 1, latest);
        const logs = await p.getLogs({ address: getAddress(contractAddress), topics: [topic], fromBlock: cursor, toBlock: to });
        for (const log of logs) {
          const intent = toIntent(log, contract);
          if (intent) callback(intent);
        }
        cursor = to + 1;
      }
    } catch (err) {
      console.error('[PORTALDOT] log poll failed:', err instanceof Error ? err.message : err);
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function waitForInclusion(txHash: string): Promise<InclusionReceipt> {
  const receipt = await getProvider().waitForTransaction(txHash, 1, TX_TIMEOUT_MS);
  if (!receipt) throw new Error(`Timed out waiting for ${txHash}`);
  if (receipt.status !== 1) throw new Error(`Transaction ${txHash} reverted on-chain`);
  return { txHash, blockNumber: receipt.blockNumber, explorerUrl: explorerUrlForBlock(receipt.blockNumber), feeWei: receipt.fee };
}

/**
 * Settle an intent on Portaldot with the route agreed by GenLayer consensus.
 * The call is simulated first so a vault rejection surfaces as a decoded error name.
 */
export async function submitAdjudicatedExecution(
  contractAddress: string,
  intent: DepositedIntent,
  allocations: RouteAllocation[],
): Promise<InclusionReceipt> {
  const c = vaultContract(contractAddress, getRelayerWallet());
  const legs = allocations.map((a) => ({ pool: getAddress(a.target_pool), pct: a.percentage, eco: encodeEco(a.eco_score) }));
  const args = [intent.nonce, intent.user, BigInt(intent.amount), promptHashOf(intent.prompt), legs] as const;

  const fn = c['executeAdjudicatedIntent']!;
  await fn.staticCall(...args);
  const tx = (await fn(...args)) as { hash: string };
  return waitForInclusion(tx.hash);
}

/** Refund an intent the solver rejected (prompt injection, no compliant pool, ...). */
export async function submitRejection(contractAddress: string, intent: DepositedIntent): Promise<InclusionReceipt> {
  const c = vaultContract(contractAddress, getRelayerWallet());
  const args = [intent.nonce, intent.user, BigInt(intent.amount), promptHashOf(intent.prompt)] as const;

  const fn = c['rejectIntent']!;
  await fn.staticCall(...args);
  const tx = (await fn(...args)) as { hash: string };
  return waitForInclusion(tx.hash);
}

/** Native balance in wei, read raw so ethers' short-lived result cache cannot return a stale value. */
export async function balanceOfWei(address: string): Promise<bigint> {
  return BigInt((await getProvider().send('eth_getBalance', [address, 'latest'])) as string);
}

// pallet-revive tracks native balances at 10^-14 POT; keep transfers on that granularity.
const NATIVE_GRANULARITY_WEI = 10_000n;

/**
 * Settling an intent frees its storage slot, and the chain refunds that storage deposit to whoever
 * freed it (the relayer) even though the depositor paid it. Forward that refund to the depositor.
 * `refund = balance delta + gas fee paid`, valid because settlements are serialized.
 */
export async function returnStorageRefund(
  user: string,
  balanceBefore: bigint,
  settlement: InclusionReceipt,
): Promise<{ refunded: bigint; txHash?: string }> {
  const maxReturn = BigInt(Math.floor(Number(process.env['RELAYER_MAX_REFUND_RETURN_TPOT'] ?? 50))) * 10n ** 18n;
  const w = getRelayerWallet();
  const delta = (await balanceOfWei(w.address)) - balanceBefore;
  let refund = delta + settlement.feeWei;
  if (refund <= 0n) return { refunded: 0n };
  if (refund > maxReturn) refund = maxReturn;
  refund -= refund % NATIVE_GRANULARITY_WEI;
  if (refund === 0n) return { refunded: 0n };

  const tx = await w.sendTransaction({ to: getAddress(user), value: refund });
  const inc = await waitForInclusion(tx.hash);
  return { refunded: refund, txHash: inc.txHash };
}

export async function disconnect(): Promise<void> {
  provider?.destroy();
  provider = undefined;
  wallet = undefined;
}
