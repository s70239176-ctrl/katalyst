// Deploy KatalystVault to Portaldot. Dry-run by default; pass --send to submit.
//   node scripts/deploy.mjs          -> balances + gas/storage estimate, nothing signed
//   node scripts/deploy.mjs --send   -> uploads code and instantiates the contract
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { CodePromise, Abi } from '@polkadot/api-contract';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, randomAsU8a } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

const WS = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const BUNDLE = process.env.VAULT_BUNDLE_PATH ?? '../target/ink/katalyst_vault/katalyst_vault.contract';
const send = process.argv.includes('--send');

const need = (n) => {
  const v = process.env[n]?.trim();
  if (!v) throw new Error(`${n} missing in .env`);
  return v;
};

await cryptoWaitReady();
const kr = new Keyring({ type: 'sr25519', ss58Format: 42 });
const deployer = kr.addFromMnemonic(need('DEPLOYER_MNEMONIC'));
const relayer = kr.addFromMnemonic(need('RELAYER_MNEMONIC'));

const api = await ApiPromise.create({ provider: new WsProvider(WS) });
const decimals = api.registry.chainDecimals[0] ?? 14;
const sym = api.registry.chainTokens[0] ?? 'POT';
const fmt = (v) => `${Number(v) / 10 ** decimals} ${sym}`;

console.log(`chain: ${(await api.rpc.system.chain()).toString()}  ss58: ${api.registry.chainSS58}  decimals: ${decimals}`);
for (const [label, pair] of [['deployer', deployer], ['relayer ', relayer]]) {
  const { data } = await api.query.system.account(pair.address);
  console.log(`${label} ${pair.address}  free: ${fmt(data.free.toBigInt())}`);
}

const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
const abi = new Abi(bundle, api.registry.getChainProperties());
const wasm = bundle.source.wasm; // plain 0x-hex from the .contract bundle
const salt = u8aToHex(randomAsU8a(16));
const ctor = abi.constructors.find((c) => c.method === 'new');
const data = u8aToHex(ctor.toU8a([relayer.address]));

const dry = await api.call.contractsApi.instantiate(
  deployer.address, 0, null, null, { Upload: wasm }, data, salt,
);
if (dry.result.isErr) throw new Error(`Dry-run failed: ${dry.result.asErr.toString()}`);
const gas = dry.gasRequired;
const deposit = dry.storageDeposit.isCharge ? dry.storageDeposit.asCharge.toBigInt() : 0n;
console.log(`dry-run OK. gas refTime=${gas.refTime.toBigInt()} proofSize=${gas.proofSize.toBigInt()}  storage deposit: ${fmt(deposit)}`);
console.log(`constructor arg relayer = ${relayer.address}`);

if (!send) {
  console.log('Dry run only. Re-run with --send to deploy.');
  await api.disconnect();
  process.exit(0);
}

const code = new CodePromise(api, bundle, wasm);
const gasLimit = api.registry.createType('WeightV2', {
  refTime: (gas.refTime.toBigInt() * 12n) / 10n,
  proofSize: (gas.proofSize.toBigInt() * 12n) / 10n,
});

const address = await new Promise((resolve, reject) => {
  let unsub;
  code.tx
    .new({ gasLimit, storageDepositLimit: null, salt }, relayer.address)
    .signAndSend(deployer, (res) => {
      if (res.dispatchError) {
        const e = res.dispatchError;
        const d = e.isModule ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(e.asModule)) : e.toString();
        unsub?.();
        return reject(new Error(`Deployment failed: ${d}`));
      }
      if (res.status.isInBlock) console.log(`in block ${res.status.asInBlock.toHex()}`);
      if (res.status.isFinalized) {
        unsub?.();
        const addr = res.contract?.address?.toString();
        addr ? resolve(addr) : reject(new Error('No contract address in result'));
      }
    })
    .then((u) => (unsub = u))
    .catch(reject);
});

console.log(`DEPLOYED KatalystVault at ${address}`);
await api.disconnect();
