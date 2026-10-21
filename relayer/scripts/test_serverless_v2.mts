// Live test of the v2 vault through the serverless relayer (no daemon): deposit, then poll /api/relay the way the
// browser does until the intent reaches a terminal state, including the settlement delay. Run from relayer/:
//   node --env-file=.env --import tsx scripts/test_serverless_v2.mts "<prompt>" 0.2
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';

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

const abi = JSON.parse(readFileSync('../contracts/evm/build/v2/KatalystVaultV2.json', 'utf8')).abi;
const rpc = new JsonRpcProvider(process.env['PORTALDOT_EVM_RPC'], 420420777, { staticNetwork: true, batchMaxCount: 1 });
const user = new Wallet(process.env['DEPLOYER_PRIVATE_KEY']!, rpc);
const vault = new Contract(process.env['VAULT_V2_ADDRESS']!, abi, user);
const bal = async (a: string): Promise<bigint> => BigInt(await rpc.send('eth_getBalance', [a, 'latest']));

const prompt = process.argv[2] ?? 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.';
const amount = parseEther(process.argv[3] ?? '0.2');

const routeLock = '0x' + '00'.repeat(32); // no lock; the lock path is covered by the contract tests

const before = await bal(user.address);
const tx = await vault.getFunction('depositIntent')(prompt, routeLock, { value: amount });
const rc = await tx.wait();
const ev = rc.logs.map((l: any) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === 'IntentDeposited');
const nonce = Number(ev.args.nonce);
console.log(`deposited ${formatEther(amount)} as v2 intent #${nonce} at block ${rc.blockNumber} (no lock, expiry ${ev.args.expiry})`);

let gl: string | undefined;
const t0 = Date.now();
const terminal = ['executed', 'rejected', 'cancelled', 'expired', 'vetoed', 'lock_mismatch'];
for (let i = 0; i < 60; i++) {
  const q = new URLSearchParams({ nonce: String(nonce), block: String(rc.blockNumber), chain: 'portaldot-v2' });
  if (gl) q.set('gl', gl);
  const t = Date.now();
  const res = await relay(new Request(`http://local/api/relay?${q}`));
  const body: any = await res.json();
  gl = body.glTx ?? body.genlayer?.txHash ?? gl;
  console.log(`poll ${i + 1} (${((Date.now() - t) / 1000).toFixed(1)}s) HTTP ${res.status} phase=${body.phase}` +
    (body.proposal?.secondsLeft !== undefined ? ` delay_left=${body.proposal.secondsLeft}s` : '') +
    (body.genlayer ? ` votes=${body.genlayer.validatorsAgreed}/${body.genlayer.validatorsTotal}` : '') +
    (body.portaldot?.txHash ? ` tx=${body.portaldot.txHash.slice(0, 12)}…` : '') +
    (body.refund ? ` refund=${formatEther(BigInt(body.refund.amount))}` : '') +
    (body.error ? ` error=${body.error}` : ''));
  if (terminal.includes(body.phase)) {
    console.log('verdict:', body.verdict?.approved, body.verdict?.allocations?.map((a: any) => a.percentage + '%').join('/'));
    console.log(`end-to-end ${(Date.now() - t0) / 1000}s; user net cost ${formatEther(before - (await bal(user.address)))} tPOT (deposit + gas)`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
console.log('did not settle in time');
process.exit(1);
