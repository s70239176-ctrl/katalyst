import { parseVerdict, type VerdictPayload } from '../utils/types';
import { GenLayerReader, isSuccessStatus, type Adjudication } from './genlayer';
import { VaultReader, type DepositInfo, type SettlementInfo, type SettlementTx } from './vault';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type ProofVerdict = 'verified' | 'failed' | 'pending' | 'not_found';

/** Self-contained evidence for one intent, re-checkable by anyone against the two chains. */
export interface ProofBundle {
  schema: 'katalyst.proof/v1';
  generatedAt: string;
  network: { chainId: number; vault: string; genlayerContract: string | null; genlayerChain: string | null };
  nonce: number;
  verdict: ProofVerdict;
  deposit: (Omit<DepositInfo, 'amountWei'> & { amountWei: string }) | null;
  settlement: {
    kind: SettlementInfo['kind'];
    txHash: string;
    blockNumber: number;
    amountWei: string;
    legs: Array<{ pool: string; pct: number; eco: string; amountWei: string }>;
  } | null;
  settlementTx: { from: string; fn: SettlementTx['fn'] } | null;
  genlayer: {
    txHash: string | null;
    status: string | null;
    votes: Record<string, string>;
    agreed: number;
    total: number;
    verdict: VerdictPayload | null;
  } | null;
  checks: Check[];
}

export interface VerifyOptions {
  /** Deposit block, if known: avoids scanning from deployment. */
  hintBlock?: number;
  /** Also re-run the adjudication now and compare (informational: live data can legitimately change). */
  rerun?: boolean;
  /**
   * This vault's earliest intents were adjudicated by nonce-only solver deployments: also match those
   * (the primary Portaldot vault sets this; vaults added later use refs only).
   */
  legacyNonceRefs?: boolean;
}

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fmt = (wei: bigint): string => {
  const base = 10n ** 18n;
  const frac = (wei % base).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${wei / base}${frac ? '.' + frac : ''} tPOT`;
};

/** What the vault must have paid each leg: floor(amount * pct / 100), the last leg takes the remainder. */
export function expectedShares(amount: bigint, pcts: number[]): bigint[] {
  const out: bigint[] = [];
  let remaining = amount;
  pcts.forEach((pct, i) => {
    const share = i === pcts.length - 1 ? remaining : (amount * BigInt(pct)) / 100n;
    out.push(share);
    remaining -= share;
  });
  return out;
}

export async function verifyIntent(
  vault: VaultReader,
  gl: GenLayerReader | null,
  glChain: string | null,
  nonce: number,
  opts: VerifyOptions = {},
): Promise<ProofBundle> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  const bundle: ProofBundle = {
    schema: 'katalyst.proof/v1',
    generatedAt: new Date().toISOString(),
    network: { chainId: Number((await vault.provider.getNetwork()).chainId), vault: vault.address, genlayerContract: gl?.contract ?? null, genlayerChain: glChain },
    nonce,
    verdict: 'not_found',
    deposit: null,
    settlement: null,
    settlementTx: null,
    genlayer: null,
    checks,
  };

  // 1. Deposit
  const deposit = await vault.deposit(nonce, opts.hintBlock);
  if (!deposit) {
    add('deposit', 'Deposit recorded on Portaldot', 'fail', `No IntentDeposited event for intent #${nonce}.`);
    return bundle;
  }
  bundle.deposit = { ...deposit, amountWei: deposit.amountWei.toString() };
  add('deposit', 'Deposit recorded on Portaldot', 'pass', `${fmt(deposit.amountWei)} from ${deposit.user} in block ${deposit.blockNumber}.`);

  // 2. Settlement
  const settlement = await vault.settlement(nonce, deposit.blockNumber);
  if (!settlement) {
    add('settled', 'Settled on Portaldot', 'warn', 'The intent is still pending; nothing has been settled yet.');
    bundle.verdict = 'pending';
    return bundle;
  }
  bundle.settlement = {
    kind: settlement.kind,
    txHash: settlement.txHash,
    blockNumber: settlement.blockNumber,
    amountWei: settlement.amountWei.toString(),
    legs: settlement.legs.map((l) => ({ pool: l.pool, pct: l.pct, eco: l.eco, amountWei: l.amountWei.toString() })),
  };
  add('settled', 'Settled on Portaldot', 'pass', `${settlement.kind} in block ${settlement.blockNumber}.`);

  // 3. Who submitted it, and was it bound to the deposit?
  // Prefer the transaction itself; the public RPC prunes old transactions but keeps event logs, so fall back
  // to the vault's events (the contract emits them only for a valid, commitment-matching settlement).
  const tx = await vault.settlementTx(settlement.txHash);
  if (tx) bundle.settlementTx = { from: tx.from, fn: tx.fn };

  if (settlement.kind === 'cancelled') {
    const who = tx ? tx.from : settlement.user;
    const ok = eqAddr(who, deposit.user);
    add('authorized', 'Submitted by the authorised party', ok ? 'pass' : 'fail', ok ? `Cancelled by the depositor${tx ? '' : ' (from the vault event; the transaction is no longer served by the RPC)'}.` : `Cancel was made by ${who}, not the depositor.`);
  } else if (tx) {
    const relayer = await vault.relayer();
    add('authorized', 'Submitted by the authorised party', eqAddr(tx.from, relayer) ? 'pass' : 'fail', eqAddr(tx.from, relayer) ? `Sent by the vault's relayer ${relayer}.` : `Sent by ${tx.from}, but the vault's relayer is ${relayer}.`);
  } else {
    add('authorized', 'Submitted by the authorised party', 'pass', "Inferred from the vault event: the contract only lets its relayer settle intents, and the RPC no longer serves this old transaction.");
  }

  if (tx) {
    const sameUser = tx.user === undefined || eqAddr(tx.user, deposit.user);
    const bound = sameUser && tx.nonce === nonce && tx.amountWei === deposit.amountWei && tx.promptHash.toLowerCase() === deposit.promptHash.toLowerCase();
    add('commitment', 'Settlement bound to the original deposit', bound ? 'pass' : 'fail', bound ? 'User, amount and prompt hash in the settlement match the deposit. The vault only accepts a settlement that reproduces the deposit-time commitment.' : 'The settlement arguments do not match the deposit.');
  } else {
    const bound = eqAddr(settlement.user, deposit.user) && (settlement.kind === 'executed' ? settlement.amountWei : settlement.amountWei) === deposit.amountWei;
    add('commitment', 'Settlement bound to the original deposit', bound ? 'pass' : 'fail', bound ? 'The settlement event names the same depositor and the full deposited amount; the vault emits it only after matching the deposit-time commitment.' : 'The settlement event does not match the deposit.');
  }

  // 4. GenLayer: did validators judge exactly this prompt, and did they agree?
  let adj: Adjudication | null = null;
  let verdict: VerdictPayload | null = null;
  let rawResult: string | null = null;
  if (gl && settlement.kind !== 'cancelled') {
    // Independent reads: run them together.
    const [resultRes, adjRes] = await Promise.allSettled([gl.result(vault.ref(nonce), opts.legacyNonceRefs ? nonce : undefined), gl.findAdjudication(vault.ref(nonce), opts.legacyNonceRefs ? nonce : undefined)]);
    if (resultRes.status === 'fulfilled' && resultRes.value) {
      rawResult = resultRes.value;
      try {
        verdict = parseVerdict(rawResult);
      } catch {
        verdict = null; /* reported below */
      }
    }
    adj = adjRes.status === 'fulfilled' ? adjRes.value : null;
    bundle.genlayer = {
      txHash: adj?.hash ?? null,
      status: adj?.status ?? null,
      votes: adj?.votes ?? {},
      agreed: adj?.agreed ?? 0,
      total: adj?.total ?? 0,
      verdict,
    };

    if (!adj) {
      add('consensus', 'GenLayer validators agreed', 'warn', 'Could not locate the GenLayer transaction (the network may not expose a transaction listing).');
      add('same_prompt', 'GenLayer judged the deposited prompt', 'skip', 'Needs the GenLayer transaction.');
    } else {
      const ok = isSuccessStatus(adj.status);
      const majority = adj.total > 0 && adj.agreed * 2 > adj.total;
      add('consensus', 'GenLayer validators agreed', ok && majority ? 'pass' : ok ? 'warn' : 'fail', `${adj.agreed}/${adj.total} validators voted agree; transaction status ${adj.status}.`);
      const same = adj.prompt === deposit.prompt && BigInt(adj.amountWei) === deposit.amountWei;
      add('same_prompt', 'GenLayer judged the deposited prompt', same ? 'pass' : 'fail', same ? 'The prompt and amount sent to GenLayer are identical to the on-chain deposit.' : 'The prompt or amount sent to GenLayer differs from the deposit.');
    }
  } else {
    add('consensus', 'GenLayer validators agreed', 'skip', gl ? 'Not applicable: the depositor cancelled.' : 'GenLayer is not configured for this verification.');
  }

  // 5. Verdict ↔ settlement
  if (settlement.kind === 'executed') {
    if (!verdict) {
      add('verdict', 'Verdict matches what was paid', 'warn', 'The GenLayer verdict could not be read.');
    } else {
      const onChain = new Map(settlement.legs.map((l) => [l.pool.toLowerCase(), l]));
      const sameSet = verdict.status === 'APPROVED' && verdict.allocations.length === settlement.legs.length && verdict.allocations.every((a) => {
        const leg = onChain.get(a.target_pool.toLowerCase());
        return leg !== undefined && leg.pct === a.percentage && leg.eco === a.eco_score;
      });
      const txLegs = tx?.legs ?? [];
      const txMatches = tx === null || (txLegs.length === settlement.legs.length && txLegs.every((l) => onChain.get(l.pool.toLowerCase())?.pct === l.pct));
      add('verdict', 'Verdict matches what was paid', sameSet && txMatches ? 'pass' : 'fail', sameSet && txMatches ? `GenLayer approved ${verdict.allocations.map((a) => `${a.percentage}%`).join(' / ')} and exactly that was paid.` : 'The paid route differs from the GenLayer verdict.');
    }

    // 6. Arithmetic
    const total = settlement.legs.reduce((s, l) => s + l.pct, 0);
    const paid = settlement.legs.reduce((s, l) => s + l.amountWei, 0n);
    const expected = expectedShares(deposit.amountWei, settlement.legs.map((l) => l.pct));
    const exact = settlement.legs.every((l, i) => l.amountWei === expected[i]);
    const mathOk = total === 100 && paid === deposit.amountWei && settlement.amountWei === deposit.amountWei && exact;
    add('math', 'Split is exact and nothing is left behind', mathOk ? 'pass' : 'fail', mathOk ? `Percentages total 100, ${fmt(paid)} paid out of ${fmt(deposit.amountWei)} deposited.` : `Percentages ${total}, paid ${fmt(paid)} of ${fmt(deposit.amountWei)}.`);

    // 7. Whitelist (current state)
    const flags = await Promise.all(settlement.legs.map((l) => vault.isWhitelisted(l.pool)));
    add('whitelist', 'Paid pools are whitelisted', flags.every(Boolean) ? 'pass' : 'warn', flags.every(Boolean) ? 'Every paid pool is on the vault whitelist.' : 'A paid pool is no longer on the whitelist (it may have been removed since).');
  } else {
    // rejected / cancelled: the deposit must have been returned in full
    const refunded = settlement.amountWei === deposit.amountWei;
    add('refund', 'Deposit returned in full', refunded ? 'pass' : 'fail', refunded ? `${fmt(settlement.amountWei)} refunded to the depositor.` : `Refunded ${fmt(settlement.amountWei)} of ${fmt(deposit.amountWei)}.`);
    if (settlement.kind === 'rejected') {
      const rejected = verdict?.status === 'REJECTED';
      add('verdict', 'Rejection backed by a GenLayer verdict', verdict ? (rejected ? 'pass' : 'fail') : 'warn', verdict ? (rejected ? `GenLayer rejected it: ${verdict.reason ?? 'no reason given'}.` : 'GenLayer approved this intent but the relayer rejected it.') : 'The GenLayer verdict could not be read.');
    }
  }

  // 8. Optional: reproduce the verdict now
  if (opts.rerun && gl && settlement.kind !== 'cancelled' && verdict) {
    try {
      const again = await gl.preview(deposit.prompt);
      const key = (v: VerdictPayload) => v.status + '|' + v.allocations.map((a) => `${a.target_pool.toLowerCase()}:${a.percentage}`).sort().join(',');
      const same = key(again) === key(verdict);
      add('reproducible', 'A fresh run reaches the same verdict', same ? 'pass' : 'warn', same ? 'Re-running the adjudication now gives the identical route.' : 'A fresh run differs. Pool APY or eco data may have changed since; this is informational.');
    } catch (err) {
      add('reproducible', 'A fresh run reaches the same verdict', 'warn', `Could not re-run: ${err instanceof Error ? err.message : 'error'}.`);
    }
  }

  bundle.verdict = checks.some((c) => c.status === 'fail') ? 'failed' : 'verified';
  return bundle;
}
