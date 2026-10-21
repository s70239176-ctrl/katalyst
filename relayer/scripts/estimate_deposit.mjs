// Read-only: dry-run instantiate of KatalystVault via ReviveApi to measure the real deposit.
// Uses a rich account only as dry-run `origin` (nothing is signed or sent).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { AbiCoder, Wallet } from 'ethers';

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev') });
const kr = new Keyring({ type: 'sr25519', ss58Format: 42 });
const f = (v) => Number(BigInt(v.toString())) / 1e14;

// Find a funded origin for the dry run (dev accounts + our deployer).
const candidates = ['//Alice', '//Bob', '//Charlie', '//Dave', '//Eve', '//Ferdie'].map((u) => kr.addFromUri(u));
let origin;
for (const c of candidates) {
  const { data } = await api.query.system.account(c.address);
  console.log(c.meta.name ?? '', c.address, 'free', f(data.free));
  if (!origin || data.free.gt((await api.query.system.account(origin.address)).data.free)) origin = c;
}
const art = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8'));
const relayer = Wallet.createRandom().address;
const pools = (process.env.SEED_POOLS ?? '').split(',').filter(Boolean);
const args = AbiCoder.defaultAbiCoder().encode(['address', 'address[]'], [relayer, pools]).slice(2);
const code = art.bytecode + args;

const dry = await api.call.reviveApi.instantiate(origin.address, 0, null, null, { Upload: code }, '0x', null);
const r = dry.result;
console.log('origin', origin.address);
console.log('result', r.isOk ? 'Ok' : 'Err ' + JSON.stringify(r.asErr.toHuman()));
const h = dry.toHuman();
console.log(JSON.stringify({ ...h, result: undefined }, null, 1).slice(0, 1500));
const sd = dry.storageDeposit;
console.log('storageDeposit:', sd.toString(), sd.isCharge ? f(sd.asCharge) + ' tPOT charged' : '');
await api.disconnect(); process.exit(0);
