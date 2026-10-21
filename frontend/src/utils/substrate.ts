/**
 * Chain access for PortaldotV3. Despite the file name (kept from the original layout), the vault is
 * a Solidity contract on pallet-revive, so all calls go through the EVM RPC with an injected
 * EVM wallet (MetaMask etc.). Substrate-side helpers are limited to address mapping.
 */
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  toUtf8String,
  zeroPadValue,
  type Eip1193Provider,
  type EventLog,
  type Log,
} from 'ethers';
import { encodeAddress } from '@polkadot/util-crypto';
import { hexToU8a, u8aConcat } from '@polkadot/util';
import { activeChain, blockUrl, chainId, readRpcUrl, rpcUrl, vaultAddress, vaultDeployBlock } from './chains';
import { HUB_ABI, executedAmount, feeOf, isV2, settledEventNames, statusOfEvent, vaultAbi } from './vaultAbi';
import {
  SS58_PREFIX,
  parsePot,
  type IntentOutcome,
  type RouteAllocation,
  type WalletState,
} from './types';

export { rpcUrl, vaultAddress, vaultDeployBlock };

const LOG_CHUNK_BLOCKS = 1000;


const readProviders = new Map<string, JsonRpcProvider>();

/** Read-only provider for the active chain. eth-rpc on Portaldot does not support JSON-RPC batching. */
export function getReadProvider(): JsonRpcProvider {
  const c = activeChain();
  let p = readProviders.get(c.key);
  if (!p) {
    p = new JsonRpcProvider(readRpcUrl(c), c.chainId, { staticNetwork: true, batchMaxCount: 1 });
    readProviders.set(c.key, p);
  }
  return p;
}

/** Resolves true once the node answers. */
export async function pingNetwork(): Promise<boolean> {
  try {
    await getReadProvider().getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

function injected(): Eip1193Provider {
  if (!window.ethereum) throw new Error('No EVM wallet found. Install MetaMask (or a compatible wallet).');
  return window.ethereum;
}

/** The native (SS58) account that holds an EVM address's $POT: H160 followed by twelve 0xEE bytes. */
export function nativeAccountOf(evmAddress: string): string {
  return encodeAddress(u8aConcat(hexToU8a(evmAddress), new Uint8Array(12).fill(0xee)), SS58_PREFIX);
}

async function ensureChain(wallet: Eip1193Provider): Promise<void> {
  const c = activeChain();
  const chainIdHex = toBeHex(c.chainId);
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  } catch (err) {
    // 4902 = chain unknown to the wallet: add it, which also switches to it.
    if ((err as { code?: number }).code !== 4902) throw err;
    await wallet.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chainIdHex,
          chainName: c.name,
          nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 },
          rpcUrls: [c.rpcUrl],
        },
      ],
    });
  }
}

/** Explorer link for a block on the active chain ('' when the chain has no explorer). */
export const explorerBlockUrl = (blockNumber: number): string => blockUrl(blockNumber);

/** Chain id the injected wallet is currently on, or null when there is no wallet. */
export async function getWalletChainId(): Promise<number | null> {
  if (!window.ethereum) return null;
  try {
    return Number(BigInt((await window.ethereum.request({ method: 'eth_chainId' })) as string));
  } catch {
    return null;
  }
}

/** The wallet's already-authorised account, without prompting. Null when not connected. */
export async function getConnectedWallet(): Promise<WalletState | null> {
  if (!window.ethereum) return null;
  try {
    const accounts = (await window.ethereum.request({ method: 'eth_accounts' })) as string[];
    const first = accounts[0];
    if (!first) return null;
    const address = getAddress(first);
    return { address, native: nativeAccountOf(address) };
  } catch {
    return null;
  }
}

/** Ask the wallet to switch to (or add) the active chain. */
export async function switchToChain(): Promise<void> {
  await ensureChain(injected());
}

/** Subscribe to account / network changes in the injected wallet. Returns an unsubscribe. */
export function subscribeWalletEvents(onChange: () => void): () => void {
  const w = window.ethereum;
  if (!w?.on || !w.removeListener) return () => undefined;
  w.on('accountsChanged', onChange);
  w.on('chainChanged', onChange);
  return () => {
    w.removeListener?.('accountsChanged', onChange);
    w.removeListener?.('chainChanged', onChange);
  };
}

/** Ask the injected wallet for an account and make sure it is on PortaldotV3. */
export async function connectWallet(): Promise<WalletState> {
  const wallet = injected();
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
  const first = accounts[0];
  if (!first) throw new Error('The wallet exposes no accounts');
  await ensureChain(wallet);
  const address = getAddress(first);
  return { address, native: nativeAccountOf(address) };
}

/** Poll the free $POT balance (wei) of an address. Returns a stop function. */
export function subscribeBalance(address: string, onBalance: (wei: bigint) => void, intervalMs = 6000): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      const wei = BigInt(await getReadProvider().send('eth_getBalance', [address, 'latest']));
      if (!stopped) onBalance(wei);
    } catch {
      /* transient RPC error: keep the last value */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface DepositReceipt {
  nonce: number;
  amount: bigint;
  promptHash: string;
  txHash: string;
  blockNumber: number;
  /** v2: what the vault committed to; needed to cancel or refund. */
  user: string;
  routeLock: string;
  expiry: number;
}

const NO_LOCK = '0x' + '00'.repeat(32);

function parseVaultLog(contract: Contract, log: Log | EventLog) {
  try {
    return contract.interface.parseLog(log);
  } catch {
    return null;
  }
}

/**
 * Lock `potAmount` $POT in the vault together with `promptText`; the wallet signs.
 * Resolves once the transaction is mined.
 */
export async function depositIntent(
  contractAddress: string,
  promptText: string,
  potAmount: string,
  routeLock: string = NO_LOCK,
): Promise<DepositReceipt> {
  if (!contractAddress) throw new Error('VITE_VAULT_ADDRESS is not configured');
  const value = parsePot(potAmount);
  if (value === 0n) throw new Error('Deposit must be greater than zero');
  const prompt = promptText.trim();
  if (prompt.length === 0) throw new Error('Describe your intent first');

  const signer = await new BrowserProvider(injected()).getSigner();
  const vault = new Contract(getAddress(contractAddress), vaultAbi(), signer);
  const fn = vault.getFunction('depositIntent');
  const args: unknown[] = isV2() ? [prompt, routeLock] : [prompt];

  await fn.staticCall(...args, { value }); // surfaces vault errors before the wallet prompt
  const tx = await fn(...args, { value });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Deposit transaction failed');

  for (const log of receipt.logs) {
    const parsed = parseVaultLog(vault, log);
    if (parsed?.name === 'IntentDeposited') {
      return {
        nonce: Number(parsed.args['nonce']),
        amount: parsed.args['amount'] as bigint,
        promptHash: keccak256(toUtf8Bytes(prompt)),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        user: getAddress(String(parsed.args['user'])),
        routeLock: isV2() ? String(parsed.args['routeLock']) : NO_LOCK,
        expiry: isV2() ? Number(parsed.args['expiry']) : 0,
      };
    }
  }
  throw new Error('IntentDeposited event not found in the receipt');
}

/** Depositor escape hatch while the relayer has not settled the intent yet. */
export async function cancelIntent(contractAddress: string, deposit: DepositReceipt): Promise<string> {
  const signer = await new BrowserProvider(injected()).getSigner();
  const vault = new Contract(getAddress(contractAddress), vaultAbi(), signer);
  const fn = vault.getFunction('cancelIntent');
  const args: unknown[] = isV2()
    ? [{ nonce: deposit.nonce, user: deposit.user, amount: deposit.amount, promptHash: deposit.promptHash, routeLock: deposit.routeLock, expiry: deposit.expiry }]
    : [deposit.nonce, deposit.amount, deposit.promptHash];
  await fn.staticCall(...args);
  const tx = await fn(...args);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Cancel transaction failed');
  return receipt.hash;
}

/** v2: pull `amount` of the caller's position in `pool` back from the PoolHub. Always allowed, even while paused. */
export async function withdrawPosition(hubAddress: string, pool: string, amount: bigint): Promise<{ txHash: string; blockNumber: number }> {
  const signer = await new BrowserProvider(injected()).getSigner();
  const hub = new Contract(getAddress(hubAddress), HUB_ABI, signer);
  const fn = hub.getFunction('withdraw');
  await fn.staticCall(getAddress(pool), amount);
  const tx = await fn(getAddress(pool), amount);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Withdrawal failed');
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function logsBetween(
  provider: JsonRpcProvider,
  address: string,
  topics: (string | string[])[],
  fromBlock: number,
  toBlock: number,
): Promise<Log[]> {
  const all: Log[] = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_BLOCKS) {
    const to = Math.min(from + LOG_CHUNK_BLOCKS - 1, toBlock);
    all.push(...(await provider.getLogs({ address, topics, fromBlock: from, toBlock: to })));
  }
  return all;
}

/**
 * Look for the settlement of intent `nonce` (executed / rejected / cancelled) after `fromBlock`.
 * Returns null while the intent is still pending.
 */
export async function fetchOutcome(
  contractAddress: string,
  nonce: number,
  fromBlock: number,
): Promise<IntentOutcome | null> {
  const provider = getReadProvider();
  const address = getAddress(contractAddress);
  const vault = new Contract(address, vaultAbi(), provider);
  const topicOf = (name: string): string => vault.interface.getEvent(name)!.topicHash;
  const nonceTopic = zeroPadValue(toBeHex(nonce), 32);
  const latest = await provider.getBlockNumber();

  const settled = await logsBetween(
    provider,
    address,
    [settledEventNames().map(topicOf), nonceTopic],
    fromBlock,
    latest,
  );
  const log = settled[0];
  if (!log) return null;
  const parsed = parseVaultLog(vault, log);
  if (!parsed) return null;

  if (parsed.name === 'IntentExecuted') {
    const legs = await logsBetween(provider, address, [topicOf('RouteLeg'), nonceTopic], log.blockNumber, log.blockNumber);
    const route: RouteAllocation[] = legs
      .filter((l) => l.transactionHash === log.transactionHash)
      .map((l) => parseVaultLog(vault, l))
      .filter((p): p is NonNullable<typeof p> => p?.name === 'RouteLeg')
      .map((p) => ({
        targetPool: getAddress(String(p.args['pool'])),
        percentage: Number(p.args['pct']),
        ecoScore: toUtf8String(String(p.args['eco'])).replace(/\0+$/g, ''),
        amount: p.args['amount'] as bigint,
      }));
    return {
      status: 'Executed',
      route,
      totalAmount: executedAmount(parsed.args),
      ...(feeOf(parsed.args) !== undefined ? { fee: feeOf(parsed.args)! } : {}),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
  }

  return {
    status: statusOfEvent(parsed.name),
    route: null,
    ...(feeOf(parsed.args) !== undefined ? { fee: feeOf(parsed.args)! } : {}),
    totalAmount: (parsed.args['refunded'] as bigint) ?? 0n,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
  };
}
