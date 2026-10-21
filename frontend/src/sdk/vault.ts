/**
 * Portaldot side of the Katalyst SDK: reads the vault's events and settlement transactions straight from the
 * EVM RPC. Environment-agnostic (browser and Node). Understands both vault generations:
 *   v1  KatalystVault.sol           (one deployment is live)
 *   v2  KatalystVaultV2.sol + PoolHub (refunds, pause, fee, route lock, hub positions, settlement delay + veto)
 */
import {
  AbiCoder,
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  solidityPacked,
  toBeHex,
  toUtf8Bytes,
  toUtf8String,
  zeroPadBytes,
  zeroPadValue,
  type Log,
} from 'ethers';

export interface VaultConfig {
  vault: string;
  rpcUrl: string;
  chainId?: number;
  /** Block the vault was deployed in; bounds log scans. */
  deployBlock?: number;
  /** Contract generation (default 1). */
  version?: 1 | 2;
  /** v2 only: the PoolHub the vault pays into. */
  hub?: string;
}

/** What a v2 vault committed to at deposit time; the relayer must present it unchanged. */
export interface IntentStruct {
  nonce: bigint;
  user: string;
  amount: bigint;
  promptHash: string;
  routeLock: string;
  expiry: bigint;
}

export interface DepositInfo {
  nonce: number;
  user: string;
  amountWei: bigint;
  prompt: string;
  promptHash: string;
  txHash: string;
  blockNumber: number;
  /** v2: 0x00… when the depositor did not lock a route. */
  routeLock?: string;
  /** v2: unix seconds after which anyone can refund the intent. */
  expiry?: number;
}

export interface LegInfo {
  pool: string;
  pct: number;
  eco: string;
  amountWei: bigint;
}

export type SettlementKind = 'executed' | 'rejected' | 'cancelled' | 'expired' | 'vetoed';

export interface SettlementInfo {
  kind: SettlementKind;
  /** The depositor the event names (execute/reject: from the relayer's call; cancel: the caller). */
  user: string;
  txHash: string;
  blockNumber: number;
  /** Event amount: routed to pools (executed; net of the fee in v2) or refunded (everything else). */
  amountWei: bigint;
  /** v2: protocol fee paid to the relayer (executed / rejected). */
  feeWei?: bigint;
  legs: LegInfo[];
}

/** v2: a settlement the relayer proposed and that waits out the delay (the owner may still veto it). */
export interface ProposalInfo {
  legsHash: string;
  readyAt: number;
  txHash: string;
  blockNumber: number;
}

export interface SettlementTx {
  from: string;
  fn: 'executeAdjudicatedIntent' | 'rejectIntent' | 'cancelIntent' | 'refundExpired' | 'finalizeSettlement' | 'vetoSettlement';
  /** Decoded arguments relevant to verification. */
  nonce: number;
  user?: string;
  amountWei: bigint;
  promptHash: string;
  routeLock?: string;
  expiry?: number;
  legs: Array<{ pool: string; pct: number; eco: string }>;
}

export interface VaultPolicy {
  owner: string;
  relayer: string;
  hub: string;
  feeWei: bigint;
  maxDepositWei: bigint;
  ttlSeconds: number;
  delaySeconds: number;
  paused: boolean;
  intentCount: number;
}

const V1_ABI = [
  'function executeAdjudicatedIntent(uint64 nonce, address user, uint256 amount, bytes32 promptHash, (address pool, uint8 pct, bytes8 eco)[] legs)',
  'function rejectIntent(uint64 nonce, address user, uint256 amount, bytes32 promptHash)',
  'function cancelIntent(uint64 nonce, uint256 amount, bytes32 promptHash)',
  'function relayer() view returns (address)',
  'function whitelisted(address pool) view returns (bool)',
  'function pending(uint64 nonce) view returns (bytes32)',
  'event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt)',
  'event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 totalAmount)',
  'event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount)',
  'event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded)',
  'event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded)',
] as const;

const INTENT = '(uint64 nonce, address user, uint256 amount, bytes32 promptHash, bytes32 routeLock, uint64 expiry)';
const LEG = '(address pool, uint8 pct, bytes8 eco)';

const V2_ABI = [
  `function executeAdjudicatedIntent(${INTENT} i, ${LEG}[] legs)`,
  `function finalizeSettlement(${INTENT} i, ${LEG}[] legs, uint64 readyAt)`,
  `function vetoSettlement(${INTENT} i)`,
  `function rejectIntent(${INTENT} i)`,
  `function cancelIntent(${INTENT} i)`,
  `function refundExpired(${INTENT} i)`,
  'function relayer() view returns (address)',
  'function owner() view returns (address)',
  'function hub() view returns (address)',
  'function feeWei() view returns (uint256)',
  'function maxDeposit() view returns (uint256)',
  'function ttl() view returns (uint64)',
  'function delay() view returns (uint64)',
  'function paused() view returns (bool)',
  'function intentCount() view returns (uint64)',
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

const HUB_ABI = [
  'function isPool(address pool) view returns (bool)',
  'function pools(address pool) view returns (bool active, bytes8 eco)',
  'function position(address pool, address user) view returns (uint256)',
  'function held(address pool) view returns (uint256)',
  'event PoolSet(address indexed pool, bool active, bytes8 eco)',
  'event PoolDeposit(address indexed pool, address indexed user, uint256 amount)',
  'event PoolWithdraw(address indexed pool, address indexed user, uint256 amount)',
] as const;

const CHUNK = 1000;
const ZERO32 = '0x' + '00'.repeat(32);

export const promptHashOf = (prompt: string): string => keccak256(toUtf8Bytes(prompt));
const nonceTopic = (n: number): string => zeroPadValue(toBeHex(n), 32);
const ecoText = (hex: string): string => toUtf8String(hex).replace(/\0+$/g, '');
const ecoHex = (label: string): string => zeroPadBytes(toUtf8Bytes(label), 8);

/** v2 route lock: chained hash h = keccak256(h ‖ pool ‖ pct) over the legs in order, h0 = 0. */
export function routeLockOf(legs: Array<{ pool: string; pct: number }>): string {
  return legs.reduce((h, l) => keccak256(solidityPacked(['bytes32', 'address', 'uint8'], [h, getAddress(l.pool), l.pct])), ZERO32);
}

/** The hash the v2 vault records for a proposal: keccak256(abi.encode(Leg[])). */
export function legsHashOf(legs: Array<{ pool: string; pct: number; eco: string }>): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode([`${LEG}[]`], [legs.map((l) => ({ pool: l.pool, pct: l.pct, eco: ecoHex(l.eco) }))]));
}

export class VaultReader {
  readonly provider: JsonRpcProvider;
  readonly contract: Contract;
  readonly version: 1 | 2;
  private readonly iface: Interface;
  private readonly hubIface = new Interface(HUB_ABI);
  private readonly cfg: Required<Pick<VaultConfig, 'vault' | 'deployBlock'>> & VaultConfig;
  private hubContract: Contract | null = null;

  constructor(cfg: VaultConfig) {
    this.cfg = { ...cfg, deployBlock: cfg.deployBlock ?? 0 };
    this.version = cfg.version ?? 1;
    const abi = this.version === 2 ? V2_ABI : V1_ABI;
    this.iface = new Interface(abi);
    const req = new FetchRequest(cfg.rpcUrl);
    req.timeout = 15_000;
    // eth-rpc on Portaldot does not support JSON-RPC batching.
    this.provider = new JsonRpcProvider(req, cfg.chainId ?? 420420777, { staticNetwork: true, batchMaxCount: 1 });
    this.contract = new Contract(getAddress(cfg.vault), abi, this.provider);
  }

  get address(): string {
    return getAddress(this.cfg.vault);
  }

  get chainId(): number {
    return this.cfg.chainId ?? 420420777;
  }

  /** The solver's key for an intent on this vault: unique across chains and vaults. */
  ref(nonce: number): string {
    return `${this.chainId}:${this.address.toLowerCase()}:${nonce}`;
  }

  private async logs(topics: (string | string[] | null)[], from: number, to: number, address = this.address): Promise<Log[]> {
    const out: Log[] = [];
    for (let start = from; start <= to; start += CHUNK) {
      out.push(...(await this.provider.getLogs({ address, topics, fromBlock: start, toBlock: Math.min(start + CHUNK - 1, to) })));
    }
    return out;
  }

  private topic(name: string): string {
    return this.iface.getEvent(name)!.topicHash;
  }

  async head(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async relayer(): Promise<string> {
    return getAddress((await this.contract.getFunction('relayer')()) as string);
  }

  /** Whether `pool` may currently receive funds (v1: the vault's whitelist; v2: the hub's registry). */
  async isWhitelisted(pool: string): Promise<boolean> {
    if (this.version === 2) return (await (await this.hub()).getFunction('isPool')(pool)) as boolean;
    return (await this.contract.getFunction('whitelisted')(pool)) as boolean;
  }

  async isPending(nonce: number): Promise<boolean> {
    return BigInt((await this.contract.getFunction('pending')(nonce)) as string) !== 0n;
  }

  // ---- v2 only ------------------------------------------------------------------------------

  /** The PoolHub contract (v2). */
  async hub(): Promise<Contract> {
    if (this.version !== 2) throw new Error('Only v2 vaults have a PoolHub');
    if (!this.hubContract) {
      const addr = this.cfg.hub ?? ((await this.contract.getFunction('hub')()) as string);
      this.hubContract = new Contract(getAddress(addr), HUB_ABI, this.provider);
    }
    return this.hubContract;
  }

  /** Immutable policy and live admin state of a v2 vault. */
  async policy(): Promise<VaultPolicy> {
    if (this.version !== 2) throw new Error('Only v2 vaults have a policy');
    const c = this.contract;
    const [owner, relayer, hub, fee, cap, ttl, delay, paused, count] = await Promise.all(
      ['owner', 'relayer', 'hub', 'feeWei', 'maxDeposit', 'ttl', 'delay', 'paused', 'intentCount'].map((f) => c.getFunction(f)()),
    );
    return {
      owner: getAddress(owner as string),
      relayer: getAddress(relayer as string),
      hub: getAddress(hub as string),
      feeWei: fee as bigint,
      maxDepositWei: cap as bigint,
      ttlSeconds: Number(ttl),
      delaySeconds: Number(delay),
      paused: paused as boolean,
      intentCount: Number(count),
    };
  }

  /** Pools registered in the hub, with their eco label and whether they are currently active. */
  async hubPools(): Promise<Array<{ pool: string; active: boolean; eco: string }>> {
    const hub = await this.hub();
    const hubAddress = getAddress(await hub.getAddress());
    const head = await this.head();
    const topic = this.hubIface.getEvent('PoolSet')!.topicHash;
    const seen = new Set<string>();
    for (const log of await this.logs([topic], this.cfg.deployBlock, head, hubAddress)) {
      const p = this.hubIface.parseLog(log);
      if (p) seen.add(getAddress(String(p.args['pool'])));
    }
    return Promise.all(
      [...seen].map(async (pool) => {
        const [active, eco] = (await hub.getFunction('pools')(pool)) as [boolean, string];
        return { pool, active, eco: ecoText(eco) };
      }),
    );
  }

  /** The user's funds sitting in each hub pool. */
  async positions(user: string): Promise<Array<{ pool: string; eco: string; amountWei: bigint }>> {
    const hub = await this.hub();
    const pools = await this.hubPools();
    const rows = await Promise.all(pools.map(async (p) => ({ pool: p.pool, eco: p.eco, amountWei: (await hub.getFunction('position')(p.pool, user)) as bigint })));
    return rows.filter((r) => r.amountWei > 0n);
  }

  /** A relayer proposal for `nonce` (settlement delay), if one was made. */
  async proposal(nonce: number, fromBlock: number): Promise<ProposalInfo | null> {
    if (this.version !== 2) return null;
    const head = await this.head();
    const logs = await this.logs([this.topic('SettlementProposed'), nonceTopic(nonce)], fromBlock, head);
    const log = logs[logs.length - 1];
    if (!log) return null;
    const p = this.iface.parseLog(log);
    if (!p) return null;
    return { legsHash: String(p.args['legsHash']), readyAt: Number(p.args['readyAt']), txHash: log.transactionHash, blockNumber: log.blockNumber };
  }

  // ---- both versions ------------------------------------------------------------------------

  /** The deposit event for `nonce`. A `hintBlock` avoids scanning from deployment. */
  async deposit(nonce: number, hintBlock?: number): Promise<DepositInfo | null> {
    const head = await this.head();
    const find = async (from: number, to: number): Promise<DepositInfo | null> => {
      for (const log of await this.logs([this.topic('IntentDeposited'), nonceTopic(nonce)], from, to)) {
        const p = this.iface.parseLog(log);
        if (p?.name !== 'IntentDeposited') continue;
        const prompt = String(p.args['prompt']);
        return {
          nonce,
          user: getAddress(String(p.args['user'])),
          amountWei: p.args['amount'] as bigint,
          prompt,
          promptHash: promptHashOf(prompt),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          ...(this.version === 2 ? { routeLock: String(p.args['routeLock']), expiry: Number(p.args['expiry']) } : {}),
        };
      }
      return null;
    };
    if (hintBlock) {
      const hit = await find(Math.max(0, hintBlock - 1), Math.min(head, hintBlock + 1));
      if (hit) return hit;
    }
    return find(this.cfg.deployBlock, head);
  }

  /** How `nonce` was settled (executed with its route legs, rejected, cancelled, expired or vetoed), or null while pending. */
  async settlement(nonce: number, fromBlock: number): Promise<SettlementInfo | null> {
    const head = await this.head();
    const kinds: Array<[SettlementKind, string]> = [
      ['executed', this.topic('IntentExecuted')],
      ['rejected', this.topic('IntentRejected')],
      ['cancelled', this.topic('IntentCancelled')],
    ];
    if (this.version === 2) {
      kinds.push(['expired', this.topic('IntentExpired')], ['vetoed', this.topic('SettlementVetoed')]);
    }
    const found = await this.logs([kinds.map(([, t]) => t), nonceTopic(nonce)], fromBlock, head);
    const log = found[0];
    if (!log) return null;
    const kind = kinds.find(([, t]) => t === log.topics[0])?.[0];
    const parsed = this.iface.parseLog(log);
    if (!kind || !parsed) return null;

    let legs: LegInfo[] = [];
    let amountWei: bigint;
    let feeWei: bigint | undefined;
    if (kind === 'executed') {
      amountWei = this.version === 2 ? (parsed.args['netAmount'] as bigint) : (parsed.args['totalAmount'] as bigint);
      if (this.version === 2) feeWei = parsed.args['fee'] as bigint;
      const legLogs = await this.logs([this.topic('RouteLeg'), nonceTopic(nonce)], log.blockNumber, log.blockNumber);
      legs = legLogs
        .filter((l) => l.transactionHash === log.transactionHash)
        .map((l) => this.iface.parseLog(l))
        .filter((p): p is NonNullable<typeof p> => p?.name === 'RouteLeg')
        .map((p) => ({ pool: getAddress(String(p.args['pool'])), pct: Number(p.args['pct']), eco: ecoText(String(p.args['eco'])), amountWei: p.args['amount'] as bigint }));
    } else {
      amountWei = parsed.args['refunded'] as bigint;
      if (this.version === 2 && kind === 'rejected') feeWei = parsed.args['fee'] as bigint;
    }
    return {
      kind,
      user: getAddress(String(parsed.args['user'])),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      amountWei,
      ...(feeWei !== undefined ? { feeWei } : {}),
      legs,
    };
  }

  /** Decode the settlement transaction's sender and arguments (what was actually submitted). Best-effort. */
  async settlementTx(txHash: string): Promise<SettlementTx | null> {
    // The public RPC prunes old transactions (it keeps event logs), so this is best-effort.
    let tx: Awaited<ReturnType<JsonRpcProvider['getTransaction']>> = null;
    try {
      tx = await this.provider.getTransaction(txHash);
    } catch {
      tx = null;
    }
    if (!tx) return null;
    const parsed = this.iface.parseTransaction({ data: tx.data });
    if (!parsed) return null;
    const a = parsed.args;
    const from = getAddress(tx.from);
    const fn = parsed.name as SettlementTx['fn'];

    if (this.version === 2) {
      const i = a['i'] as { nonce: bigint; user: string; amount: bigint; promptHash: string; routeLock: string; expiry: bigint } | undefined;
      if (!i) return null;
      const legs = a['legs'] as Array<{ pool: string; pct: bigint; eco: string }> | undefined;
      return {
        from,
        fn,
        nonce: Number(i.nonce),
        user: getAddress(i.user),
        amountWei: i.amount,
        promptHash: i.promptHash,
        routeLock: i.routeLock,
        expiry: Number(i.expiry),
        legs: (legs ?? []).map((l) => ({ pool: getAddress(l.pool), pct: Number(l.pct), eco: ecoText(l.eco) })),
      };
    }

    if (parsed.name === 'executeAdjudicatedIntent') {
      return {
        from,
        fn: 'executeAdjudicatedIntent',
        nonce: Number(a['nonce']),
        user: getAddress(String(a['user'])),
        amountWei: a['amount'] as bigint,
        promptHash: String(a['promptHash']),
        legs: (a['legs'] as Array<{ pool: string; pct: bigint; eco: string }>).map((l) => ({ pool: getAddress(l.pool), pct: Number(l.pct), eco: ecoText(l.eco) })),
      };
    }
    if (parsed.name === 'rejectIntent') {
      return { from, fn: 'rejectIntent', nonce: Number(a['nonce']), user: getAddress(String(a['user'])), amountWei: a['amount'] as bigint, promptHash: String(a['promptHash']), legs: [] };
    }
    if (parsed.name === 'cancelIntent') {
      return { from, fn: 'cancelIntent', nonce: Number(a['nonce']), amountWei: a['amount'] as bigint, promptHash: String(a['promptHash']), legs: [] };
    }
    return null;
  }
}
