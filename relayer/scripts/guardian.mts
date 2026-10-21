// Guardian for the v2 settlement delay. Watches the vault for settlements the relayer has PROPOSED, re-derives the
// route GenLayer's validators agreed on, and vetoes any proposal that does not match (the depositor is refunded
// in full). This is the same check the Verify page performs, run during the delay window instead of after it.
//
//   node --env-file=.env --import tsx scripts/guardian.mts            # report only
//   node --env-file=.env --import tsx scripts/guardian.mts --veto     # veto mismatches (needs the owner key)
//   node --env-file=.env --import tsx scripts/guardian.mts --loop 20  # repeat every 20s
//
// The owner key is DEPLOYER_PRIVATE_KEY by default; override with GUARDIAN_PRIVATE_KEY.
import { Wallet } from 'ethers';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
};
const veto = process.argv.includes('--veto');
const loopSec = Number(arg('--loop') ?? 0);

process.env['VAULTS'] = JSON.stringify([
  {
    key: 'portaldot-v2',
    name: 'Portaldot V3 Testnet (v2)',
    chainId: Number(process.env['PORTALDOT_CHAIN_ID'] ?? 420420777),
    rpcUrl: process.env['PORTALDOT_EVM_RPC'],
    vault: process.env['VAULT_V2_ADDRESS'],
    version: 2,
    deployBlock: Number(process.env['VAULT_V2_DEPLOY_BLOCK']),
    explorerBlockUrl: 'https://node-console.portaldot.dev/#/explorer/query/{block}',
  },
]);

const { chainByKey, intentRef, getProvider } = await import('../../frontend/api/_lib/config.ts');
const { loadIntent, logs, promptHashOf, vault } = await import('../../frontend/api/_lib/vault.ts');
const { findProposal, legsHashOf } = await import('../../frontend/api/_lib/vault_v2.ts');
const { parseVerdict, readResult } = await import('../../frontend/api/_lib/genlayer.ts');

const chain = chainByKey('portaldot-v2');
const provider = getProvider(chain);

async function openProposals(): Promise<number[]> {
  const v = vault(chain);
  const head = await provider.getBlockNumber();
  const from = Math.max(chain.deployBlock, head - 3000);
  const found = await logs(chain, [v.interface.getEvent('SettlementProposed')!.topicHash], from, head);
  const nonces = [...new Set(found.map((l) => Number(BigInt(l.topics[1]!))))];
  const open: number[] = [];
  for (const n of nonces) if (BigInt((await v.getFunction('proposed')(n)) as string) !== 0n) open.push(n);
  return open;
}

async function checkOnce(): Promise<void> {
  const open = await openProposals();
  if (open.length === 0) {
    console.log(`[guardian] ${new Date().toISOString()} no open proposals`);
    return;
  }
  for (const nonce of open) {
    const intent = await loadIntent(chain, nonce);
    const proposal = intent ? await findProposal(chain, nonce, intent.blockNumber) : null;
    if (!intent || !proposal) continue;
    const raw = await readResult(intentRef(chain, nonce));
    let verdict: ReturnType<typeof parseVerdict> | null = null;
    try {
      verdict = raw ? parseVerdict(raw, nonce, intentRef(chain, nonce)) : null;
    } catch {
      verdict = null;
    }
    const left = proposal.readyAt - Math.floor(Date.now() / 1000);

    // Cases that justify a veto: no agreed verdict, a rejection that was somehow proposed as a route, or a route
    // different from the one the validators agreed on.
    let ok = false;
    let why = '';
    if (!verdict) why = 'GenLayer has no agreed verdict for this intent';
    else if (!verdict.approved) why = 'GenLayer rejected this intent but a route was proposed';
    else if (legsHashOf(verdict.allocations).toLowerCase() !== proposal.legsHash.toLowerCase()) why = 'the proposed route differs from the validators\' verdict';
    else ok = true;

    console.log(`[guardian] intent #${nonce} (${left > 0 ? left + 's of delay left' : 'delay passed'}): ${ok ? 'OK, proposal matches the verdict' : 'MISMATCH, ' + why}`);
    if (ok) continue;
    if (!veto) {
      console.log('[guardian]   report only; pass --veto to cancel it');
      continue;
    }
    if (left <= 0) console.log('[guardian]   the delay already passed: vetoing anyway (works until someone finalises)');
    const key = process.env['GUARDIAN_PRIVATE_KEY'] ?? process.env['DEPLOYER_PRIVATE_KEY'];
    if (!key) throw new Error('no GUARDIAN_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY');
    const w = new Wallet(key, provider);
    const c = vault(chain, w);
    const struct = { nonce, user: intent.user, amount: intent.amount, promptHash: promptHashOf(intent.prompt), routeLock: intent.routeLock!, expiry: intent.expiry! };
    await c.getFunction('vetoSettlement').staticCall(struct);
    const tx = (await c.getFunction('vetoSettlement')(struct)) as { hash: string };
    const rc = await provider.waitForTransaction(tx.hash, 1, 60_000);
    console.log(`[guardian]   vetoed #${nonce}: ${tx.hash} ${rc?.status === 1 ? 'confirmed' : 'NOT confirmed'}`);
  }
}

do {
  try {
    await checkOnce();
  } catch (err) {
    console.error('[guardian] error:', err instanceof Error ? err.message : err);
  }
  if (loopSec > 0) await new Promise((r) => setTimeout(r, loopSec * 1000));
} while (loopSec > 0);
process.exit(0);
