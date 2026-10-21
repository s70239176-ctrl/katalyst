/**
 * Vault ABIs for the dApp, per contract generation. v1 is `KatalystVault`; v2 is `KatalystVaultV2` (+ PoolHub).
 * Everything that reads or writes the vault takes its ABI and event names from here so a chain's `version` is the
 * only switch.
 */
import type { Log } from 'ethers';
import { activeChain } from './chains';
import type { IntentStatus } from './types';

const INTENT = '(uint64 nonce, address user, uint256 amount, bytes32 promptHash, bytes32 routeLock, uint64 expiry)';

export const V1_ABI = [
  'function depositIntent(string prompt) payable returns (uint64 nonce)',
  'function cancelIntent(uint64 nonce, uint256 amount, bytes32 promptHash)',
  'function pending(uint64 nonce) view returns (bytes32)',
  'event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt)',
  'event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 totalAmount)',
  'event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount)',
  'event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded)',
  'event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded)',
] as const;

export const V2_ABI = [
  'function depositIntent(string prompt, bytes32 routeLock) payable returns (uint64 nonce)',
  `function cancelIntent(${INTENT} i)`,
  `function refundExpired(${INTENT} i)`,
  'function pending(uint64 nonce) view returns (bytes32)',
  'function proposed(uint64 nonce) view returns (bytes32)',
  'event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt, bytes32 routeLock, uint64 expiry)',
  'event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 netAmount, uint256 fee)',
  'event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount)',
  'event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded, uint256 fee)',
  'event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded)',
  'event IntentExpired(uint64 indexed nonce, address indexed user, uint256 refunded, address indexed caller)',
  'event SettlementProposed(uint64 indexed nonce, bytes32 legsHash, uint64 readyAt)',
  'event SettlementVetoed(uint64 indexed nonce, address indexed user, uint256 refunded)',
] as const;

export const HUB_ABI = [
  'function position(address pool, address user) view returns (uint256)',
  'function withdraw(address pool, uint256 amount)',
  'function pools(address pool) view returns (bool active, bytes8 eco)',
  'function isPool(address pool) view returns (bool)',
  'event PoolSet(address indexed pool, bool active, bytes8 eco)',
] as const;

export const isV2 = (): boolean => activeChain().version === 2;
export const vaultAbi = (): readonly string[] => (isV2() ? V2_ABI : V1_ABI);

/** Events that end an intent's life, in the active vault's ABI. */
export const settledEventNames = (): string[] =>
  isV2() ? ['IntentExecuted', 'IntentRejected', 'IntentCancelled', 'IntentExpired', 'SettlementVetoed'] : ['IntentExecuted', 'IntentRejected', 'IntentCancelled'];

const STATUS: Record<string, Exclude<IntentStatus, 'Pending'>> = {
  IntentExecuted: 'Executed',
  IntentRejected: 'Rejected',
  IntentCancelled: 'Cancelled',
  IntentExpired: 'Expired',
  SettlementVetoed: 'Vetoed',
};

export const statusOfEvent = (name: string): Exclude<IntentStatus, 'Pending'> => STATUS[name] ?? 'Cancelled';

/** Amount routed to pools: the whole deposit in v1, net of the fixed fee in v2. */
export function executedAmount(args: Record<string, unknown>): bigint {
  return (args['netAmount'] ?? args['totalAmount']) as bigint;
}

/** Protocol fee charged on an executed or rejected intent (v2 only). */
export const feeOf = (args: Record<string, unknown>): bigint | undefined => (typeof args['fee'] === 'bigint' ? args['fee'] : undefined);

export type { Log };
