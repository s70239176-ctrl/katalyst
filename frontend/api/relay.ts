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

    return await advance(chain, intent, base, glHash, startedAt + BUDGET_MS);
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

  // 3. Verdict agreed: settle. The vault re-validates the route on-chain.
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
