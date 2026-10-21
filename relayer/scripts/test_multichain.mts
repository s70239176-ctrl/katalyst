// End-to-end multi-chain test: one GenLayer solver, two settlement chains (Portaldot + a local EVM chain).
//   node scripts/local_chain.mjs &                          # second chain on :8546
//   node scripts/deploy_evm.mjs --rpc http://127.0.0.1:8546 --chain-id 31337 --send
//   VAULT_LOCAL=0x… node --env-file=.env --import tsx scripts/test_multichain.mts
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const localVault = process.env['VAULT_LOCAL'];
if (!localVault) throw new Error('set VAULT_LOCAL to the vault deployed on the local chain');

process.env['VAULTS'] = JSON.stringify([
  { key: 'portaldot', name: 'Portaldot V3 Testnet', chainId: 420420777, rpcUrl: process.env['PORTALDOT_EVM_RPC'], vault: process.env['VAULT_CONTRACT_ADDRESS'], deployBlock: 124470, explorerBlockUrl: 'https://node-console.portaldot.dev/#/explorer/query/{block}' },
  { key: 'local', name: 'Local test chain', chainId: 31337, rpcUrl: 'http://127.0.0.1:8546', vault: localVault, deployBlock: 0, explorerBlockUrl: '' },
]);

const { GET: relay } = await import('../../frontend/api/relay.ts');
const { GET: status } = await import('../../frontend/api/status.ts');
const { createKatalyst } = await import('../../frontend/src/sdk/index.ts');

const abi = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8')).abi;
const local = new JsonRpcProvider('http://127.0.0.1:8546', 31337, { staticNetwork: true });
const user = new Wallet(process.env['DEPLOYER_PRIVATE_KEY']!, local);
const vault = new Contract(localVault, abi, user);
const bal = async (a: string): Promise<bigint> => BigInt(await local.send('eth_getBalance', [a, 'latest']));
const pools = ['0xfb8b324c03b2ba5BAF50A22dD1F8AC71c1d94dAD', '0xc6d8Bf349C0B98935b5aafC2c77309a77750B83F', '0x036A137130b01ede1cdE55752F22c4B358845F59'];

const st: any = await (await status()).json();
console.log('status ok =', st.ok, '| checks:', st.checks.map((c: any) => `${c.id}:${c.level}`).join(' '));
assert.equal(st.chains.length, 2, 'status must cover both chains');

const prompt = 'Split across the greenest pools. A-Tier only.';
const before = await Promise.all(pools.map(bal));
const tx = await vault.getFunction('depositIntent')(prompt, { value: parseEther('1') });
const rc = await tx.wait();
const nonce = Number(vault.interface.parseLog(rc.logs.find((l: any) => { try { return vault.interface.parseLog(l)?.name === 'IntentDeposited'; } catch { return false; } })!)!.args['nonce']);
console.log(`deposited 1 on the local chain: intent #${nonce}, block ${rc.blockNumber} (same vault address as Portaldot: ${localVault.toLowerCase() === process.env['VAULT_CONTRACT_ADDRESS']!.toLowerCase()})`);

let gl: string | undefined;
let final: any;
for (let i = 0; i < 30; i++) {
  const q = new URLSearchParams({ nonce: String(nonce), chain: 'local', block: String(rc.blockNumber) });
  if (gl) q.set('gl', gl);
  const t = Date.now();
  const res = await relay(new Request(`http://x/api/relay?${q}`));
  const body: any = await res.json();
  gl = body.glTx ?? body.genlayer?.txHash ?? gl;
  console.log(`poll ${i + 1} (${((Date.now() - t) / 1000).toFixed(1)}s) HTTP ${res.status} phase=${body.phase}${body.genlayer ? ` votes=${body.genlayer.validatorsAgreed}/${body.genlayer.validatorsTotal}` : ''}`);
  if (['executed', 'rejected'].includes(body.phase)) { final = body; break; }
  await new Promise((r) => setTimeout(r, 6000));
}
assert.ok(final, 'did not settle');
assert.equal(final.phase, 'executed');

const after = await Promise.all(pools.map(bal));
const paid = after.map((a, i) => a - before[i]!);
console.log('pool deltas on the local chain:', paid.map((p) => formatEther(p)).join(' / '));
assert.equal(paid.reduce((s, p) => s + p, 0n), parseEther('1'), 'the whole deposit must be paid out on the local chain');
assert.equal(final.chain, 'local');

// The same nonce exists on Portaldot but is a different intent: the solver must not mix them up.
const other: any = await (await relay(new Request(`http://x/api/relay?nonce=${nonce}&chain=portaldot`))).json();
console.log(`portaldot intent #${nonce}: phase=${other.phase}, verdict leaked from the local chain? ${other.verdict ? 'YES (bug)' : 'no'}`);
assert.ok(!other.verdict, 'verdict from another chain leaked');

// Independent verification through the SDK, against the local chain's vault.
const k = createKatalyst({ vault: localVault, rpcUrl: 'http://127.0.0.1:8546', chainId: 31337, deployBlock: 0, genlayer: { contract: process.env['GENLAYER_CONTRACT_ADDRESS']! } });
const proof = await k.verify(nonce);
console.log('SDK verify:', proof.verdict.toUpperCase(), proof.checks.map((c) => `${c.id}:${c.status}`).join(' '));
assert.equal(proof.verdict, 'verified');
console.log('\nmulti-chain OK');
process.exit(0);
