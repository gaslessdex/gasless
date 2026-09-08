import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BurnAccount, BurnDiscoveryResult, BurnQuoteDetails } from '../../../../shared/transactions/types';
import { DetailRow, DetailSection, GaslessStatus, TokenSelector, type TokenOption } from '../../../components/ui/TransactionControls';
import { getSolanaTokenMetadata } from '../../../config/solanaTokenRegistry';
import { useWallet } from '../../../wallet/walletContext';
import { appNetwork, appNetworkLabel, explorerTransactionUrl } from '../../../config/network';
import { awaitWalletApproval } from '../../transactions/walletApproval';
import { walletGateForPreparedTransaction } from '../../transactions/walletLifecycle';
import { confettiParticleCount, createSwapSuccessFeedbackLifecycle } from '../../swap/quoteLifecycle';
import { BURN_SUCCESS_RESET_MS, discoveryReflectsBurnSettlement } from '../burnLifecycle';

type BurnState = 'disconnected' | 'loading' | 'empty' | 'selecting' | 'previewing' | 'ready' | 'awaiting-signature' | 'processing' | 'confirmed' | 'rejected' | 'stale' | 'unsupported' | 'pending' | 'failure';
type View = { state: BurnState; sessionId?: string; discovery?: BurnDiscoveryResult; quoteId?: string; burn?: BurnQuoteDetails; signature?: string; error?: string };

async function api<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload) });
  const value = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) { const error = new Error(value.error?.message ?? 'Burn is temporarily unavailable.') as Error & { code?: string }; error.code = value.error?.code; throw error; }
  return value;
}

function sol(value?: string) { if (!value) return '— SOL'; const amount = BigInt(value); const whole = amount / 1_000_000_000n; const fraction = (amount % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''} SOL`; }
function amount(raw: string, decimals: number) { const padded = raw.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
function shortMint(mint: string) { return `${mint.slice(0, 4)}…${mint.slice(-4)}`; }
function decode(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encode(value: Uint8Array) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }
function pendingBurnKey(walletAddress: string) { return `gasless:pending-burn:${appNetwork}:${walletAddress}`; }
function readPendingBurn(walletAddress: string) { try { return localStorage.getItem(pendingBurnKey(walletAddress)); } catch { return null; } }
function rememberPendingBurn(walletAddress: string, quoteId: string) { try { localStorage.setItem(pendingBurnKey(walletAddress), quoteId); } catch { /* Durable state is authoritative. */ } }
function forgetPendingBurn(walletAddress: string) { try { localStorage.removeItem(pendingBurnKey(walletAddress)); } catch { /* Nothing to clear. */ } }
function particleStyle(index: number): CSSProperties { const unit = (salt: number) => { const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453; return value - Math.floor(value); }; const origin = 20 + ((unit(1) + unit(2)) / 2) * 60; const horizontal = (unit(3) - .5) * 70; const rise = 38 + unit(4) * 22; const rotation = (unit(5) > .5 ? 1 : -1) * (240 + unit(6) * 600); return { '--origin': `${origin.toFixed(2)}%`, '--horizontal': `${horizontal.toFixed(2)}vw`, '--rise': `${rise.toFixed(2)}vh`, '--size': `${4 + Math.floor(unit(7) * 5)}px`, '--delay': `${Math.floor(unit(8) * 240)}ms`, '--duration': `${2200 + Math.floor(unit(9) * 600)}ms`, '--rotation': `${rotation.toFixed(0)}deg` } as CSSProperties; }

export function BurnConsole({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const wallet = useWallet();
  const [view, setView] = useState<View>({ state: connected ? 'loading' : 'disconnected' });
  const [selected, setSelected] = useState<BurnAccount>();
  const [confirmed, setConfirmed] = useState(false);
  const [successToast, setSuccessToast] = useState<string>();
  const [confettiCount, setConfettiCount] = useState(0);
  const [lastConfirmedSignature, setLastConfirmedSignature] = useState<string>();
  const signingLocked = useRef(false);
  const successFeedback = useRef<ReturnType<typeof createSwapSuccessFeedbackLifecycle> | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);
  const liveWalletAddress = useRef(wallet.account?.address);
  liveWalletAddress.current = wallet.account?.address;
  const tokens = useMemo<TokenOption[]>(() => (view.discovery?.eligibleAccounts ?? []).map((account) => { const metadata = getSolanaTokenMetadata(account.mint); return { id: account.address, mint: account.mint, program: account.tokenProgram, symbol: metadata?.symbol ?? `TOKEN ${shortMint(account.mint)}`, name: metadata?.name ?? 'Legacy SPL token', image: metadata?.image, balance: amount(account.tokenAmountRaw, account.decimals), eligible: true }; }), [view.discovery]);
  const selectedToken = selected ? tokens.find((token) => token.id === selected.address) ?? null : null;

  const showSuccess = useCallback((signature: string) => {
    setLastConfirmedSignature(signature);
    successFeedback.current?.show(signature, confettiParticleCount(window.innerWidth, window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  }, []);

  const refreshAfterSuccess = async (sessionId: string, walletAddress: string, signature: string, closedAccount?: string) => {
    setSelected(undefined); setConfirmed(false); setView({ state: 'confirmed', sessionId, signature }); showSuccess(signature);
    try {
      let discovery: BurnDiscoveryResult | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await api<BurnDiscoveryResult>('/api/burn/discover', { sessionId, walletAddress });
        if (!closedAccount || discoveryReflectsBurnSettlement(current, closedAccount)) { discovery = current; break; }
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
      }
      if (!discovery) throw new Error('Wallet state is still updating.');
      setView({ state: 'confirmed', sessionId, discovery, signature });
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        setView({ state: discovery!.eligibleAccounts.length ? 'selecting' : 'empty', sessionId, discovery, signature });
        resetTimer.current = undefined;
      }, BURN_SUCCESS_RESET_MS);
    } catch { setView({ state: 'confirmed', sessionId, signature, error: 'Burn completed, but the wallet view is still updating. Select SCAN AGAIN to refresh it safely.' }); }
  };

  const scan = async () => {
    if (!wallet.account) return onConnect();
    try {
      setSelected(undefined); setConfirmed(false); setView({ state: 'loading' });
      const session = await api<{ sessionId: string }>('/api/session', { walletAddress: wallet.account.address, network: appNetwork });
      const pendingQuoteId = readPendingBurn(wallet.account.address);
      if (pendingQuoteId) {
        const prior = await api<{ status: 'confirmed' | 'failed' | 'pending' | 'not_submitted'; signature?: string }>('/api/burn/status', { sessionId: session.sessionId, walletAddress: wallet.account.address, quoteId: pendingQuoteId });
        if (prior.status === 'confirmed') {
          forgetPendingBurn(wallet.account.address);
          if (prior.signature) await refreshAfterSuccess(session.sessionId, wallet.account.address, prior.signature);
          return;
        }
        if (prior.status === 'pending') { setView({ state: 'pending', sessionId: session.sessionId, signature: prior.signature, error: 'This Burn was submitted and is still being verified. No second transaction will be sent.' }); return; }
        forgetPendingBurn(wallet.account.address);
      }
      const discovery = await api<BurnDiscoveryResult>('/api/burn/discover', { sessionId: session.sessionId, walletAddress: wallet.account.address });
      setView({ state: discovery.eligibleAccounts.length ? 'selecting' : 'empty', sessionId: session.sessionId, discovery });
    } catch (error) { setView({ state: 'failure', error: error instanceof Error ? error.message : 'Burn is temporarily unavailable.' }); }
  };

  useEffect(() => { successFeedback.current?.clear(); setLastConfirmedSignature(undefined); if (!connected || !wallet.account) setView({ state: 'disconnected' }); else void scan();
    // A public-address change is the only wallet event that should restart discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, wallet.account?.address]);

  useEffect(() => {
    successFeedback.current = createSwapSuccessFeedbackLifecycle({ schedule: (callback, delayMs) => window.setTimeout(callback, delayMs), cancel: (timer) => window.clearTimeout(timer as number), showToast: setSuccessToast, showConfetti: setConfettiCount });
    return () => { successFeedback.current?.dispose(); successFeedback.current = null; if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current); };
  }, []);

  const preview = async (account: BurnAccount) => {
    if (!wallet.account || !view.sessionId) return;
    setSelected(account); setConfirmed(false); setView((current) => ({ ...current, state: 'previewing', burn: undefined, quoteId: undefined, error: undefined }));
    try {
      const quote = await api<{ quoteId: string; burn: BurnQuoteDetails }>('/api/burn/quote', { sessionId: view.sessionId, walletAddress: wallet.account.address, tokenAccount: account.address, clientRequestId: crypto.randomUUID() });
      setView((current) => ({ ...current, state: 'ready', quoteId: quote.quoteId, burn: quote.burn }));
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      setView((current) => ({ ...current, state: code === 'MESSAGE_MISMATCH' || code === 'QUOTE_EXPIRED' ? 'stale' : code === 'TOKEN_UNSUPPORTED' ? 'unsupported' : 'failure', error: error instanceof Error ? error.message : 'This asset cannot be burned safely.' }));
    }
  };

  const submit = async () => {
    if (signingLocked.current || !wallet.account || !view.sessionId || !view.quoteId || !view.burn || !confirmed) return;
    signingLocked.current = true;
    const sessionId = view.sessionId; const quoteId = view.quoteId; const walletAddress = wallet.account.address;
    let preparedForWallet = false; let walletOpened = false;
    try {
      const prepared = await api<{ burn: BurnQuoteDetails }>('/api/burn/prepare', { sessionId, walletAddress, quoteId });
      if (!prepared.burn.prepared) throw new Error('Burn preparation expired. Review the Burn again.');
      const responseReceivedAt = Date.now(); preparedForWallet = true;
      const { blockHeight } = await api<{ blockHeight: number }>('/api/burn/blockheight', { sessionId, walletAddress, quoteId });
      const gate = walletGateForPreparedTransaction(prepared.burn.prepared, responseReceivedAt, Date.now(), blockHeight);
      if (!gate.allowed) {
        await api('/api/burn/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: gate.reason }).catch(() => undefined); preparedForWallet = false;
        throw new Error('Burn preparation expired before wallet approval. Review the Burn again.');
      }
      if (liveWalletAddress.current !== walletAddress) {
        await api('/api/burn/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'wallet_account_changed' }).catch(() => undefined); preparedForWallet = false;
        throw new Error('The connected wallet changed. Review the Burn again.');
      }
      setView((current) => ({ ...current, state: 'awaiting-signature' }));
      walletOpened = true; preparedForWallet = false;
      const invokedAt = new Date().toISOString();
      const approvalPromise = awaitWalletApproval({ sign: () => wallet.signTransaction(decode(prepared.burn.prepared!.serializedTransaction)), getBlockHeight: async () => (await api<{ blockHeight: number }>('/api/burn/wallet-blockheight', { sessionId, walletAddress, quoteId })).blockHeight, lastValidBlockHeight: prepared.burn.prepared.lastValidBlockHeight });
      await api('/api/burn/wallet-event', { sessionId, walletAddress, quoteId, event: 'invoked', metadata: { clientInvokedAt: invokedAt } }).catch(() => undefined);
      const approval = await approvalPromise;
      if (approval.status === 'failed') {
        await api('/api/burn/wallet-event', { sessionId, walletAddress, quoteId, event: 'failed', metadata: { classification: approval.classification, elapsedMs: approval.elapsedMs } }).catch(() => undefined);
        await api('/api/burn/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: approval.userSignatureReturned }).catch(() => undefined);
        throw new Error(approval.classification === 'USER_EXPLICITLY_CANCELLED' ? 'Burn approval was cancelled. Nothing was submitted.' : 'The wallet could not approve this Burn. Nothing was submitted.');
      }
      if (approval.status === 'expired') {
        await api('/api/burn/wallet-event', { sessionId, walletAddress, quoteId, event: 'expired', metadata: { classification: approval.classification, elapsedMs: approval.elapsedMs, userSignatureReturned: approval.userSignatureReturned, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks } }).catch(() => undefined);
        await api('/api/burn/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: approval.userSignatureReturned }).catch(() => undefined);
        throw new Error('Burn preparation expired while your wallet was open. Nothing was submitted.');
      }
      if (liveWalletAddress.current !== walletAddress) {
        await api('/api/burn/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: 'WALLET_ACCOUNT_CHANGED', userSignatureReturned: true }).catch(() => undefined);
        throw new Error('The connected wallet changed. Nothing was submitted.');
      }
      await api('/api/burn/wallet-event', { sessionId, walletAddress, quoteId, event: 'returned', metadata: { elapsedMs: approval.elapsedMs, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks, userSignatureReturned: true } }).catch(() => undefined);
      setView((current) => ({ ...current, state: 'processing' }));
      rememberPendingBurn(walletAddress, quoteId);
      const result = await api<{ signature: string; reconciliation: { status: string } }>('/api/burn/submit', { sessionId, walletAddress, quoteId, signedTransaction: encode(approval.signedTransaction), clientRequestId: crypto.randomUUID() });
      if (result.reconciliation.status !== 'confirmed') throw new Error('This Burn was submitted but its final result is still being verified.');
      forgetPendingBurn(walletAddress);
      await refreshAfterSuccess(sessionId, walletAddress, result.signature, view.burn.account.address);
    } catch (error) {
      if (preparedForWallet && !walletOpened) await api('/api/burn/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'final_gate_unavailable' }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "This Burn couldn't be safely completed.";
      const code = (error as Error & { code?: string }).code;
      setView((current) => ({ ...current, state: /reject|cancel/i.test(message) ? 'rejected' : code === 'MESSAGE_MISMATCH' || code === 'QUOTE_EXPIRED' ? 'stale' : code === 'RECONCILIATION_FAILED' ? 'pending' : 'failure', error: message }));
    } finally { signingLocked.current = false; }
  };

  const busy = ['loading', 'previewing', 'awaiting-signature', 'processing'].includes(view.state);
  const burnedAmount = view.burn ? amount(view.burn.account.tokenAmountRaw, view.burn.account.decimals) : undefined;
  const button = !connected ? 'CONNECT WALLET' : view.state === 'loading' ? 'LOADING ASSETS…' : view.state === 'previewing' ? 'BUILDING SAFE PREVIEW…' : view.state === 'ready' ? 'BURN FULL BALANCE' : view.state === 'awaiting-signature' ? 'APPROVE IN WALLET' : view.state === 'processing' ? `BURNING ON ${appNetworkLabel}…` : view.state === 'confirmed' ? 'BURN COMPLETE' : 'SCAN AGAIN';

  return <div id="clean-panel-burn" role="tabpanel" aria-labelledby="clean-tab-burn" className="clean-mode-panel">
    {confettiCount > 0 && <div className="swap-confetti" aria-hidden="true">{Array.from({ length: confettiCount }, (_, index) => <i key={index} style={particleStyle(index)} />)}</div>}
    {successToast && <div className="swap-success-toast burn-success-toast" role="status">Burn complete · <a href={explorerTransactionUrl(successToast)} target="_blank" rel="noreferrer">View transaction</a><button type="button" aria-label="Dismiss Burn completion" onClick={() => setSuccessToast(undefined)}>×</button></div>}
    <div className="console-lead"><span className="eyebrow">CLEAN / BURN</span><h3>{view.state === 'confirmed' ? 'Burn complete.' : 'Burn a complete eligible token balance.'}</h3><p className="burn-warning">{view.burn && burnedAmount ? `This permanently destroys your entire ${burnedAmount} TOKEN ${shortMint(view.burn.account.mint)} balance in this account. This cannot be undone.` : 'Your entire selected token-account balance will be permanently destroyed. This cannot be undone.'}</p>{view.burn?.account.recoverValueAvailable && <p>Want to keep the value instead? Use Recover Value.</p>}</div>
    <div className="transaction-field selector-field"><div className="field-heading"><span>TOKEN</span><span>{selected ? `FULL BALANCE ${amount(selected.tokenAmountRaw, selected.decimals)}` : 'FULL BALANCE ONLY'}</span></div><TokenSelector label="Token to burn" value={selectedToken} tokens={tokens} onChange={(token) => { const account = view.discovery?.eligibleAccounts.find((item) => item.address === token.id); if (account) void preview(account); }} /></div>
    <div className="summary-line"><span>ACCOUNT SOL RECOVERED</span><strong>{sol(view.burn?.reclaimedRentLamports)}</strong></div>
    <div className="summary-line"><span>GASLESS SERVICE FEE (3% OF RENT)</span><strong>{sol(view.burn?.gaslessFeeLamports)}</strong></div>
    <div className="summary-line"><span>SPONSORED NETWORK COST</span><strong>{sol(view.burn?.sponsoredCostLamports)}</strong></div>
    <GaslessStatus connected={connected} />
    <div className="receive-line"><span>SOL RETURNED TO YOU</span><strong>{sol(view.burn?.netUserLamports)}</strong></div>
    {view.state === 'ready' && <label className="burn-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand that my entire {burnedAmount} TOKEN {shortMint(view.burn!.account.mint)} balance in this account will be permanently destroyed and cannot be recovered.</span></label>}
    <button className="console-primary" type="button" onClick={!connected ? onConnect : view.state === 'ready' ? () => void submit() : () => void scan()} disabled={busy || view.state === 'confirmed' || (view.state === 'ready' && !confirmed)}>{button}</button>
    {view.state === 'empty' && <p className="connection-message" role="status">No supported token balances are available to burn. Unsupported assets remain untouched.</p>}
    {view.error && <p className="connection-message" role="alert">{view.error}</p>}
    {lastConfirmedSignature && <a href={explorerTransactionUrl(lastConfirmedSignature)} target="_blank" rel="noreferrer">VIEW TRANSACTION</a>}
    <DetailSection><DetailRow label="Token" value={view.burn ? shortMint(view.burn.account.mint) : '—'} /><DetailRow label="Full balance burned" value={burnedAmount ?? '—'} /><DetailRow label="Wallet SOL balance" value={sol(view.discovery?.walletBalanceLamports)} /><DetailRow label="Account SOL recovered" value={sol(view.burn?.reclaimedRentLamports)} /><DetailRow label="GASLESS service fee (3%)" value={sol(view.burn?.gaslessFeeLamports)} /><DetailRow label="Sponsored network cost" value={sol(view.burn?.sponsoredCostLamports)} /><DetailRow label="Final SOL received" value={sol(view.burn?.netUserLamports)} /><p>The full-balance burn, account closure, fee, and SOL return happen together in one transaction.</p></DetailSection>
  </div>;
}
