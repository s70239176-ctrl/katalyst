/**
 * Serverless relayer. The browser polls this endpoint after depositing; every call advances the
 * intent by at most one step and is safe to repeat or run concurrently:
 *
 *   GET /api/relay?nonce=N[&block=B][&gl=0x…]
 *
 * It trusts nothing from the caller: the intent (user, amount, prompt) is read from the vault's own
 * event log, the verdict comes from the GenLayer solver, and the vault re-validates the route
 * (totals, whitelist, commitment) before any funds move. `block` and `gl` are only hints that save work.
 */
import { explorerBlockUrl, handleError, json } from './_lib/config.js';
import { genlayerTxUrl, parseVerdict, readResult, submitAdjudication, txState, type TxState, type Verdict } from './_lib/genlayer.js';
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
    const nonce = Number(url.searchParams.get('nonce'));
    if (!Number.isSafeInteger(nonce) || nonce < 1) return json({ error: 'nonce must be a positive integer' }, 400);
    const blockParam = Number(url.searchParams.get('block'));
    const hint = Number.isSafeInteger(blockParam) && blockParam > 0 ? blockParam : undefined;
    const glParam = url.searchParams.get('gl');
    const glHash = glParam && /^0x[0-9a-fA-F]{64}$/.test(glParam) ? glParam : undefined;

    const startedAt = Date.now();
    const intent = await loadIntent(nonce, hint);
    if (!intent) return json({ nonce, phase: 'not_found' }, 404);
    const base = { nonce, user: intent.user, amount: intent.amount.toString() };

    return await advance(intent, base, glHash, startedAt + BUDGET_MS);
  } catch (err) {
    return handleError(err);
  }
}

async function advance(intent: Intent, base: Record<string, unknown>, glHash: string | undefined, deadline: number): Promise<Response> {
  const { nonce } = intent;

  // 1. Already settled on Portaldot? Report the outcome (with verdict/votes when we can).
  const done = await findSettlement(nonce, intent.blockNumber);
  if (done) {
    const out: Record<string, unknown> = {
      ...base,
      phase: done.kind,
      portaldot: { txHash: done.txHash, explorerUrl: explorerBlockUrl(done.blockNumber), blockNumber: done.blockNumber },
    };
    if (glHash) out['genlayer'] = glInfo(glHash, await txState(glHash));
    const raw = await readResult(nonce);
    if (raw) {
      const v = parseVerdict(raw, nonce);
      out['verdict'] = { approved: v.approved, ...(v.reason ? { reason: v.reason } : {}), allocations: v.allocations, trace: v.trace };
    }
    return json(out);
  }

  // 2. GenLayer adjudication: submit once, then follow the transaction until validators agree.
  let st: TxState | null = glHash ? await txState(glHash) : null;
  if (st?.kind === 'pending') return json({ ...base, phase: 'adjudicating', glTx: glHash });

  const raw = st?.kind === 'failed' ? null : await readResult(nonce);
  if (!raw) {
    if (st?.kind === 'ok') return json({ ...base, phase: 'adjudicating', glTx: glHash }); // accepted; result not visible yet
    const hash = await submitAdjudication(nonce, intent.prompt, intent.amount);
    return json({ ...base, phase: 'adjudicating', glTx: hash });
  }

  // 3. Verdict agreed: settle on Portaldot. The vault re-validates the route on-chain.
  const verdict: Verdict = parseVerdict(raw, nonce);
  const genlayer = glHash && st?.kind === 'ok' ? glInfo(glHash, st) : undefined;
  const verdictOut = { approved: verdict.approved, ...(verdict.reason ? { reason: verdict.reason } : {}), allocations: verdict.allocations, trace: verdict.trace };

  try {
    const res = await settle(intent, verdict.approved, verdict.allocations, SETTLE_WAIT_MS, deadline);
    const included = res.blockNumber > 0;
    return json({
      ...base,
      phase: included ? (verdict.approved ? 'executed' : 'rejected') : 'settling',
      ...(glHash ? { glTx: glHash } : {}),
      ...(genlayer ? { genlayer } : {}),
      verdict: verdictOut,
      portaldot: { txHash: res.txHash, explorerUrl: included ? explorerBlockUrl(res.blockNumber) : '', blockNumber: res.blockNumber },
      ...(res.refund ? { refund: res.refund } : {}),
    });
  } catch (err) {
    const name = (err as { revert?: { name?: string } }).revert?.name;
    // A concurrent poll settled it first, or its transaction is still in flight: re-read the chain.
    if (name === 'IntentNotPending' || /nonce|replacement|already known|underpriced/i.test(err instanceof Error ? err.message : '')) {
      const after = await findSettlement(nonce, intent.blockNumber);
      if (after) {
        return json({
          ...base,
          phase: after.kind,
          ...(genlayer ? { genlayer } : {}),
          verdict: verdictOut,
          portaldot: { txHash: after.txHash, explorerUrl: explorerBlockUrl(after.blockNumber), blockNumber: after.blockNumber },
        });
      }
      return json({ ...base, phase: 'settling', ...(glHash ? { glTx: glHash } : {}), verdict: verdictOut });
    }
    throw err;
  }
}
