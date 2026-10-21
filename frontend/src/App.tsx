import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityPage } from './components/ActivityPage';
import { activeChain, chainId, tokenSymbol } from './utils/chains';
import { GreyboxModal } from './components/GreyboxModal';
import { Header, type Page } from './components/Header';
import { IntentTerminal, EXAMPLES, type PreviewState } from './components/IntentTerminal';
import { NetworkPage } from './components/NetworkPage';
import { PositionsPage } from './components/PositionsPage';
import type { VaultPolicy } from './sdk/vault';
import { routeLockOf } from './sdk/vault';
import { getKatalyst } from './utils/katalyst';
import { isV2 } from './utils/vaultAbi';
import { ReceiptPage } from './components/ReceiptPage';
import { VerifyPage } from './components/VerifyPage';
import { RouteVisualizer } from './components/RouteVisualizer';
import { SecurityLab } from './components/SecurityLab';
import { Stepper, type Step } from './components/Stepper';
import { VerdictCard } from './components/VerdictCard';
import { ExternalLink, Notice } from './components/ui';
import { POLL_INTERVAL_MS, fetchVerdict } from './utils/api';
import { previewIntent } from './utils/genlayer';
import {
  vaultAddress,
  cancelIntent,
  connectWallet,
  depositIntent,
  explorerBlockUrl,
  fetchOutcome,
  getConnectedWallet,
  getWalletChainId,
  pingNetwork,
  subscribeBalance,
  subscribeWalletEvents,
  switchToChain,
  type DepositReceipt,
} from './utils/substrate';
import { formatPot, shortHash, type FlowStage, type IntentOutcome, type NetworkStatus, type UserIntent, type VerdictPayload, type VerdictRecord, type WalletState } from './utils/types';

const MAX_POLLS = 150;

const PAGES: readonly Page[] = ['intent', 'activity', 'positions', 'network', 'verify', 'security', 'receipt'];

interface Route {
  page: Page;
  /** Optional intent number, as in #/verify/8 or #/receipt/8. */
  nonce: number | null;
}

function routeFromHash(): Route {
  const [p, arg] = window.location.hash.replace(/^#\/?/, '').split('/');
  const page = (PAGES as readonly string[]).includes(p ?? '') ? (p as Page) : 'intent';
  const n = Number(arg);
  return { page, nonce: Number.isSafeInteger(n) && n > 0 ? n : null };
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return (err as { shortMessage?: string }).shortMessage ?? err.message;
  return fallback;
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const page = route.page;
  const [network, setNetwork] = useState<NetworkStatus>('connecting');
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [prompt, setPrompt] = useState(EXAMPLES[0]?.prompt ?? '');
  const [amount, setAmount] = useState('1');
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [previewVerdict, setPreviewVerdict] = useState<VerdictPayload | null>(null);
  const [policy, setPolicy] = useState<VaultPolicy | null>(null);
  const [lockRoute, setLockRoute] = useState(false);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));

  const [stage, setStage] = useState<FlowStage>('idle');
  const [deposit, setDeposit] = useState<DepositReceipt | null>(null);
  const [outcome, setOutcome] = useState<IntentOutcome | null>(null);
  const [record, setRecord] = useState<VerdictRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [receipt, setReceipt] = useState<{ intent: UserIntent; record: VerdictRecord | null } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notifyMe, setNotifyMe] = useState(false);
  const notifyRef = useRef(false);
  useEffect(() => {
    notifyRef.current = notifyMe;
  }, [notifyMe]);
  const pollToken = useRef(0);

  // ---- routing ------------------------------------------------------------------
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((p: Page, nonce?: number) => {
    window.location.hash = `/${p}${nonce ? `/${nonce}` : ''}`;
  }, []);

  // ---- network + wallet ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await pingNetwork();
      if (!cancelled) setNetwork(ok ? 'online' : 'offline');
    };
    void check();
    const t = setInterval(() => void check(), 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const syncWallet = useCallback(async () => {
    setWallet(await getConnectedWallet());
    setWalletChain(await getWalletChainId());
  }, []);

  useEffect(() => {
    void syncWallet();
    return subscribeWalletEvents(() => void syncWallet());
  }, [syncWallet]);

  useEffect(() => {
    if (!wallet) {
      setBalance(null);
      return;
    }
    return subscribeBalance(wallet.address, setBalance);
  }, [wallet]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setMessage(null);
    try {
      setWallet(await connectWallet());
      setWalletChain(await getWalletChainId());
    } catch (err) {
      setMessage(errorText(err, 'Wallet connection failed'));
    } finally {
      setConnecting(false);
    }
  }, []);

  const wrongNetwork = wallet !== null && walletChain !== null && walletChain !== chainId();

  // v2: the vault's fixed rules (fee, cap, timeout, delay) are shown before the user commits.
  useEffect(() => {
    if (!isV2() || !vaultAddress()) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const p = await getKatalyst().vault.policy();
          if (!cancelled) setPolicy(p);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- preview ------------------------------------------------------------------
  const handlePreview = useCallback(async () => {
    setPreview({ status: 'loading' });
    setPreviewVerdict(null);
    setLockRoute(false);
    try {
      setPreviewVerdict(await previewIntent(prompt.trim()));
      setPreview({ status: 'ready' });
    } catch (err) {
      setPreview({ status: 'error', message: errorText(err, 'Preview failed') });
    }
  }, [prompt]);

  // ---- lifecycle ----------------------------------------------------------------
  const pollLifecycle = useCallback(async (d: DepositReceipt) => {
    const token = ++pollToken.current;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (token !== pollToken.current) return;

      // Check the chain first (fast and authoritative). In serverless mode the relay call below does real
      // work and can take a while, so a settled intent must never wait on it.
      const result = await fetchOutcome(vaultAddress(), d.nonce, d.blockNumber).catch(() => null);
      if (token !== pollToken.current) return;

      if (result) {
        setOutcome(result);
        setStage(result.status === 'Executed' ? 'executed' : 'rejected');
        if (result.status !== 'Executed') {
          setMessage(
            result.status === 'Rejected'
              ? 'The solver rejected this intent. Your deposit was refunded' + (result.fee ? ` (minus the ${formatPot(result.fee, 4)} ${tokenSymbol()} fee).` : '.')
              : result.status === 'Expired'
                ? 'The timeout passed before the intent settled, so it was refunded in full. No fee was charged.'
                : result.status === 'Vetoed'
                  ? 'The vault owner vetoed the proposed route during the safety delay. Your deposit was refunded in full.'
                  : 'Intent cancelled. Your deposit was refunded.',
          );
        }
        setRefreshKey((k) => k + 1);
        if (notifyRef.current && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Katalyst', { body: result.status === 'Executed' ? `Intent #${d.nonce} settled.` : `Intent #${d.nonce} was ${result.status.toLowerCase()} and refunded.` });
        }
        // Enrich with consensus details and the refund-return once available.
        const enrich = () => void fetchVerdict(d.nonce, { block: d.blockNumber }).then((r) => r && token === pollToken.current && setRecord(r));
        enrich();
        setTimeout(enrich, 10000);
        return;
      }

      const rec = await fetchVerdict(d.nonce, { block: d.blockNumber });
      if (token !== pollToken.current) return;
      if (rec) setRecord(rec);

      setStage(rec?.phase === 'settling' ? 'settling' : rec?.phase === 'proposed' ? 'proposed' : 'adjudicating');
      if (rec?.phase === 'lock_mismatch') {
        setStage('error');
        setMessage('The validators now choose a different route than the one you locked, so nothing was paid. Cancel for a full refund (no fee); it also refunds by itself when the timeout passes.');
        return;
      }
      if (rec?.phase === 'failed') {
        setStage('error');
        setMessage('The relayer could not complete this intent. You can cancel it for a full refund.');
        return;
      }
    }
    setStage('error');
    setMessage('Timed out waiting for settlement. Is the relayer running? You can cancel for a refund.');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!wallet) return;
    setMessage(null);
    setOutcome(null);
    setRecord(null);
    setDeposit(null);
    setStage('depositing');
    try {
      const lock =
        isV2() && lockRoute && previewVerdict?.status === 'APPROVED'
          ? routeLockOf(previewVerdict.allocations.map((a) => ({ pool: a.target_pool, pct: a.percentage })))
          : undefined;
      const d = await depositIntent(vaultAddress(), prompt, amount, lock);
      setDeposit(d);
      setStage('adjudicating');
      void pollLifecycle(d);
    } catch (err) {
      setStage('error');
      setMessage(errorText(err, 'Deposit failed'));
    }
  }, [wallet, prompt, amount, pollLifecycle, lockRoute, previewVerdict]);

  const handleCancel = useCallback(async () => {
    if (!deposit) return;
    setCancelling(true);
    try {
      await cancelIntent(vaultAddress(), deposit);
      void pollLifecycle(deposit);
    } catch (err) {
      setMessage(errorText(err, 'Cancel failed (the relayer may have just settled it)'));
    } finally {
      setCancelling(false);
    }
  }, [deposit, pollLifecycle]);

  const reset = () => {
    pollToken.current += 1;
    setStage('idle');
    setDeposit(null);
    setOutcome(null);
    setRecord(null);
    setMessage(null);
  };

  useEffect(() => () => void (pollToken.current += 1), []);

  // ---- derived UI state ---------------------------------------------------------
  const busy = stage === 'depositing' || stage === 'adjudicating' || stage === 'proposed' || stage === 'settling';
  useEffect(() => {
    if (stage !== 'proposed') return;
    const t = setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [stage]);
  const disabledReason = !vaultAddress()
    ? 'The vault address is not configured (VITE_VAULT_ADDRESS).'
    : network !== 'online'
      ? `Waiting for ${activeChain().name}…`
      : !wallet
        ? 'Connect a wallet to deposit. You can still preview a verdict without one.'
        : wrongNetwork
          ? `Switch your wallet to ${activeChain().name}.`
          : undefined;

  const steps: Step[] = (() => {
    const gl = record?.genlayer;
    const verdict = record?.verdict;
    const settled = outcome !== null;
    const failed = stage === 'error' && !settled;
    return [
      {
        title: `Deposit locked on ${activeChain().name}`,
        state: stage === 'depositing' ? 'active' : deposit ? 'done' : 'pending',
        detail: deposit ? (
          <>
            {formatPot(deposit.amount)} {tokenSymbol()} ·{' '}
            <ExternalLink href={explorerBlockUrl(deposit.blockNumber)} mono>
              {shortHash(deposit.txHash)}
            </ExternalLink>
          </>
        ) : undefined,
      },
      {
        title: 'GenLayer validators reach consensus',
        state: failed && !gl ? 'failed' : (gl && gl.validatorsTotal > 0) || settled ? 'done' : deposit ? 'active' : 'pending',
        detail: gl && gl.validatorsTotal > 0 ? (
          <>
            {gl.validatorsAgreed}/{gl.validatorsTotal} validators agreed ·{' '}
            <ExternalLink href={gl.explorerUrl} mono>
              {shortHash(gl.txHash)}
            </ExternalLink>
          </>
        ) : deposit && !settled ? (
          'Validators are reading your intent…'
        ) : settled && (outcome?.status === 'Cancelled' || outcome?.status === 'Expired') ? (
          'Not needed: the intent ended before consensus.'
        ) : undefined,
      },
      {
        title: `Settlement on ${activeChain().name}`,
        state: settled ? 'done' : failed && gl ? 'failed' : record?.phase === 'settling' || record?.phase === 'proposed' ? 'active' : 'pending',
        detail: outcome ? (
          <>
            {outcome.status === 'Executed'
              ? `Routed to ${outcome.route?.length ?? 0} pool${(outcome.route?.length ?? 0) === 1 ? '' : 's'}${outcome.fee ? ` · fee ${formatPot(outcome.fee, 4)} ${tokenSymbol()}` : ''}`
              : outcome.status === 'Rejected'
                ? 'Rejected — deposit refunded'
                : outcome.status === 'Expired'
                  ? 'Timed out — deposit refunded in full'
                  : outcome.status === 'Vetoed'
                    ? 'Vetoed during the safety delay — deposit refunded in full'
                    : 'Cancelled — deposit refunded'}{' '}
            ·{' '}
            <ExternalLink href={explorerBlockUrl(outcome.blockNumber)} mono>
              {shortHash(outcome.txHash)}
            </ExternalLink>
          </>
        ) : record?.phase === 'proposed' ? (
          (() => {
            const left = record.proposal?.readyAt ? Math.max(0, record.proposal.readyAt - clock) : null;
            return left === null ? 'Route proposed. Waiting out the safety delay…' : left > 0 ? `Route proposed. Safety delay: ${left}s left. The vault owner can veto it until then.` : 'Safety delay over. Finalising on-chain…';
          })()
        ) : verdict && record?.phase === 'settling' ? (
          verdict.approved ? 'Sending funds to the agreed pools…' : 'Refunding your deposit…'
        ) : undefined,
      },
    ];
  })();

  const openCurrentReceipt = () => {
    if (!deposit || !outcome) return;
    setReceipt({
      intent: { nonce: deposit.nonce, user: wallet?.address ?? '', amount: deposit.amount, prompt, depositTx: deposit.txHash, depositBlock: deposit.blockNumber, outcome },
      record,
    });
  };

  const shownVerdict: VerdictPayload | null = record?.verdict
    ? { status: record.verdict.approved ? 'APPROVED' : 'REJECTED', ...(record.verdict.reason ? { reason: record.verdict.reason } : {}), allocations: record.verdict.allocations, trace: record.verdict.trace }
    : null;

  const diagramRoute =
    deposit && shownVerdict?.status === 'APPROVED' ? shownVerdict.allocations : !deposit && previewVerdict?.status === 'APPROVED' ? previewVerdict.allocations : null;

  return (
    <div className="flex min-h-screen flex-col">
      <Header page={page} onNavigate={(p) => navigate(p)} wallet={wallet} balance={balance} network={network} connecting={connecting} onConnect={() => void handleConnect()} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {wrongNetwork && (
          <div className="mb-6">
            <Notice tone="warn" title="Wrong network" action={<button type="button" className="btn btn-sm" onClick={() => void switchToChain().then(syncWallet)}>Switch network</button>}>
              Your wallet is on chain {walletChain}. Katalyst is set to {activeChain().name} (chain {chainId()}).
            </Notice>
          </div>
        )}
        {network === 'offline' && (
          <div className="mb-6">
            <Notice tone="bad" title={`Cannot reach ${activeChain().name}`}>
              The EVM RPC is not responding. Retrying automatically.
            </Notice>
          </div>
        )}

        {page === 'intent' && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <IntentTerminal
              prompt={prompt}
              onPromptChange={setPrompt}
              amount={amount}
              onAmountChange={setAmount}
              balance={balance}
              canSubmit={disabledReason === undefined}
              busy={busy}
              {...(disabledReason ? { disabledReason } : {})}
              preview={preview}
              onPreview={() => void handlePreview()}
              onSubmit={() => void handleSubmit()}
              policy={policy}
              lockRoute={lockRoute}
              onLockRouteChange={setLockRoute}
              canLock={previewVerdict?.status === 'APPROVED'}
            />

            <div className="space-y-6">
              {deposit ? (
                <section className="card p-6" aria-labelledby="progress-title" aria-live="polite">
                  <div className="flex items-center justify-between">
                    <h2 id="progress-title" className="text-lg font-semibold tracking-tight">
                      Intent #{deposit.nonce}
                    </h2>
                    {(stage === 'adjudicating' || stage === 'proposed' || stage === 'settling' || stage === 'error') && !outcome && (
                      <button type="button" className="btn btn-sm" onClick={() => void handleCancel()} disabled={cancelling}>
                        {cancelling ? 'Cancelling…' : 'Cancel & refund'}
                      </button>
                    )}
                  </div>
                  <div className="mt-5">
                    <Stepper steps={steps} />
                  </div>
                  {!outcome && stage !== 'error' && 'Notification' in window && (
                    <label className="mt-4 flex items-center gap-2 text-sm text-muted">
                      <input
                        type="checkbox"
                        checked={notifyMe}
                        onChange={(e) => {
                          const on = e.target.checked;
                          if (!on) return setNotifyMe(false);
                          void Notification.requestPermission().then((p) => setNotifyMe(p === 'granted'));
                        }}
                      />
                      Notify me when it settles
                    </label>
                  )}
                  {message && (
                    <p role="status" className={`mt-4 text-sm ${stage === 'error' ? 'text-danger' : 'text-muted'}`}>
                      {message}
                    </p>
                  )}
                  {outcome && (
                    <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                      <button type="button" className="btn btn-sm" onClick={openCurrentReceipt}>
                        View receipt
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>
                        New intent
                      </button>
                    </div>
                  )}
                </section>
              ) : (
                <>
                  {message && <Notice tone="bad" title="Something went wrong">{message}</Notice>}
                  {previewVerdict ? (
                    <section className="card p-6" aria-labelledby="preview-title">
                      <h2 id="preview-title" className="mb-4 text-lg font-semibold tracking-tight">
                        Verdict preview
                      </h2>
                      <VerdictCard status={previewVerdict.status} reason={previewVerdict.reason} allocations={previewVerdict.allocations} trace={previewVerdict.trace} note="Preview only — nothing was deposited" />
                    </section>
                  ) : (
                    <section className="card p-6" aria-labelledby="how-title">
                      <h2 id="how-title" className="text-lg font-semibold tracking-tight">
                        How it works
                      </h2>
                      <ol className="mt-4 space-y-4 text-sm">
                        {[
                          ['Deposit', `Your funds are escrowed in a vault contract on ${activeChain().name} together with your intent.`],
                          ['Adjudicate', 'GenLayer validators read the intent, apply guardrails and agree on a route. No single party decides.'],
                          ['Settle', 'The vault re-checks the route on-chain (totals, whitelist) and only then pays the pools.'],
                        ].map(([t, d], i) => (
                          <li key={t} className="flex gap-3">
                            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line2 text-xs text-muted">{i + 1}</span>
                            <p>
                              <span className="font-medium">{t}.</span> <span className="text-muted">{d}</span>
                            </p>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                </>
              )}

              {deposit && shownVerdict && (
                <section className="card p-6" aria-labelledby="verdict-title">
                  <h2 id="verdict-title" className="mb-4 text-lg font-semibold tracking-tight">
                    Verdict
                  </h2>
                  <VerdictCard status={shownVerdict.status} reason={shownVerdict.reason} allocations={shownVerdict.allocations} trace={shownVerdict.trace} />
                </section>
              )}

              <section className="card p-4" aria-label="Route diagram">
                <RouteVisualizer stage={stage} route={diagramRoute} />
              </section>
            </div>
          </div>
        )}

        {page === 'activity' && <ActivityPage wallet={wallet} onConnect={() => void handleConnect()} onOpen={(intent, rec) => setReceipt({ intent, record: rec })} refreshKey={refreshKey} />}
        {page === 'positions' && <PositionsPage wallet={wallet} onConnect={() => void handleConnect()} refreshKey={refreshKey} />}
        {page === 'network' && <NetworkPage refreshKey={refreshKey} />}
        {page === 'verify' && <VerifyPage initialNonce={route.nonce} onNavigate={(p, n) => navigate(p, n)} />}
        {page === 'receipt' && <ReceiptPage nonce={route.nonce} onNavigate={(p, n) => navigate(p, n)} />}
        {page === 'security' && (
          <SecurityLab
            onUsePrompt={(p) => {
              setPrompt(p);
              navigate('intent');
            }}
          />
        )}
      </main>

      <footer className="border-t border-line py-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 text-xs text-subtle">
          <span>Katalyst · Testnet software, unaudited. Do not use with funds you cannot lose.</span>
          <span>GenLayer decides · {activeChain().name} settles</span>
        </div>
      </footer>

      <GreyboxModal
        intent={receipt?.intent ?? null}
        record={receipt?.record ?? null}
        onClose={() => setReceipt(null)}
        onNavigate={(p, n) => {
          setReceipt(null);
          navigate(p, n);
        }}
      />
    </div>
  );
}
