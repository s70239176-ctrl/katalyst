import { formatEther } from 'ethers';
import { chains, getProvider, getRelayerWallet, handleError, json } from './_lib/config.js';
import { genlayerChainName, genlayerContract } from './_lib/genlayer.js';
import { vault } from './_lib/vault.js';

/** Relayer status for the Network page. `relayerMatchesVault` flags a mis-set relayer key on any chain. */
export async function GET(): Promise<Response> {
  try {
    const rows = await Promise.all(
      chains().map(async (c) => {
        const wallet = getRelayerWallet(c);
        const [balance, onChain] = await Promise.all([getProvider(c).getBalance(wallet.address), vault(c).getFunction('relayer')() as Promise<string>]);
        return { key: c.key, name: c.name, chainId: c.chainId, vault: c.vault, relayer: wallet.address, relayerMatchesVault: onChain.toLowerCase() === wallet.address.toLowerCase(), relayerBalance: formatEther(balance) };
      }),
    );
    const first = rows[0]!;
    const match = rows.every((r) => r.relayerMatchesVault);
    return json({
      ok: match,
      mode: 'serverless',
      relayer: first.relayer,
      relayerMatchesVault: match,
      relayerBalance: first.relayerBalance,
      vault: first.vault,
      chainId: first.chainId,
      genlayer: { chain: genlayerChainName(), contract: genlayerContract() },
      chains: rows,
    });
  } catch (err) {
    return handleError(err);
  }
}
