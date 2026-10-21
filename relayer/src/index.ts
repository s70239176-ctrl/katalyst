import 'dotenv/config';
import { formatEther } from 'ethers';
import { startApi } from './api.js';
import { triggerGenLayerAdjudication } from './genlayer_client.js';
import { VerdictStore } from './verdict_store.js';
import {
  PORTALDOT_CHAIN_ID,
  PORTALDOT_EVM_RPC,
  balanceOfWei,
  returnStorageRefund,
  disconnect,
  getProvider,
  getRelayerWallet,
  isIntentPending,
  listenToVaultEvents,
  submitAdjudicatedExecution,
  submitRejection,
  type DepositedIntent,
} from './portaldot_client.js';

/** Forward the chain's storage-deposit refund to the depositor (default on). */
const RETURN_REFUND = (process.env['RELAYER_RETURN_REFUND'] ?? 'true').toLowerCase() !== 'false';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) throw new Error(`${name} is not set (see .env.example)`);
  return value.trim();
}

async function main(): Promise<void> {
  const vault = requireEnv('VAULT_CONTRACT_ADDRESS');

  const provider = getProvider();
  const wallet = getRelayerWallet();
  const [network, block, balance] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getBalance(wallet.address),
  ]);
  console.log(`[RELAYER] Portaldot chain ${network.chainId} block ${block} via ${PORTALDOT_EVM_RPC}`);
  console.log(`[RELAYER] Relayer ${wallet.address} (${formatEther(balance)} tPOT); watching vault ${vault}`);
  if (balance === 0n) console.warn('[RELAYER] WARNING: relayer balance is 0 — settlements will fail until it is funded');

  // Serialize settlement: one relayer account => one tx nonce stream.
  const seen = new Set<number>();
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;

  const store = new VerdictStore();
  const api = startApi(
    store,
    {
      relayerAddress: wallet.address,
      vault,
      genlayerContract: requireEnv('GENLAYER_CONTRACT_ADDRESS'),
      genlayerChain: process.env['GENLAYER_CHAIN']?.trim() || 'studionet',
      chainId: PORTALDOT_CHAIN_ID,
      balanceWei: () => balanceOfWei(wallet.address),
      queueLength: () => queued,
    },
    Number(process.env['RELAYER_API_PORT'] ?? process.env['PORT'] ?? 8788),
  );

  const handle = async (intent: DepositedIntent): Promise<void> => {
    try {
      // Skip intents already settled/cancelled (e.g. replayed by the startup backfill).
      if (!(await isIntentPending(vault, intent.nonce))) return;

      console.log(`[RELAYER] Intercepted Intent #${intent.nonce} from ${intent.user}`);
      const base = { user: intent.user, amount: intent.amount, prompt: intent.prompt };
      store.upsert(intent.nonce, { ...base, phase: 'adjudicating' });

      const verdict = await triggerGenLayerAdjudication(intent.nonce, intent.prompt, intent.amount);
      store.upsert(intent.nonce, {
        ...base,
        phase: 'settling',
        genlayer: {
          txHash: verdict.txHash,
          explorerUrl: verdict.explorerUrl,
          validatorsAgreed: verdict.validatorsAgreed,
          validatorsTotal: verdict.validatorsTotal,
          votes: verdict.votes,
        },
        verdict: {
          approved: verdict.approved,
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
          allocations: verdict.allocations,
          trace: verdict.trace,
        },
      });

      const balanceBefore = await balanceOfWei(wallet.address);
      const receipt = verdict.approved
        ? await submitAdjudicatedExecution(vault, intent, verdict.allocations)
        : await submitRejection(vault, intent);

      console.log(
        `[RELAYER] Intent #${intent.nonce} ${verdict.approved ? 'EXECUTED' : 'REJECTED+REFUNDED'} ` +
          `in block ${receipt.blockNumber} (tx ${receipt.txHash})`,
      );
      console.log(`[RELAYER] Explorer: ${receipt.explorerUrl}`);
      store.upsert(intent.nonce, {
        ...base,
        phase: verdict.approved ? 'executed' : 'rejected',
        portaldot: { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl, blockNumber: receipt.blockNumber },
      });

      if (RETURN_REFUND) {
        try {
          const back = await returnStorageRefund(intent.user, balanceBefore, receipt);
          if (back.refunded > 0n) {
            console.log(`[RELAYER] Returned ${formatEther(back.refunded)} tPOT storage refund to ${intent.user} (tx ${back.txHash})`);
            store.upsert(intent.nonce, { ...base, refund: { amount: back.refunded.toString(), txHash: back.txHash ?? '' } });
          }
        } catch (err) {
          // The intent itself is already settled; only the refund forwarding failed.
          console.error(`[RELAYER] Refund return for #${intent.nonce} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      // Stays pending on-chain: the depositor can cancelIntent, or a restart re-processes it
      // (the GenLayer solver is idempotent per nonce).
      seen.delete(intent.nonce);
      const message = err instanceof Error ? err.message : String(err);
      store.upsert(intent.nonce, { user: intent.user, amount: intent.amount, prompt: intent.prompt, phase: 'failed', error: message });
      console.error(`[RELAYER] Intent #${intent.nonce} failed:`, message);
    }
  };

  const stop = await listenToVaultEvents(vault, (intent) => {
    if (seen.has(intent.nonce)) return;
    seen.add(intent.nonce);
    queued += 1;
    queue = queue.then(() => handle(intent)).finally(() => {
      queued -= 1;
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[RELAYER] ${signal} received — shutting down`);
    stop();
    api.close();
    await queue;
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[RELAYER] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
