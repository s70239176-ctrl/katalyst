// Debug: how much did the relayer pay/receive around a v2 intent's proposal and finalisation?
//   node --env-file=.env scripts/debug_refund_v2.mjs <nonce>
import { Contract, JsonRpcProvider, Wallet, formatEther, toBeHex, zeroPadValue } from 'ethers';
import { readFileSync } from 'node:fs';

const nonce = Number(process.argv[2]);
const abi = JSON.parse(readFileSync('../contracts/evm/build/v2/KatalystVaultV2.json', 'utf8')).abi;
const p = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC, 420420777, { staticNetwork: true, batchMaxCount: 1 });
const c = new Contract(process.env.VAULT_V2_ADDRESS, abi, p);
const relayer = new Wallet(process.env.RELAYER_PRIVATE_KEY).address;
const head = await p.getBlockNumber();
const from = Number(process.env.VAULT_V2_DEPLOY_BLOCK);
const topicN = zeroPadValue(toBeHex(nonce), 32);
const bal = async (n) => BigInt(await p.send('eth_getBalance', [relayer, toBeHex(n)]));

for (const name of ['IntentDeposited', 'SettlementProposed', 'IntentExecuted']) {
  const topic = c.interface.getEvent(name).topicHash;
  let logs = [];
  for (let s = from; s <= head; s += 1000) logs.push(...(await p.getLogs({ address: c.target, topics: [topic, topicN], fromBlock: s, toBlock: Math.min(s + 999, head) })));
  for (const l of logs) {
    const b = l.blockNumber;
    const block = await p.send('eth_getBlockByNumber', [toBeHex(b), true]);
    const mine = block.transactions.filter((t) => t.from.toLowerCase() === relayer.toLowerCase()).length;
    const rc = await p.getTransactionReceipt(l.transactionHash).catch(() => null);
    const delta = (await bal(b)) - (await bal(b - 1));
    console.log(`${name}: block ${b}, relayer txs in block ${mine}, relayer delta ${formatEther(delta)}, gas fee ${rc ? formatEther(rc.fee) : 'n/a (pruned)'}`);
  }
}
process.exit(0);
