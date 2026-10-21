/**
 * Katalyst SDK — talk to a Katalyst deployment from a browser or Node.
 *
 *   const k = createKatalyst({ vault, rpcUrl, deployBlock, genlayer: { contract } });
 *   const verdict = await k.preview('Max yield, A-Tier only');   // free, nothing deposited
 *   const proof = await k.verify(8);                              // independent, evidence-based check
 */
import { GenLayerReader, validatorStats, type Adjudication, type GenLayerConfig, type ValidatorStat } from './genlayer';
import { VaultReader, type DepositInfo, type SettlementInfo, type VaultConfig } from './vault';
import { verifyIntent, type ProofBundle, type VerifyOptions } from './verify';
import type { VerdictPayload } from '../utils/types';

export * from './genlayer';
export * from './vault';
export * from './verify';

export interface KatalystConfig extends VaultConfig {
  genlayer?: GenLayerConfig;
  /** See VerifyOptions.legacyNonceRefs. */
  legacyNonceRefs?: boolean;
}

export interface Katalyst {
  vault: VaultReader;
  genlayer: GenLayerReader | null;
  /** Free adjudication preview. Requires `genlayer` config. */
  preview(prompt: string): Promise<VerdictPayload>;
  /** Deposit and settlement, as recorded on Portaldot. */
  getIntent(nonce: number, hintBlock?: number): Promise<{ deposit: DepositInfo | null; settlement: SettlementInfo | null }>;
  /** Build a proof bundle for an intent and run every check. */
  verify(nonce: number, opts?: VerifyOptions): Promise<ProofBundle>;
  /** Validator participation across adjudications; null where the GenLayer network cannot list transactions. */
  validators(): Promise<{ stats: ValidatorStat[]; adjudications: Adjudication[] } | null>;
}

export function createKatalyst(config: KatalystConfig): Katalyst {
  const vault = new VaultReader(config);
  const genlayer = config.genlayer ? new GenLayerReader(config.genlayer) : null;
  const need = (): GenLayerReader => {
    if (!genlayer) throw new Error('GenLayer is not configured: pass `genlayer: { contract }`');
    return genlayer;
  };
  return {
    vault,
    genlayer,
    preview: (prompt) => need().preview(prompt),
    async getIntent(nonce, hintBlock) {
      const deposit = await vault.deposit(nonce, hintBlock);
      return { deposit, settlement: deposit ? await vault.settlement(nonce, deposit.blockNumber) : null };
    },
    verify: (nonce, opts) => verifyIntent(vault, genlayer, config.genlayer?.chain ?? (genlayer ? 'studionet' : null), nonce, { legacyNonceRefs: config.legacyNonceRefs ?? false, ...opts }),
    async validators() {
      if (!genlayer) return null;
      const rows = await genlayer.adjudications();
      return rows ? { stats: validatorStats(rows), adjudications: rows } : null;
    },
  };
}
