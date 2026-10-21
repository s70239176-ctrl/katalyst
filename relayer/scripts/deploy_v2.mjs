// Deploy KatalystVaultV2 + PoolHub to PortaldotV3. Dry run by default: estimates real cost, sends nothing.
//   node scripts/compile_v2.mjs
//   node scripts/deploy_v2.mjs [--fee 0.05] [--cap 50] [--ttl 3600] [--delay 60]            -> estimate only
//   node scripts/deploy_v2.mjs --send [same flags]                                          -> deploy + register pools
//
// Policy values are IMMUTABLE once deployed (that is what keeps storage deposits low and the owner unable to change them):
//   --fee    POT taken from each executed/rejected intent (covers relayer gas, deters spam)     default 0.05
//   --cap    maximum deposit per intent in POT, 0 = none                                         default 50
//   --ttl    seconds until anyone can refund a stuck intent                                      default 3600
//   --delay  seconds a proposed settlement waits (owner may veto), 0 = settle immediately         default 60
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress, getCreateAddress, parseEther, zeroPadBytes, toUtf8Bytes } from 'ethers';

const send = process.argv.includes('--send');
const flag = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const need = (n) => { const v = process.env[n]?.trim(); if (!v) throw new Error(`${n} missing in .env`); return v; };

const fee = parseEther(flag('fee', '0.05'));
const cap = parseEther(flag('cap', '50'));
const ttl = BigInt(flag('ttl', '3600'));
const delay = BigInt(flag('delay', '60'));

const provider = new JsonRpcProvider(flag('rpc', process.env.PORTALDOT_EVM_RPC ?? 'https://test-evm-rpc-v3.portaldot.dev'), Number(flag('chain-id', 420420777)), { staticNetwork: true, batchMaxCount: 1 });
const deployer = new Wallet(need('DEPLOYER_PRIVATE_KEY'), provider);
const relayer = new Wallet(need('RELAYER_PRIVATE_KEY')).address;
const pools = need('SEED_POOLS').split(',').map((a) => getAddress(a.trim()));
const load = (n) => JSON.parse(readFileSync(`../contracts/evm/build/v2/${n}.json`, 'utf8'));
const hubArt = load('PoolHub'); const vaultArt = load('KatalystVaultV2');

const nonce = await provider.getTransactionCount(deployer.address);
const predictedVault = getCreateAddress({ from: deployer.address, nonce: nonce + 1 }); // hub first (nonce), vault second (nonce+1)
const hubFactory = new ContractFactory(hubArt.abi, hubArt.bytecode, deployer);
const vaultFactory = new ContractFactory(vaultArt.abi, vaultArt.bytecode, deployer);
const hubTx = await hubFactory.getDeployTransaction(predictedVault);
const vaultTx = await vaultFactory.getDeployTransaction(predictedVault /* hub address is not known yet: any address is fine for estimation */, relayer, fee, cap, ttl, delay);

const [balance, feeData] = await Promise.all([provider.getBalance(deployer.address), provider.getFeeData()]);
const price = feeData.gasPrice;
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)}`);
console.log(`relayer  ${relayer}\npools    ${pools.join(', ')}`);
console.log(`policy   fee ${formatEther(fee)}  cap ${formatEther(cap)}  ttl ${ttl}s  delay ${delay}s  (immutable)\n`);

const est = async (label, tx) => {
  try {
    const gas = await provider.estimateGas({ ...tx, from: deployer.address });
    const cost = gas * price;
    console.log(`${label.padEnd(26)} gas ${gas}  ->  ~${Number(formatEther(cost)).toFixed(2)} tPOT`);
    return cost;
  } catch (e) {
    console.log(`${label.padEnd(26)} estimate failed: ${e.shortMessage ?? e.message}`);
    return null;
  }
};
const c1 = await est('PoolHub', hubTx);
const c2 = await est('KatalystVaultV2', vaultTx);
const setPoolEach = parseEther('5.5'); // measured on v1: a whitelist slot costs ~5.6 tPOT
const total = (c1 ?? 0n) + (c2 ?? 0n) + setPoolEach * BigInt(pools.length);
console.log(`${'registering ' + pools.length + ' pools'.padEnd(2)}`.padEnd(26), `~${Number(formatEther(setPoolEach * BigInt(pools.length))).toFixed(2)} tPOT (3 x ~5.5, estimated from v1)`);
console.log(`${'TOTAL (estimate)'.padEnd(26)} ~${Number(formatEther(total)).toFixed(2)} tPOT   | after: ~${Number(formatEther(balance - total)).toFixed(2)} tPOT left`);

if (!send) { console.log('\nDry run only. Re-run with --send to deploy.'); process.exit(0); }
if (c1 === null || c2 === null) throw new Error('Refusing to send: an estimate failed');
if (balance < total) throw new Error('Refusing to send: balance below the estimated total');

console.log('\ndeploying PoolHub ...');
const hub = await hubFactory.deploy(predictedVault);
await hub.waitForDeployment();
const hubAddress = await hub.getAddress();
console.log('  hub', hubAddress);
console.log('deploying KatalystVaultV2 ...');
const vault = await vaultFactory.deploy(hubAddress, relayer, fee, cap, ttl, delay);
await vault.waitForDeployment();
const vaultAddress = await vault.getAddress();
if (vaultAddress.toLowerCase() !== predictedVault.toLowerCase()) throw new Error(`vault landed at ${vaultAddress}, not the predicted ${predictedVault}; the hub is bound to the wrong vault`);
const block = (await vault.deploymentTransaction().wait()).blockNumber;
console.log(`  vault ${vaultAddress} (block ${block})`);

for (const p of pools) {
  await (await hub.setPool(p, true, zeroPadBytes(toUtf8Bytes(p.toLowerCase() === pools[2]?.toLowerCase() ? 'C-Tier' : 'A-Tier'), 8))).wait();
  console.log('  registered pool', p);
}

let env = readFileSync('.env', 'utf8');
const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + `\n${k}=${v}\n`; };
set('VAULT_V2_ADDRESS', vaultAddress); set('HUB_V2_ADDRESS', hubAddress); set('VAULT_V2_DEPLOY_BLOCK', String(block));
writeFileSync('.env', env);
console.log(`\nDEPLOYED. Recorded VAULT_V2_ADDRESS, HUB_V2_ADDRESS, VAULT_V2_DEPLOY_BLOCK in relayer/.env; deployer balance now ${formatEther(await provider.getBalance(deployer.address))}`);
process.exit(0);
