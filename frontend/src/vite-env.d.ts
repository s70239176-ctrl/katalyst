/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VAULT_ADDRESS?: string;
  readonly VITE_VAULT_DEPLOY_BLOCK?: string;
  readonly VITE_PORTALDOT_EVM_RPC?: string;
  readonly VITE_GENLAYER_CONTRACT?: string;
  readonly VITE_RELAYER_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** EIP-1193 provider injected by MetaMask and compatible wallets. */
  ethereum?: {
    request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
    on?(event: string, handler: () => void): void;
    removeListener?(event: string, handler: () => void): void;
  };
}
