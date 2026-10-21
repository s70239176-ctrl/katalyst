// Live test of the v2 safety net: a (simulated) misbehaving relayer proposes a route that differs from what the
// GenLayer validators agreed on; the guardian must catch it and the owner veto must refund the depositor in full.
//   node --env-file=.env --import tsx scripts/test_guardian_v2.mts
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env['VAULTS'] = JSON.stringify([
  {
    key: 'portaldot-v2',
    name: 'Portaldot V3 Testnet (v2)',
    chainId: 420420777,
    rpcUrl: process.env['PORTALDOT_EVM_RPC'],
    vault: process.env['VAULT_V2_ADDRESS'],
    version: 2,
    deployBlock: Number(process.env['VAULT_V2_DEPLOY_BLOCK']),
    explorerBlockUrl: 'https://node-console.portaldot.dev/#/explorer/query/{block}',
  },
]);

const { GET: relay } = await import('../../frontend/api/relay.ts');
const { intentRef, chainByKey } = await import('../../frontend/api/_lib/config.ts');
const { submitAdjudication, readResult, parseVerdict } = await import('../../frontend/api/_lib/genlayer.ts');
const { promptHashOf, encodeEco } = await import('../../frontend/api/_lib/vault.ts');

const chain = chainByKey('portaldot-v2');
const abi = JSON.parse(readFileSync('../contracts/evm/build/v2/KatalystVaultV2.json', 'utf8')).abi;
const rpc = new JsonRpcProvider(process.env['PORTALDOT_EVM_RPC'], 420420777, { staticNetwork: true, batchMaxCount: 1 });
const user = new Wallet(process.env['DEPLOYER_PRIVATE_KEY']!, rpc);
const relayerWallet = new Wallet(process.env['RELAYER_PRIVATE_KEY']!, rpc);
const asUser = new Contract(process.env['VAULT_V2_ADDRESS']!, abi, user);
const asRelayer = new Contract(process.env['VAULT_V2_ADDRESS']!, abi, relayerWallet);
const bal = async (a: string): Promise<bigint> => BigInt(await rpc.send('eth_getBalance', [a, 'latest']));

const prompt = 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.';
const amount = parseEther('0.2');

// Optional: resume an intent that is already deposited and judged (an RPC hiccup interrupted an earlier run).
const resume = process.argv[2] ? Number(process.argv[2]) : 0;
const { loadIntent } = await import('../../frontend/api/_lib/vault.ts');
let nonce: number;
let depositBlock: number;
let expiry: number;
const ref0 = (n: number) => intentRef(chain, n);
if (resume) {
  const it = await loadIntent(chain, resume);
  if (!it) throw new Error('intent not found');
  nonce = resume;
  depositBlock = it.blockNumber;
  expiry = it.expiry!;
  console.log(`1. resuming intent #${nonce}`);
} else {
  // 1. Deposit
  const tx = await asUser.getFunction('depositIntent')(prompt, '0x' + '00'.repeat(32), { value: amount });
  const rc = await tx.wait();
  const ev = rc.logs.map((l: any) => { try { return asUser.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === 'IntentDeposited');
  nonce = Number(ev.args.nonce);
  depositBlock = rc.blockNumber;
  expiry = Number(ev.args.expiry);
  console.log(`1. deposited intent #${nonce}`);
  await submitAdjudication(ref0(nonce), prompt, amount);
}

// 2. Let GenLayer judge it (without letting the honest relayer settle it)
const ref = ref0(nonce);
let verdict: ReturnType<typeof parseVerdict> | null = null;
for (let i = 0; i < 40 && !verdict; i++) {
  const raw = await readResult(ref);
  if (raw) verdict = parseVerdict(raw, nonce, ref);
  else await new Promise((r) => setTimeout(r, 6000));
}
if (!verdict) throw new Error('no GenLayer verdict');
console.log(`2. validators agreed: ${verdict.approved ? 'approved ' + verdict.allocations.map((a) => a.percentage + '% ' + a.target_pool.slice(0, 8)).join(' / ') : 'rejected'}`);

// 3. The "misbehaving relayer" proposes 100% to a pool the validators did NOT pick (Gamma, C-Tier)
const gamma = getAddress('0x036a137130b01ede1cde55752f22c4b358845f59');
const struct = { nonce, user: user.address, amount, promptHash: promptHashOf(prompt), routeLock: '0x' + '00'.repeat(32), expiry };
const bad = [{ pool: gamma, pct: 100, eco: encodeEco('C-Tier') }];
const ptx = await asRelayer.getFunction('executeAdjudicatedIntent')(struct, bad);
await ptx.wait();
console.log('3. rogue proposal recorded on-chain (100% to Pool Gamma)');

// 4. The guardian catches it
const g = spawnSync(process.execPath, ['--env-file=.env', '--import', 'tsx', 'scripts/guardian.mts', '--veto'], { encoding: 'utf8' });
console.log(g.stdout.trim());
if (g.status !== 0) console.error(g.stderr);

// 5. The depositor got everything back, and the relay endpoint reports the veto
const q = new URLSearchParams({ nonce: String(nonce), block: String(depositBlock), chain: 'portaldot-v2' });
const body: any = await (await relay(new Request(`http://local/api/relay?${q}`))).json();
console.log(`5. relay phase=${body.phase}; vault balance for this intent is settled; depositor balance now ${formatEther(await bal(user.address))}`);
process.exit(body.phase === 'vetoed' ? 0 : 1);
