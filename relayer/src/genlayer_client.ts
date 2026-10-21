import { createAccount, createClient } from 'genlayer-js';
import * as chains from 'genlayer-js/chains';
import { TransactionHashVariant, TransactionStatus, transactionsStatusNumberToName } from 'genlayer-js/types';
import type { RouteAllocation } from './portaldot_client.js';

export interface AdjudicationResult {
  approved: boolean;
  /** Per-pool decision trace emitted by the solver (opaque to the relayer). */
  trace: unknown;
  /** Validator address -> vote ("agree" | "disagree" | "idle" | ...). */
  votes: Record<string, string>;
  explorerUrl: string;
  /** Present when `approved` is false. */
  reason?: string;
  allocations: RouteAllocation[];
  validatorsAgreed: number;
  validatorsTotal: number;
  txHash: string;
}

interface SolverPayload {
  trace: unknown;
  nonce: number;
  status: 'APPROVED' | 'REJECTED';
  reason?: string;
  allocations: RouteAllocation[];
}

/** GenLayer Studio explorer (matches the studionet chain). */
const GENLAYER_EXPLORER = process.env['GENLAYER_EXPLORER_URL']?.trim() || 'https://explorer-studio.genlayer.com';

const POLL_INTERVAL_MS = Number(process.env['GENLAYER_POLL_INTERVAL_MS'] ?? 6000);
const MAX_POLLS = Number(process.env['GENLAYER_MAX_POLLS'] ?? 200);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) throw new Error(`${name} is not set`);
  return value.trim();
}

function asHex(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} must be a 0x-prefixed hex string`);
  return value as `0x${string}`;
}

/** GENLAYER_CHAIN: studionet (default, gasless), testnetAsimov, testnetBradbury or localnet. */
function selectChain() {
  const name = process.env['GENLAYER_CHAIN']?.trim() || 'studionet';
  const chain = (chains as Record<string, unknown>)[name];
  if (!chain) throw new Error(`Unknown GENLAYER_CHAIN "${name}"`);
  return chain as typeof chains.studionet;
}

type Client = ReturnType<typeof createClient>;
let cached: { client: Client; contract: `0x${string}` } | undefined;

function getClient(): { client: Client; contract: `0x${string}` } {
  if (cached) return cached;
  const account = createAccount(asHex(requireEnv('GENLAYER_PRIVATE_KEY'), 'GENLAYER_PRIVATE_KEY'));
  const endpoint = process.env['GENLAYER_RPC_URL'];
  const client = createClient({
    chain: selectChain(),
    account,
    ...(endpoint && endpoint.trim().length > 0 ? { endpoint: endpoint.trim() } : {}),
  });
  cached = { client, contract: asHex(requireEnv('GENLAYER_CONTRACT_ADDRESS'), 'GENLAYER_CONTRACT_ADDRESS') };
  return cached;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strictly validate the JSON emitted by the Python solver. */
export function parseSolverPayload(raw: string, expectedNonce: number, expectedRef?: string): SolverPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GenLayer returned non-JSON payload');
  }
  if (!isRecord(parsed)) throw new Error('GenLayer payload is not an object');
  if (parsed['nonce'] !== expectedNonce) {
    throw new Error(`GenLayer payload nonce ${String(parsed['nonce'])} != expected ${expectedNonce}`);
  }
  if (expectedRef !== undefined && parsed['ref'] !== expectedRef) {
    throw new Error(`GenLayer payload is for a different intent (ref ${String(parsed['ref'])} != ${expectedRef})`);
  }
  const status = parsed['status'];
  if (status !== 'APPROVED' && status !== 'REJECTED') throw new Error(`Unknown payload status: ${String(status)}`);

  const rawAllocations = parsed['allocations'];
  if (!Array.isArray(rawAllocations)) throw new Error('GenLayer payload missing allocations');

  const allocations: RouteAllocation[] = rawAllocations.map((entry: unknown, i) => {
    if (!isRecord(entry)) throw new Error(`Allocation #${i} is not an object`);
    const { target_pool, percentage, eco_score } = entry;
    if (typeof target_pool !== 'string' || !EVM_ADDRESS_RE.test(target_pool)) throw new Error(`Allocation #${i}: bad target_pool`);
    if (typeof percentage !== 'number' || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      throw new Error(`Allocation #${i}: bad percentage`);
    }
    if (typeof eco_score !== 'string' || eco_score.length === 0 || eco_score.length > 8) {
      throw new Error(`Allocation #${i}: bad eco_score`);
    }
    return { target_pool, percentage, eco_score };
  });

  if (status === 'APPROVED') {
    const total = allocations.reduce((sum, a) => sum + a.percentage, 0);
    if (total !== 100) throw new Error(`Allocation percentages sum to ${total}, expected 100`);
    if (new Set(allocations.map((a) => a.target_pool.toLowerCase())).size !== allocations.length) {
      throw new Error('Duplicate pools in allocation');
    }
  }

  const reason = parsed['reason'];
  return {
    trace: parsed['trace'] ?? null,
    nonce: expectedNonce,
    status,
    allocations,
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/** Normalise the status across networks: enum name, string name, or numeric code. */
function statusNameOf(statusName: unknown, status: unknown): string {
  if (typeof statusName === 'string' && statusName.length > 0) return statusName;
  if (typeof status === 'string' && Number.isNaN(Number(status))) return status;
  const table = transactionsStatusNumberToName as Record<string, string>;
  return table[String(status)] ?? String(status);
}

function countVotes(votes: Record<string, string> | undefined): { agreed: number; total: number } {
  if (!votes) return { agreed: 0, total: 0 };
  const values = Object.values(votes);
  return { agreed: values.filter((v) => v.toUpperCase() === 'AGREE').length, total: values.length };
}

/**
 * Submit `adjudicate_intent` to the GenLayer Intelligent Contract, wait until validators reach
 * consensus (ACCEPTED), then read back and validate the agreed route.
 */
export async function triggerGenLayerAdjudication(
  ref: string,
  nonce: number,
  prompt: string,
  amount: string,
): Promise<AdjudicationResult> {
  const { client, contract } = getClient();

  const txHash = await client.writeContract({
    address: contract,
    functionName: 'adjudicate_ref',
    args: [ref, prompt, BigInt(amount)],
    value: 0n,
  });
  console.log(`[GENLAYER] Intent #${nonce} submitted: ${String(txHash)}`);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    interval: POLL_INTERVAL_MS,
    retries: MAX_POLLS,
  });

  // Studionet receipts expose `status` (and lowercase vote names); other networks use `statusName`.
  const final = statusNameOf(receipt.statusName, (receipt as { status?: unknown }).status);
  if (final !== TransactionStatus.ACCEPTED && final !== TransactionStatus.FINALIZED) {
    throw new Error(`GenLayer consensus not met for intent #${nonce}: ${String(final)}`);
  }

  const { agreed, total } = countVotes(receipt.consensus_data?.votes);

  // View calls read the latest *non-final* state so we do not wait out the appeal window.
  const raw = await client.readContract({
    address: contract,
    functionName: 'get_result_ref',
    args: [ref],
    transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
  });
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`GenLayer has no stored result for intent #${nonce}`);
  }

  const payload = parseSolverPayload(raw, nonce, ref);
  console.log(
    `[GENLAYER] Intent #${nonce} ${payload.status} (${agreed}/${total} validators agreed)` +
      (payload.reason ? ` — ${payload.reason}` : ''),
  );

  return {
    approved: payload.status === 'APPROVED',
    trace: payload.trace,
    votes: receipt.consensus_data?.votes ?? {},
    explorerUrl: `${GENLAYER_EXPLORER}/tx/${String(txHash)}`,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    allocations: payload.allocations,
    validatorsAgreed: agreed,
    validatorsTotal: total,
    txHash: String(txHash),
  };
}
