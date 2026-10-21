// Deploy genlayer/intelligent_vault_solver.py to GenLayer Studionet (gasless; same flow as our other projects).
//   node scripts/deploy_genlayer.mjs                      -> the Katalyst solver (recorded in .env)
//   node scripts/deploy_genlayer.mjs --file <path.py> --args '<json array>'   -> any contract (NOT recorded in .env)
// Uses GENLAYER_PRIVATE_KEY from .env, or generates a throwaway key and stores it there.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { createAccount, createClient, generatePrivateKey } from 'genlayer-js';
import * as chains from 'genlayer-js/chains';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chain = chains[process.env.GENLAYER_CHAIN?.trim() || 'studionet'];
if (!chain) throw new Error('unknown GENLAYER_CHAIN');

const setEnv = (k, v) => {
  let env = readFileSync('.env', 'utf8');
  env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + `\n${k}=${v}\n`;
  writeFileSync('.env', env);
};

let key = process.env.GENLAYER_PRIVATE_KEY?.trim();
if (!key) { key = generatePrivateKey(); setEnv('GENLAYER_PRIVATE_KEY', key); console.log('generated GenLayer key -> relayer/.env'); }
const account = createAccount(key);
const client = createClient({ chain, account });
const flag = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const file = flag('file');
const code = readFileSync(file ?? '../genlayer/intelligent_vault_solver.py', 'utf8');
const ctorArgs = flag('args') !== undefined ? JSON.parse(flag('args')) : [account.address];

console.log(`deploying IntelligentVaultSolver to ${chain.name} from ${account.address} ...`);
const hash = await client.deployContract({ code, args: ctorArgs });
console.log('deploy tx', hash);

let address;
for (let i = 0; i < 60 && !address; i++) {
  await sleep(8000);
  const tx = await client.request({ method: 'eth_getTransactionByHash', params: [hash] });
  const status = tx?.status ?? 'PENDING';
  process.stdout.write(`  status ${status}\n`);
  if (['ACCEPTED', 'FINALIZED'].includes(status)) {
    address = tx?.data?.contract_address ?? tx?.to_address ?? tx?.recipient;
    if (!address) throw new Error('accepted but no contract address in tx: ' + Object.keys(tx ?? {}).join(','));
  } else if (['UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT'].includes(status)) {
    throw new Error('deploy failed: ' + status + '\n' + JSON.stringify(tx?.consensus_data?.leader_receipt?.[0]?.result ?? tx, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 800));
  }
}
if (!address) throw new Error('deploy timed out');
console.log((file ? 'CONTRACT_ADDRESS=' : 'GENLAYER_CONTRACT_ADDRESS=') + address);
if (file) { console.log('Custom contract: .env was not modified.'); process.exit(0); }
setEnv('GENLAYER_CONTRACT_ADDRESS', address);
setEnv('GENLAYER_CHAIN', chain === chains.studionet ? 'studionet' : (process.env.GENLAYER_CHAIN ?? 'studionet'));
console.log('recorded in relayer/.env');
process.exit(0);
