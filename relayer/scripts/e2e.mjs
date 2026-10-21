// Live end-to-end check: deposit from the deployer key, then wait for the relayer to settle it.
//   node scripts/e2e.mjs "<prompt>" [amountPOT]
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';

const abi = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8')).abi;
const p = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC, 420420777, { staticNetwork: true, batchMaxCount: 1 });
const user = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
const vault = new Contract(process.env.VAULT_CONTRACT_ADDRESS, abi, user);
const prompt = process.argv[2] ?? 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.';
const amount = parseEther(process.argv[3] ?? '1');
const bal = async (a) => BigInt(await p.send('eth_getBalance', [a, 'latest']));
const pools = process.env.SEED_POOLS.split(',');
const before = await Promise.all(pools.map(bal));
const userBefore = await bal(user.address);

const tx = await vault.depositIntent(prompt, { value: amount });
const rc = await tx.wait();
const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IntentDeposited');
const nonce = ev.args.nonce;
console.log(`deposited ${formatEther(amount)} tPOT as intent #${nonce} in block ${rc.blockNumber}; waiting for relayer ...`);

const topics = ['IntentExecuted', 'IntentRejected'].map((n) => vault.interface.getEvent(n).topicHash);
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 6000));
  const latest = await p.getBlockNumber();
  const logs = await p.getLogs({ address: await vault.getAddress(), topics: [topics, '0x' + nonce.toString(16).padStart(64, '0')], fromBlock: rc.blockNumber, toBlock: latest });
  if (logs.length) {
    const parsed = vault.interface.parseLog(logs[0]);
    console.log(`${parsed.name} in block ${logs[0].blockNumber} (tx ${logs[0].transactionHash})`);
    const after = await Promise.all(pools.map(bal));
    pools.forEach((a, i) => console.log(`  pool ${a}  +${formatEther(after[i] - before[i])} tPOT`));
    console.log(`  user net change ${formatEther((await bal(user.address)) - userBefore)} tPOT (deposit + gas)`);
    console.log(`  vault balance ${formatEther(await bal(await vault.getAddress()))} tPOT`);
    process.exit(0);
  }
}
console.log('timed out waiting for settlement'); process.exit(1);
