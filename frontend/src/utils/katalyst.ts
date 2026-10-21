/** The dApp's SDK instance, configured from Vite env. */
import { createKatalyst, type Katalyst } from '../sdk';
import { GENLAYER_CONTRACT, previewKey } from './genlayer';
import { PORTALDOT_EVM_RPC, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK } from './substrate';

let instance: Katalyst | undefined;

export function getKatalyst(): Katalyst {
  instance ??= createKatalyst({
    vault: VAULT_ADDRESS,
    rpcUrl: PORTALDOT_EVM_RPC,
    deployBlock: VAULT_DEPLOY_BLOCK,
    ...(GENLAYER_CONTRACT ? { genlayer: { contract: GENLAYER_CONTRACT, privateKey: previewKey() } } : {}),
  });
  return instance;
}

export const katalystConfigured = (): boolean => VAULT_ADDRESS.length > 0;
