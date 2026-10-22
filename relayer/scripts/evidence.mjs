// Prints testnet evidence for the v2 vault: every settlement-relevant event with its transaction hash and block.
//   node --env-file=.env scripts/evidence.mjs
import { Contract, JsonRpcProvider, FetchRequest } from 'ethers';
import { readFileSync } from 'node:fs';

const abi = JSON.parse(readFileSync('../contracts/evm/build/v2/KatalystVaultV2.json', 'utf8')).abi;
const hubAbi = JSON.parse(readFileSync('../contracts/evm/build/v2/PoolHub.json', 'utf8')).abi;
const req = new FetchRequest(process.env.PORTALDOT_EVM_RPC);
req.setHeader('user-agent', 'Mozilla/5.0');
req.timeout = 20000;
const retry = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
const p = new JsonRpcProvider(req, 420420777, { staticNetwork: true, batchMaxCount: 1 });
const vault = new Contract(process.env.VAULT_V2_ADDRESS, abi, p);
const hub = new Contract(process.env.HUB_V2_ADDRESS, hubAbi, p);
const from = Number(process.env.VAULT_V2_DEPLOY_BLOCK);
const head = await retry(() => p.getBlockNumber());

async function scan(c, names) {
  const out = [];
  for (const name of names) {
    const topic = c.interface.getEvent(name).topicHash;
    for (let s = from; s <= head; s += 1000) {
      const logs = await retry(() => p.getLogs({ address: c.target, topics: [topic], fromBlock: s, toBlock: Math.min(s + 999, head) }));
      for (const l of logs) out.push({ name, block: l.blockNumber, tx: l.transactionHash, args: c.interface.parseLog(l).args });
    }
  }
  return out.sort((a, b) => a.block - b.block);
}

const rows = await scan(vault, ['IntentDeposited', 'SettlementProposed', 'IntentExecuted', 'IntentRejected', 'IntentCancelled', 'IntentExpired', 'SettlementVetoed']);
for (const r of rows) console.log(`${String(r.block).padEnd(7)} #${String(r.args.nonce).padEnd(3)} ${r.name.padEnd(19)} ${r.tx}`);
console.log('--- hub');
for (const r of await scan(hub, ['PoolSet'])) console.log(`${r.block} PoolSet ${r.args.pool} ${r.tx}`);
console.log('head', head);
process.exit(0);
