// Debug: how do EVM-RPC block numbers map to native (Substrate) block numbers on Portaldot V3?
import 'dotenv/config';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { JsonRpcProvider } from 'ethers';

const evm = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC, 420420777, { staticNetwork: true, batchMaxCount: 1 });
const api = await ApiPromise.create({ provider: new WsProvider(process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev'), noInitWarn: true });

const head = await api.rpc.chain.getHeader();
const nativeHead = head.number.toNumber();
const evmHead = Number(BigInt(await evm.send('eth_blockNumber', [])));
const evmBlock = await evm.send('eth_getBlockByNumber', ['0x' + evmHead.toString(16), false]);
console.log({ nativeHead, evmHead, diff: nativeHead - evmHead, evmTs: Number(BigInt(evmBlock.timestamp)) });

for (const off of [nativeHead - evmHead - 2, nativeHead - evmHead, nativeHead - evmHead + 2]) {
  const n = evmHead + off;
  const hash = await api.rpc.chain.getBlockHash(n);
  const at = await api.at(hash);
  const ts = Number((await at.query.timestamp.now()).toString()) / 1000;
  console.log('native', n, 'ts', ts, 'delta vs evm head ts', ts - Number(BigInt(evmBlock.timestamp)));
}
// an older block: EVM 138228 (our settlement)
const ref = nativeHead - evmHead;
const nOld = 138228 + ref;
const hOld = await api.rpc.chain.getBlockHash(nOld);
const atOld = await api.at(hOld);
const tsOld = Number((await atOld.query.timestamp.now()).toString()) / 1000;
console.log('native', nOld, 'iso', new Date(tsOld * 1000).toISOString());
const blk = await api.rpc.chain.getBlock(hOld);
console.log('extrinsics in that block:', blk.block.extrinsics.map((e) => e.method.section + '.' + e.method.method).join(', '));
await api.disconnect();
process.exit(0);
