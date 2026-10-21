import { formatEther } from 'ethers';
import { CHAIN_ID, VAULT_ADDRESS, getProvider, getRelayerWallet, handleError, json } from './_lib/config.js';
import { genlayerChainName, genlayerContract } from './_lib/genlayer.js';
import { vault } from './_lib/vault.js';

/** Relayer status for the Network page. `relayerMatchesVault` flags a mis-set RELAYER_PRIVATE_KEY. */
export async function GET(): Promise<Response> {
  try {
    const wallet = getRelayerWallet();
    const [balance, onChainRelayer] = await Promise.all([getProvider().getBalance(wallet.address), vault().getFunction('relayer')() as Promise<string>]);
    return json({
      ok: onChainRelayer.toLowerCase() === wallet.address.toLowerCase(),
      mode: 'serverless',
      relayer: wallet.address,
      relayerMatchesVault: onChainRelayer.toLowerCase() === wallet.address.toLowerCase(),
      relayerBalance: formatEther(balance),
      vault: VAULT_ADDRESS(),
      genlayer: { chain: genlayerChainName(), contract: genlayerContract() },
      chainId: CHAIN_ID,
    });
  } catch (err) {
    return handleError(err);
  }
}
