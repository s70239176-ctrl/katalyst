// Deploy contracts/evm/KatalystVault.sol to PortaldotV3 via the EVM RPC.
//   node scripts/deploy_evm.mjs          -> estimate + balance check, nothing sent
//   node scripts/deploy_evm.mjs --send   -> deploys and records the address in .env
//   --rpc <url> --chain-id <n>           -> deploy to another EVM chain (prints the address; .env is not touched)
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from 'ethers';

const send = process.argv.includes('--send');
const flag = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const customRpc = flag('rpc');
const need = (n) => { const v = process.env[n]?.trim(); if (!v) throw new Error(`${n} missing in .env`); return v; };

const provider = new JsonRpcProvider(customRpc ?? process.env.PORTALDOT_EVM_RPC ?? 'https://test-evm-rpc-v3.portaldot.dev', Number(flag('chain-id') ?? 420420777), { staticNetwork: true, batchMaxCount: 1 });
const deployer = new Wallet(need('DEPLOYER_PRIVATE_KEY'), provider);
const relayer = new Wallet(need('RELAYER_PRIVATE_KEY')).address;
const pools = need('SEED_POOLS').split(',').map((a) => getAddress(a.trim()));
const art = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8'));

const factory = new ContractFactory(art.abi, art.bytecode, deployer);
const deployTx = await factory.getDeployTransaction(relayer, pools);

const [balance, fee] = await Promise.all([provider.getBalance(deployer.address), provider.getFeeData()]);
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)} tPOT`);
console.log(`relayer  ${relayer}\npools    ${pools.join(', ')}`);

let gas;
try {
  gas = await provider.estimateGas({ ...deployTx, from: deployer.address });
  console.log(`estimateGas ${gas}  ->  ~${formatEther(gas * fee.gasPrice)} tPOT incl. storage deposit`);
} catch (e) {
  console.log(`estimateGas failed: ${e.shortMessage ?? e.message}`);
  console.log('Most likely the deployer cannot cover the storage deposit (~300 tPOT).');
}
if (!send) { console.log('Dry run only. Re-run with --send to deploy.'); process.exit(0); }
if (gas === undefined) throw new Error('Refusing to send: estimate failed');
if (balance < gas * fee.gasPrice) throw new Error('Refusing to send: balance below estimated cost');

const c = await factory.deploy(relayer, pools);
console.log(`tx ${c.deploymentTransaction().hash} ... waiting`);
await c.waitForDeployment();
const address = await c.getAddress();
const deployBlock = (await c.deploymentTransaction().wait()).blockNumber;
console.log(`DEPLOYED KatalystVault at ${address} (block ${deployBlock})`);
if (customRpc) { console.log('Custom chain: add it to VAULTS / VITE_CHAINS; .env was not modified.'); process.exit(0); }

let env = readFileSync('.env', 'utf8');
env = /^VAULT_CONTRACT_ADDRESS=.*$/m.test(env) ? env.replace(/^VAULT_CONTRACT_ADDRESS=.*$/m, `VAULT_CONTRACT_ADDRESS=${address}`) : env + `\nVAULT_CONTRACT_ADDRESS=${address}\n`;
writeFileSync('.env', env);
console.log('Recorded VAULT_CONTRACT_ADDRESS in relayer/.env');
process.exit(0);
