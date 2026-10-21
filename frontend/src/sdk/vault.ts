/**
 * Portaldot side of the Katalyst SDK: reads the vault's events and settlement transactions straight from the
 * EVM RPC. Environment-agnostic (browser and Node).
 */
import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  toUtf8String,
  zeroPadValue,
  type Log,
} from 'ethers';

export interface VaultConfig {
  vault: string;
  rpcUrl: string;
  chainId?: number;
  /** Block the vault was deployed in; bounds log scans. */
  deployBlock?: number;
}

export interface DepositInfo {
  nonce: number;
  user: string;
  amountWei: bigint;
  prompt: string;
  promptHash: string;
  txHash: string;
  blockNumber: number;
}

export interface LegInfo {
  pool: string;
  pct: number;
  eco: string;
  amountWei: bigint;
}

export type SettlementKind = 'executed' | 'rejected' | 'cancelled';

export interface SettlementInfo {
  kind: SettlementKind;
  /** The depositor the event names (execute/reject: from the relayer's call; cancel: the caller). */
  user: string;
  txHash: string;
  blockNumber: number;
  /** Event amount: total routed (executed) or refunded (rejected / cancelled). */
  amountWei: bigint;
  legs: LegInfo[];
}

export interface SettlementTx {
  from: string;
  fn: 'executeAdjudicatedIntent' | 'rejectIntent' | 'cancelIntent';
  /** Decoded arguments relevant to verification. */
  nonce: number;
  user?: string;
  amountWei: bigint;
  promptHash: string;
  legs: Array<{ pool: string; pct: number; eco: string }>;
}

const ABI = [
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

const CHUNK = 1000;

export const promptHashOf = (prompt: string): string => keccak256(toUtf8Bytes(prompt));
const nonceTopic = (n: number): string => zeroPadValue(toBeHex(n), 32);
const ecoText = (hex: string): string => toUtf8String(hex).replace(/\0+$/g, '');

export class VaultReader {
  readonly provider: JsonRpcProvider;
  readonly contract: Contract;
  private readonly iface = new Interface(ABI);
  private readonly cfg: Required<Pick<VaultConfig, 'vault' | 'deployBlock'>> & VaultConfig;

  constructor(cfg: VaultConfig) {
    this.cfg = { ...cfg, deployBlock: cfg.deployBlock ?? 0 };
    const req = new FetchRequest(cfg.rpcUrl);
    req.timeout = 15_000;
    // eth-rpc on Portaldot does not support JSON-RPC batching.
    this.provider = new JsonRpcProvider(req, cfg.chainId ?? 420420777, { staticNetwork: true, batchMaxCount: 1 });
    this.contract = new Contract(getAddress(cfg.vault), ABI, this.provider);
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

  private async logs(topics: (string | string[] | null)[], from: number, to: number): Promise<Log[]> {
    const out: Log[] = [];
    for (let start = from; start <= to; start += CHUNK) {
      out.push(...(await this.provider.getLogs({ address: this.address, topics, fromBlock: start, toBlock: Math.min(start + CHUNK - 1, to) })));
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

  async isWhitelisted(pool: string): Promise<boolean> {
    return (await this.contract.getFunction('whitelisted')(pool)) as boolean;
  }

  async isPending(nonce: number): Promise<boolean> {
    return BigInt((await this.contract.getFunction('pending')(nonce)) as string) !== 0n;
  }

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

  /** How `nonce` was settled (executed with its route legs, rejected or cancelled), or null while pending. */
  async settlement(nonce: number, fromBlock: number): Promise<SettlementInfo | null> {
    const head = await this.head();
    const kinds: Array<[SettlementKind, string]> = [
      ['executed', this.topic('IntentExecuted')],
      ['rejected', this.topic('IntentRejected')],
      ['cancelled', this.topic('IntentCancelled')],
    ];
    const found = await this.logs([kinds.map(([, t]) => t), nonceTopic(nonce)], fromBlock, head);
    const log = found[0];
    if (!log) return null;
    const kind = kinds.find(([, t]) => t === log.topics[0])?.[0];
    const parsed = this.iface.parseLog(log);
    if (!kind || !parsed) return null;

    let legs: LegInfo[] = [];
    let amountWei: bigint;
    if (kind === 'executed') {
      amountWei = parsed.args['totalAmount'] as bigint;
      const legLogs = await this.logs([this.topic('RouteLeg'), nonceTopic(nonce)], log.blockNumber, log.blockNumber);
      legs = legLogs
        .filter((l) => l.transactionHash === log.transactionHash)
        .map((l) => this.iface.parseLog(l))
        .filter((p): p is NonNullable<typeof p> => p?.name === 'RouteLeg')
        .map((p) => ({ pool: getAddress(String(p.args['pool'])), pct: Number(p.args['pct']), eco: ecoText(String(p.args['eco'])), amountWei: p.args['amount'] as bigint }));
    } else {
      amountWei = parsed.args['refunded'] as bigint;
    }
    return { kind, user: getAddress(String(parsed.args['user'])), txHash: log.transactionHash, blockNumber: log.blockNumber, amountWei, legs };
  }

  /** Decode the settlement transaction's sender and arguments (what the relayer actually submitted). */
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
    if (parsed.name === 'executeAdjudicatedIntent') {
      return {
        from: getAddress(tx.from),
        fn: 'executeAdjudicatedIntent',
        nonce: Number(a['nonce']),
        user: getAddress(String(a['user'])),
        amountWei: a['amount'] as bigint,
        promptHash: String(a['promptHash']),
        legs: (a['legs'] as Array<{ pool: string; pct: bigint; eco: string }>).map((l) => ({ pool: getAddress(l.pool), pct: Number(l.pct), eco: ecoText(l.eco) })),
      };
    }
    if (parsed.name === 'rejectIntent') {
      return { from: getAddress(tx.from), fn: 'rejectIntent', nonce: Number(a['nonce']), user: getAddress(String(a['user'])), amountWei: a['amount'] as bigint, promptHash: String(a['promptHash']), legs: [] };
    }
    if (parsed.name === 'cancelIntent') {
      return { from: getAddress(tx.from), fn: 'cancelIntent', nonce: Number(a['nonce']), amountWei: a['amount'] as bigint, promptHash: String(a['promptHash']), legs: [] };
    }
    return null;
  }
}
