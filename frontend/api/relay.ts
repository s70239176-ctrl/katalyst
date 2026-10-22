/**
 * Serverless relayer. The browser polls this endpoint after depositing; every call advances the
 * intent by at most one step and is safe to repeat or run concurrently:
 *
 *   GET /api/relay?nonce=N[&chain=key][&block=B][&gl=0x…]
 *
 * It trusts nothing from the caller: the intent (user, amount, prompt) is read from the vault's own
 * event log, the verdict comes from the GenLayer solver, and the vault re-validates the route
 * (totals, whitelist, commitment) before any funds move. `chain` selects the settlement chain from
 * the VAULTS config; `block` and `gl` are only hints that save work.
 */
import { chainByKey, explorerBlockUrl, handleError, intentRef, json, type ChainCfg } from './_lib/config.js';
import { genlayerTxUrl, parseVerdict, readResult, submitAdjudication, txState, type TxState, type Verdict } from './_lib/genlayer.js';
import { notify, notifyEnabled } from './_lib/notify.js';
import { findSettlement, loadIntent, settle, type Intent } from './_lib/vault.js';
import { executeV2, finalizeV2, findProposal, isLocked, legsHashOf, refundExpiredV2, rejectV2, routeLockOf } from './_lib/vault_v2.js';

/** Total wall-clock budget per invocation; vercel.json allows 60s, keep a safety margin. */
const BUDGET_MS = 52_000;
const SETTLE_WAIT_MS = 28_000;

function glInfo(hash: string, st: TxState) {
  const votes = Object.values(st.votes);
  return {
    txHash: hash,
    explorerUrl: genlayerTxUrl(hash),
    validatorsAgreed: votes.filter((v) => v.toUpperCase() === 'AGREE').length,
    validatorsTotal: votes.length,
    votes: st.votes,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const chain = chainByKey(url.searchParams.get('chain'));
    const nonce = Number(url.searchParams.get('nonce'));
    if (!Number.isSafeInteger(nonce) || nonce < 1) return json({ error: 'nonce must be a positive integer' }, 400);
    const blockParam = Number(url.searchParams.get('block'));
    const hint = Number.isSafeInteger(blockParam) && blockParam > 0 ? blockParam : undefined;
    const glParam = url.searchParams.get('gl');
    const glHash = glParam && /^0x[0-9a-fA-F]{64}$/.test(glParam) ? glParam : undefined;

    const startedAt = Date.now();
    const intent = await loadIntent(chain, nonce, hint);
    if (!intent) return json({ nonce, chain: chain.key, phase: 'not_found' }, 404);
    const base = { nonce, chain: chain.key, user: intent.user, amount: intent.amount.toString() };

    return chain.version === 2 ? await advanceV2(chain, intent, base, glHash, startedAt + BUDGET_MS) : await advance(chain, intent, base, glHash, startedAt + BUDGET_MS);
  } catch (err) {
    return handleError(err);
  }
}

async function advance(chain: ChainCfg, intent: Intent, base: Record<string, unknown>, glHash: string | undefined, deadline: number): Promise<Response> {
  const { nonce } = intent;
  const ref = intentRef(chain, nonce);
  const settledOut = (kind: string, tx: { txHash: string; blockNumber: number }) => ({
    phase: kind,
    portaldot: { txHash: tx.txHash, explorerUrl: explorerBlockUrl(chain, tx.blockNumber), blockNumber: tx.blockNumber },
  });

  // 1. Already settled? Report the outcome (with verdict/votes when we can).
  const done = await findSettlement(chain, nonce, intent.blockNumber);
  if (done) {
    const out: Record<string, unknown> = { ...base, ...settledOut(done.kind, done) };
    if (glHash) out['genlayer'] = glInfo(glHash, await txState(glHash));
    const raw = await readResult(ref);
    if (raw) {
      const v = parseVerdict(raw, nonce, ref);
      out['verdict'] = { approved: v.approved, ...(v.reason ? { reason: v.reason } : {}), allocations: v.allocations, trace: v.trace };
    }
    return json(out);
  }

  // 2. GenLayer adjudication: submit once, then follow the transaction until validators agree.
  const st: TxState | null = glHash ? await txState(glHash) : null;
  if (st?.kind === 'pending') return json({ ...base, phase: 'adjudicating', glTx: glHash });

  const raw = st?.kind === 'failed' ? null : await readResult(ref);
  if (!raw) {
    if (st?.kind === 'ok') return json({ ...base, phase: 'adjudicating', glTx: glHash }); // accepted; result not visible yet
    const hash = await submitAdjudication(ref, intent.prompt, intent.amount);
    return json({ ...base, phase: 'adjudicating', glTx: hash });
  }

  // 3. Verdict agreed: settle. The vault re-validates the route onchain.
  const verdict: Verdict = parseVerdict(raw, nonce, ref);
  const genlayer = glHash && st?.kind === 'ok' ? glInfo(glHash, st) : undefined;
  const verdictOut = { approved: verdict.approved, ...(verdict.reason ? { reason: verdict.reason } : {}), allocations: verdict.allocations, trace: verdict.trace };

  try {
    const res = await settle(chain, intent, verdict.approved, verdict.allocations, SETTLE_WAIT_MS, deadline);
    const included = res.blockNumber > 0;
    if (included && notifyEnabled() && Date.now() < deadline - 4_000) {
      const legs = verdict.allocations.map((a) => `${a.percentage}% → ${a.target_pool.slice(0, 6)}…${a.target_pool.slice(-4)} (${a.eco_score})`).join(', ');
      const votes = genlayer ? ` · ${genlayer.validatorsAgreed}/${genlayer.validatorsTotal} validators agreed` : '';
      await notify(
        verdict.approved
          ? `✅ Katalyst intent #${nonce} executed on ${chain.name} · ${Number(intent.amount) / 1e18} native · ${legs}${votes} · ${explorerBlockUrl(chain, res.blockNumber)}`
          : `↩️ Katalyst intent #${nonce} rejected and refunded on ${chain.name} · ${verdict.reason ?? 'no reason'}${votes} · ${explorerBlockUrl(chain, res.blockNumber)}`,
      );
    }
    return json({
      ...base,
      phase: included ? (verdict.approved ? 'executed' : 'rejected') : 'settling',
      ...(glHash ? { glTx: glHash } : {}),
      ...(genlayer ? { genlayer } : {}),
      verdict: verdictOut,
      portaldot: { txHash: res.txHash, explorerUrl: included ? explorerBlockUrl(chain, res.blockNumber) : '', blockNumber: res.blockNumber },
      ...(res.refund ? { refund: res.refund } : {}),
    });
  } catch (err) {
    const name = (err as { revert?: { name?: string } }).revert?.name;
    // A concurrent poll settled it first, or its transaction is still in flight: re-read the chain.
    if (name === 'IntentNotPending' || /nonce|replacement|already known|underpriced/i.test(err instanceof Error ? err.message : '')) {
      const after = await findSettlement(chain, nonce, intent.blockNumber);
      if (after) return json({ ...base, ...settledOut(after.kind, after), ...(genlayer ? { genlayer } : {}), verdict: verdictOut });
      return json({ ...base, phase: 'settling', ...(glHash ? { glTx: glHash } : {}), verdict: verdictOut });
    }
    throw err;
  }
}

/**
 * v2: same idea, plus the new lifecycle states. One step per call:
 *   expired -> refund; proposed (waiting out the safety delay) -> finalise when ready; else adjudicate and settle.
 */
async function advanceV2(chain: ChainCfg, intent: Intent, base: Record<string, unknown>, glHash: string | undefined, deadline: number): Promise<Response> {
  const { nonce } = intent;
  const ref = intentRef(chain, nonce);
  const out = (phase: string, tx: { txHash: string; blockNumber: number }, extra: Record<string, unknown> = {}) => ({
    ...base,
    phase,
    portaldot: { txHash: tx.txHash, explorerUrl: tx.blockNumber ? explorerBlockUrl(chain, tx.blockNumber) : '', blockNumber: tx.blockNumber },
    ...extra,
  });
  const expiry = intent.expiry ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const timing = { expiry, expiresInSec: expiry - now };
  const verdictView = (v: Verdict) => ({ approved: v.approved, ...(v.reason ? { reason: v.reason } : {}), allocations: v.allocations, trace: v.trace });
  const racy = (err: unknown): boolean => {
    const name = (err as { revert?: { name?: string } }).revert?.name;
    return name === 'IntentNotPending' || name === 'NoProposal' || name === 'AlreadyProposed' || /nonce|replacement|already known|underpriced/i.test(err instanceof Error ? err.message : '');
  };

  // 1. Already settled?
  const done = await findSettlement(chain, nonce, intent.blockNumber);
  if (done) {
    const extra: Record<string, unknown> = {};
    const rawDone = await readResult(ref);
    if (rawDone) extra['verdict'] = verdictView(parseVerdict(rawDone, nonce, ref));
    if (glHash) extra['genlayer'] = glInfo(glHash, await txState(glHash));
    return json(out(done.kind, done, extra));
  }

  // 2. Past its deadline: nobody can settle it any more; refund the depositor in full.
  if (expiry > 0 && now > expiry + 5) {
    try {
      const res = await refundExpiredV2(chain, intent, SETTLE_WAIT_MS);
      return json(out(res.blockNumber ? 'expired' : 'settling', res));
    } catch (err) {
      if (racy(err) || (err as { revert?: { name?: string } }).revert?.name === 'NotExpired') {
        const after = await findSettlement(chain, nonce, intent.blockNumber);
        if (after) return json(out(after.kind, after));
      }
      throw err;
    }
  }

  // 3. A route was proposed and is waiting out the safety delay.
  const proposal = await findProposal(chain, nonce, intent.blockNumber);
  const raw0 = await readResult(ref);
  if (proposal) {
    const verdict0 = raw0 ? parseVerdict(raw0, nonce, ref) : null;
    const prop = { readyAt: proposal.readyAt, legsHash: proposal.legsHash, secondsLeft: Math.max(0, proposal.readyAt - now) };
    if (!verdict0 || now < proposal.readyAt) {
      return json({ ...base, phase: 'proposed', proposal: prop, ...(verdict0 ? { verdict: verdictView(verdict0) } : {}), ...timing });
    }
    try {
      const res = await finalizeV2(chain, intent, verdict0.allocations, proposal, SETTLE_WAIT_MS, deadline);
      return json(out(res.blockNumber ? 'executed' : 'settling', res, { verdict: verdictView(verdict0), ...(res.refund ? { refund: res.refund } : {}) }));
    } catch (err) {
      if (racy(err)) {
        const after = await findSettlement(chain, nonce, intent.blockNumber);
        if (after) return json(out(after.kind, after, { verdict: verdictView(verdict0) }));
        return json({ ...base, phase: 'settling', verdict: verdictView(verdict0) });
      }
      throw err;
    }
  }

  // 4. GenLayer adjudication.
  const st: TxState | null = glHash ? await txState(glHash) : null;
  if (st?.kind === 'pending') return json({ ...base, phase: 'adjudicating', glTx: glHash });
  const raw = st?.kind === 'failed' ? null : raw0;
  if (!raw) {
    if (st?.kind === 'ok') return json({ ...base, phase: 'adjudicating', glTx: glHash });
    const hash = await submitAdjudication(ref, intent.prompt, intent.amount);
    return json({ ...base, phase: 'adjudicating', glTx: hash });
  }

  // 5. Verdict agreed: settle (or propose, with a settlement delay).
  const verdict: Verdict = parseVerdict(raw, nonce, ref);
  const genlayer = glHash && st?.kind === 'ok' ? glInfo(glHash, st) : undefined;
  const verdictOut = verdictView(verdict);

  // A locked route is a promise to the depositor: if the market moved and the verdict differs, do not settle.
  // They can cancel at any time, or the intent refunds in full when it expires (no fee either way).
  if (verdict.approved && isLocked(intent) && routeLockOf(verdict.allocations).toLowerCase() !== (intent.routeLock ?? '').toLowerCase()) {
    return json({ ...base, phase: 'lock_mismatch', ...(glHash ? { glTx: glHash } : {}), ...(genlayer ? { genlayer } : {}), verdict: verdictOut, ...timing });
  }

  try {
    const res = verdict.approved ? await executeV2(chain, intent, verdict.allocations, SETTLE_WAIT_MS, deadline) : await rejectV2(chain, intent, SETTLE_WAIT_MS, deadline);
    const included = res.blockNumber > 0;
    const proposed = 'proposed' in res && res.proposed === true;
    if (included && !proposed && notifyEnabled() && Date.now() < deadline - 4_000) {
      const legs = verdict.allocations.map((a) => `${a.percentage}% -> ${a.target_pool.slice(0, 6)}...${a.target_pool.slice(-4)} (${a.eco_score})`).join(', ');
      const votes = genlayer ? ` · ${genlayer.validatorsAgreed}/${genlayer.validatorsTotal} validators agreed` : '';
      await notify(
        verdict.approved
          ? `✅ Katalyst intent #${nonce} executed on ${chain.name} · ${Number(intent.amount) / 1e18} native · ${legs}${votes} · ${explorerBlockUrl(chain, res.blockNumber)}`
          : `↩️ Katalyst intent #${nonce} rejected and refunded on ${chain.name} · ${verdict.reason ?? 'no reason'}${votes} · ${explorerBlockUrl(chain, res.blockNumber)}`,
      );
    }
    const phase = !included ? 'settling' : proposed ? 'proposed' : verdict.approved ? 'executed' : 'rejected';
    return json({
      ...base,
      phase,
      ...(glHash ? { glTx: glHash } : {}),
      ...(genlayer ? { genlayer } : {}),
      verdict: verdictOut,
      ...(proposed ? { proposal: { legsHash: legsHashOf(verdict.allocations) } } : {}),
      portaldot: { txHash: res.txHash, explorerUrl: included ? explorerBlockUrl(chain, res.blockNumber) : '', blockNumber: res.blockNumber },
      ...(res.refund ? { refund: res.refund } : {}),
      ...timing,
    });
  } catch (err) {
    if (racy(err)) {
      const after = await findSettlement(chain, nonce, intent.blockNumber);
      if (after) return json(out(after.kind, after, { ...(genlayer ? { genlayer } : {}), verdict: verdictOut }));
      return json({ ...base, phase: 'settling', ...(glHash ? { glTx: glHash } : {}), verdict: verdictOut });
    }
    throw err;
  }
}
