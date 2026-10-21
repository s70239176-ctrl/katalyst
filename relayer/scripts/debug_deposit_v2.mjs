// Debug: simulate depositIntent on the v2 vault with and without a route lock (no transaction is sent).
import { Contract, JsonRpcProvider, Wallet, parseEther, solidityPacked, keccak256 } from 'ethers';
import { readFileSync } from 'node:fs';

const abi = JSON.parse(readFileSync('../contracts/evm/build/v2/KatalystVaultV2.json', 'utf8')).abi;
const p = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC, 420420777, { staticNetwork: true, batchMaxCount: 1 });
const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
const c = new Contract(process.env.VAULT_V2_ADDRESS, abi, w);
const ZERO = '0x' + '00'.repeat(32);
const alpha = '0xfb8b324c03b2ba5baf50a22dd1f8ac71c1d94dad';
const lock = keccak256(solidityPacked(['bytes32', 'address', 'uint8'], [ZERO, alpha, 100]));
const prompt = 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.';

for (const [label, args, value] of [
  ['no lock 0.3', [prompt, ZERO], '0.3'],
  ['lock 0.3', [prompt, lock], '0.3'],
  ['no lock 0.2', [prompt, ZERO], '0.2'],
]) {
  try {
    const r = await c.getFunction('depositIntent').staticCall(...args, { value: parseEther(value) });
    console.log(label, 'ok ->', String(r));
  } catch (e) {
    console.log(label, 'FAIL', e.shortMessage ?? e.message, e.data ?? '');
  }
}
process.exit(0);
