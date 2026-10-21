// Read-only: show each EVM key's address and its *mapped native account* (where $POT must be sent).
//   node scripts/fund_evm.mjs
import 'dotenv/config';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { JsonRpcProvider, Wallet, formatEther } from 'ethers';

const provider = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC ?? 'https://test-evm-rpc-v3.portaldot.dev', 420420777, { staticNetwork: true, batchMaxCount: 1 });
const api = await ApiPromise.create({ provider: new WsProvider(process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev'), noInitWarn: true });

for (const name of ['DEPLOYER', 'RELAYER']) {
  const key = process.env[`${name}_PRIVATE_KEY`]?.trim();
  if (!key) { console.log(`${name}: ${name}_PRIVATE_KEY not set`); continue; }
  const { address } = new Wallet(key);
  const native = encodeAddress((await api.call.reviveApi.accountId(address)).toU8a(), 42);
  const bal = await provider.getBalance(address);
  console.log(`${name.padEnd(9)} EVM ${address}\n          send tPOT to native ${native}\n          current balance ${formatEther(bal)} tPOT`);
}
await api.disconnect();
process.exit(0);
