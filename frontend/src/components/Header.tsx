import { useEffect, useRef, useState } from 'react';
import { formatPot, shortAddress, type NetworkStatus, type WalletState } from '../utils/types';
import { CHAINS, activeChain, setActiveChain, tokenSymbol } from '../utils/chains';
import { CopyButton } from './ui';

export type Page = 'protocol' | 'intent' | 'activity' | 'positions' | 'network' | 'verify' | 'security' | 'receipt';

const NAV: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'activity', label: 'Activity' },
  { id: 'positions', label: 'Positions' },
  { id: 'network', label: 'Network' },
  { id: 'verify', label: 'Verify' },
  { id: 'security', label: 'Security lab' },
];

interface HeaderProps {
  page: Page;
  onNavigate: (page: Page) => void;
  wallet: WalletState | null;
  balance: bigint | null;
  network: NetworkStatus;
  connecting: boolean;
  onConnect: () => void;
}

const NETWORK_LABEL: Record<NetworkStatus, { dot: string; label: string }> = {
  connecting: { dot: 'bg-warn', label: 'Connecting' },
  online: { dot: 'bg-accent', label: '' },
  offline: { dot: 'bg-danger', label: 'Network unreachable' },
};

export function Header({ page, onNavigate, wallet, balance, network, connecting, onConnect }: HeaderProps) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chain = activeChain();
  const net = { ...NETWORK_LABEL[network], label: NETWORK_LABEL[network].label || chain.name };

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-8">
          <button type="button" onClick={() => onNavigate('protocol')} className="flex items-center gap-2.5" aria-label="Katalyst home">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-[var(--accent-ink)]" aria-hidden="true">
              K
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Katalyst</span>
          </button>
          <nav aria-label="Primary" className="hidden gap-1 md:flex">
            {NAV.filter((n) => n.id !== 'positions' || chain.version === 2).map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onNavigate(n.id)}
                aria-current={page === n.id ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  page === n.id ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                {n.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {CHAINS.length > 1 ? (
            <label className="badge hidden items-center gap-2 sm:inline-flex">
              <span className={`h-1.5 w-1.5 rounded-full ${net.dot}`} aria-hidden="true" />
              <span className="sr-only">Settlement chain</span>
              <select
                value={chain.key}
                aria-label="Settlement chain"
                className="cursor-pointer bg-transparent text-xs outline-none"
                onChange={(e) => {
                  setActiveChain(e.target.value);
                  window.location.reload(); // rebuild every cached provider and SDK instance for the new chain
                }}
              >
                {CHAINS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="badge hidden sm:inline-flex" aria-live="polite">
              <span className={`h-1.5 w-1.5 rounded-full ${net.dot}`} />
              {net.label}
            </span>
          )}

          {wallet ? (
            <div className="relative" ref={ref}>
              <button type="button" className="btn btn-sm" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
                <span className="tabular-nums">{balance === null ? '…' : formatPot(balance)}</span>
                <span className="text-subtle">{tokenSymbol()}</span>
                <span className="mono text-muted">{shortAddress(wallet.address)}</span>
              </button>
              {menu && (
                <div role="menu" className="card absolute right-0 mt-2 w-[22rem] max-w-[90vw] p-4">
                  <div className="card-title mb-2">Account</div>
                  <AddressRow label="EVM address" value={wallet.address} />
                  {chain.portaldotNative && <AddressRow label="Native account (holds your POT)" value={wallet.native} />}
                  {chain.portaldotNative && (
                    <p className="mt-3 text-xs text-subtle">Portaldot maps each EVM address to a native account. Fund the native address with POT.</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={onConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto border-t border-line px-3 py-2 md:hidden">
        {NAV.filter((n) => n.id !== 'positions' || chain.version === 2).map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onNavigate(n.id)}
            aria-current={page === n.id ? 'page' : undefined}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${page === n.id ? 'bg-surface2 text-fg' : 'text-muted'}`}
          >
            {n.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function AddressRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-xs text-subtle">{label}</div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono break-all text-[13px]">{value}</span>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
