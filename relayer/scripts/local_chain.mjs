// A second, local EVM chain (ganache) for multi-chain testing. Funds the deployer and relayer keys from .env,
// so the same relayer account can settle on it exactly as it does on Portaldot.
//   node scripts/local_chain.mjs [port=8546] [chainId=31337]
import 'dotenv/config';
import { createRequire } from 'node:module';
import { Wallet } from 'ethers';

const ganache = createRequire(import.meta.url)('ganache');
const port = Number(process.argv[2] ?? 8546);
const chainId = Number(process.argv[3] ?? 31337);

const keys = ['DEPLOYER_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY'].map((n) => {
  const k = process.env[n]?.trim();
  if (!k) throw new Error(`${n} missing in .env`);
  return k;
});
const balance = '0x' + (1000n * 10n ** 18n).toString(16);

const server = ganache.server({
  wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance })) },
  chain: { chainId, networkId: chainId, hardfork: 'shanghai' },
  logging: { quiet: true },
});
await server.listen(port);
console.log(`[local-chain] chain ${chainId} on http://127.0.0.1:${port}`);
for (const k of keys) console.log(`[local-chain] funded ${new Wallet(k).address} with 1000`);
