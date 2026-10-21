// Live test of the Vercel serverless relayer WITHOUT any daemon: deposit, then poll /api/relay the way the
// browser does until the intent settles. Run from relayer/:
//   VAULT_DEPLOY_BLOCK=124470 node --env-file=.env --import tsx scripts/test_serverless.mts "<prompt>" 0.1
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { GET as relay } from '../../frontend/api/relay.ts';
import { GET as health } from '../../frontend/api/health.ts';

const abi = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8')).abi;
const rpc = new JsonRpcProvider(process.env['PORTALDOT_EVM_RPC'], 420420777, { staticNetwork: true, batchMaxCount: 1 });
const user = new Wallet(process.env['DEPLOYER_PRIVATE_KEY']!, rpc);
const vault = new Contract(process.env['VAULT_CONTRACT_ADDRESS']!, abi, user);
const bal = async (a: string): Promise<bigint> => BigInt(await rpc.send('eth_getBalance', [a, 'latest']));

console.log('health:', await (await health()).json());

const prompt = process.argv[2] ?? 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.';
const amount = parseEther(process.argv[3] ?? '0.1');
const before = await bal(user.address);
const tx = await vault.getFunction('depositIntent')(prompt, { value: amount });
const rc = await tx.wait();
const ev = rc.logs.map((l: any) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === 'IntentDeposited');
const nonce = Number(ev.args.nonce);
console.log(`deposited ${formatEther(amount)} as intent #${nonce} at block ${rc.blockNumber}`);

let gl: string | undefined;
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  const q = new URLSearchParams({ nonce: String(nonce), block: String(rc.blockNumber) });
  if (gl) q.set('gl', gl);
  const t = Date.now();
  const res = await relay(new Request(`http://local/api/relay?${q}`));
  const body: any = await res.json();
  gl = body.glTx ?? body.genlayer?.txHash ?? gl;
  console.log(`poll ${i + 1} (${((Date.now() - t) / 1000).toFixed(1)}s) HTTP ${res.status} phase=${body.phase}` +
    (body.genlayer ? ` votes=${body.genlayer.validatorsAgreed}/${body.genlayer.validatorsTotal}` : '') +
    (body.portaldot?.txHash ? ` settle=${body.portaldot.txHash.slice(0, 12)}…` : '') +
    (body.refund ? ` refund=${formatEther(BigInt(body.refund.amount))}` : '') +
    (body.error ? ` error=${body.error}` : ''));
  if (['executed', 'rejected', 'cancelled'].includes(body.phase)) {
    console.log('verdict:', body.verdict?.approved, body.verdict?.allocations?.map((a: any) => a.percentage + '%').join('/'));
    console.log(`end-to-end ${(Date.now() - t0) / 1000}s; user net cost ${formatEther(before - (await bal(user.address)))} tPOT (deposit + gas)`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
console.log('did not settle in time');
process.exit(1);
