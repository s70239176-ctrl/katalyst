// Localhost-only dev wallet for testing the dApp without a browser extension.
// Serves a minimal EIP-1193 backend on http://127.0.0.1:8787/rpc, signing with DEPLOYER_PRIVATE_KEY
// (testnet key). The key never leaves this process. Pair it with the shim in scripts/dev_wallet_shim.js.
//   node scripts/dev_wallet.mjs
import 'dotenv/config';
import { createServer } from 'node:http';
import { JsonRpcProvider, Wallet, toBeHex } from 'ethers';

const CHAIN_ID = 420420777;
const provider = new JsonRpcProvider(process.env.PORTALDOT_EVM_RPC, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
// Comma-separated list of page origins allowed to use this wallet (default: the local dev server only).
const ORIGINS = (process.env.DEV_WALLET_ORIGINS ?? 'http://localhost:5173').split(',').map((o) => o.trim());

async function handle({ method, params = [] }) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts': return [wallet.address];
    case 'eth_chainId': return toBeHex(CHAIN_ID);
    case 'net_version': return String(CHAIN_ID);
    case 'wallet_switchEthereumChain': return null;
    case 'eth_sendTransaction': {
      const t = params[0];
      const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value, gasLimit: t.gas });
      console.log(`[dev-wallet] sent ${tx.hash}`);
      return tx.hash;
    }
    default: return provider.send(method, params);
  }
}

createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin ?? '') ? req.headers.origin : ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  let body = '';
  for await (const c of req) body += c;
  try {
    const result = await handle(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
  } catch (e) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: e.code ?? -32000, message: e.shortMessage ?? e.message, data: e.data } }));
  }
}).listen(8787, '127.0.0.1', () => console.log(`[dev-wallet] ${wallet.address} on http://127.0.0.1:8787 (allowed origins ${ORIGINS.join(', ')})`));
