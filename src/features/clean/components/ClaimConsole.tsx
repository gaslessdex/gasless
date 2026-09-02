import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ClaimDiscoveryResult, ClaimQuoteDetails } from '../../../../shared/transactions/types';
import { DetailRow, DetailSection, GaslessStatus } from '../../../components/ui/TransactionControls';
import { useWallet } from '../../../wallet/walletContext';
import { BurnConsole } from './BurnConsole';
import { RecoverConsole } from './RecoverConsole';
import { appNetwork, appNetworkLabel, explorerTransactionUrl } from '../../../config/network';
import { awaitWalletApproval } from '../../transactions/walletApproval';
import { walletGateForPreparedTransaction } from '../../transactions/walletLifecycle';
import { confettiParticleCount, createSwapSuccessFeedbackLifecycle } from '../../swap/quoteLifecycle';
import { discoveryReflectsClaimSettlement, nonemptySkippedAccountCount } from '../claimLifecycle';

export type ClaimState = 'disconnected' | 'scanning' | 'results' | 'empty' | 'review' | 'awaiting-signature' | 'submitting' | 'pending' | 'confirmed' | 'rejected' | 'changed' | 'unavailable' | 'failure';
type CleanMode = 'claim' | 'recover' | 'burn';
type ClaimView = { state: ClaimState; sessionId?: string; quoteId?: string; discovery?: ClaimDiscoveryResult; claim?: ClaimQuoteDetails; signatures?: string[]; error?: string };

const MODES: { id: CleanMode; label: string }[] = [
  { id: 'claim', label: 'CLAIM SOL' },
  { id: 'recover', label: 'RECOVER VALUE' },
  { id: 'burn', label: 'BURN' },
];

async function api<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload) });
  const value = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) { const error = new Error(value.error?.message ?? 'Claim SOL is temporarily unavailable.') as Error & { code?: string }; error.code = value.error?.code; throw error; }
  return value;
}

function formatLamports(value?: string) {
  if (!value) return '— SOL';
  const lamports = BigInt(value);
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} SOL`;
}

function decodeBase64(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encodeBase64(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function pendingClaimKey(walletAddress: string) { return `gasless:pending-claim:${walletAddress}`; }
function readPendingClaim(walletAddress: string) { try { return localStorage.getItem(pendingClaimKey(walletAddress)); } catch { return null; } }
function rememberPendingClaim(walletAddress: string, quoteId: string) { try { localStorage.setItem(pendingClaimKey(walletAddress), quoteId); } catch { /* Durable server state remains authoritative. */ } }
function forgetPendingClaim(walletAddress: string) { try { localStorage.removeItem(pendingClaimKey(walletAddress)); } catch { /* Nothing to clear. */ } }
function particleStyle(index: number): CSSProperties { const unit = (salt: number) => { const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453; return value - Math.floor(value); }; const origin = 20 + ((unit(1) + unit(2)) / 2) * 60; const horizontal = (unit(3) - .5) * 70; const rise = 38 + unit(4) * 22; const rotation = (unit(5) > .5 ? 1 : -1) * (240 + unit(6) * 600); return { '--origin': `${origin.toFixed(2)}%`, '--horizontal': `${horizontal.toFixed(2)}vw`, '--rise': `${rise.toFixed(2)}vh`, '--size': `${4 + Math.floor(unit(7) * 5)}px`, '--delay': `${Math.floor(unit(8) * 240)}ms`, '--duration': `${2200 + Math.floor(unit(9) * 600)}ms`, '--rotation': `${rotation.toFixed(0)}deg` } as CSSProperties; }

export function ClaimConsole({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const wallet = useWallet();
  const [mode, setMode] = useState<CleanMode>('claim');
  const [view, setView] = useState<ClaimView>({ state: connected ? 'scanning' : 'disconnected' });
  const [successToast, setSuccessToast] = useState<string>();
  const [confettiCount, setConfettiCount] = useState(0);
  const [refreshingWallet, setRefreshingWallet] = useState(false);
  const [lastConfirmedSignatures, setLastConfirmedSignatures] = useState<string[]>([]);
  const [completedAccountCount, setCompletedAccountCount] = useState(0);
  const signingLocked = useRef(false);
  const successFeedback = useRef<ReturnType<typeof createSwapSuccessFeedbackLifecycle> | null>(null);
  const liveWalletAddress = useRef(wallet.account?.address);
  liveWalletAddress.current = wallet.account?.address;

  const showSuccess = useCallback((signatures: string[], accountCount = 0) => {
    setLastConfirmedSignatures(signatures);
    setCompletedAccountCount(accountCount);
    for (const signature of signatures) successFeedback.current?.show(signature, confettiParticleCount(window.innerWidth, window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  }, []);

  const refreshAfterSuccess = async (sessionId: string, walletAddress: string, signatures: string[], closedAccounts: string[]) => {
    setRefreshingWallet(true);
    setView({ state: 'confirmed', sessionId, signatures });
    try {
      let discovery: ClaimDiscoveryResult | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await api<ClaimDiscoveryResult>('/api/claim/discover', { sessionId, walletAddress });
        if (discoveryReflectsClaimSettlement(current, closedAccounts)) { discovery = current; break; }
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
      }
      if (!discovery) throw new Error('Wallet state is still updating.');
      setView({ state: discovery.eligibleAccounts.length ? 'results' : 'empty', sessionId, discovery, signatures });
    } catch {
      setView({ state: 'results', sessionId, signatures, error: 'Claim completed, but the wallet view is still updating. Select SCAN AGAIN to refresh it safely.' });
    } finally {
      setRefreshingWallet(false);
    }
  };

  const scan = async () => {
    if (!wallet.account) return onConnect();
    try {
      setView({ state: 'scanning' });
      const session = await api<{ sessionId: string }>('/api/session', { walletAddress: wallet.account.address, network: appNetwork });
      const pendingQuoteId = readPendingClaim(wallet.account.address);
      if (pendingQuoteId) {
        const prior = await api<{ status: 'confirmed' | 'failed' | 'pending' | 'not_submitted'; signature?: string }>('/api/claim/status', { sessionId: session.sessionId, walletAddress: wallet.account.address, quoteId: pendingQuoteId });
        if (prior.status === 'confirmed') {
          const signatures = prior.signature ? [prior.signature] : [];
          forgetPendingClaim(wallet.account.address);
          showSuccess(signatures);
          await refreshAfterSuccess(session.sessionId, wallet.account.address, signatures, []);
          return;
        }
        if (prior.status === 'pending') return setView({ state: 'pending', sessionId: session.sessionId, quoteId: pendingQuoteId, signatures: prior.signature ? [prior.signature] : [], error: 'This Claim was submitted and is still being verified. No second transaction will be sent.' });
        forgetPendingClaim(wallet.account.address);
        if (prior.status === 'failed') return setView({ state: 'failure', sessionId: session.sessionId, quoteId: pendingQuoteId, error: 'This Claim did not complete on-chain. Nothing was moved.' });
      }
      const discovery = await api<ClaimDiscoveryResult>('/api/claim/discover', { sessionId: session.sessionId, walletAddress: wallet.account.address });
      if (!discovery.eligibleAccounts.length) return setView({ state: 'empty', sessionId: session.sessionId, discovery });
      const quote = await api<{ quoteId: string; claim: ClaimQuoteDetails }>('/api/claim/quote', { sessionId: session.sessionId, walletAddress: wallet.account.address, clientRequestId: crypto.randomUUID() });
      setView({ state: 'review', sessionId: session.sessionId, quoteId: quote.quoteId, discovery, claim: quote.claim });
    } catch (error) { setView({ state: 'failure', error: error instanceof Error ? error.message : 'Claim SOL is temporarily unavailable.' }); }
  };

  useEffect(() => {
    successFeedback.current = createSwapSuccessFeedbackLifecycle({ schedule: (callback, delayMs) => window.setTimeout(callback, delayMs), cancel: (timer) => window.clearTimeout(timer as number), showToast: setSuccessToast, showConfetti: setConfettiCount });
    return () => { successFeedback.current?.dispose(); successFeedback.current = null; };
  }, []);

  useEffect(() => {
    successFeedback.current?.clear();
    setLastConfirmedSignatures([]);
    setCompletedAccountCount(0);
    if (!connected || !wallet.account) { setView({ state: 'disconnected' }); return; }
    void scan();
    // A public-address change is the only wallet event that should restart discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, wallet.account?.address]);

  const submitClaim = async () => {
    if (signingLocked.current || !wallet.account || !view.sessionId || !view.quoteId || !view.claim) return;
    signingLocked.current = true;
    const sessionId = view.sessionId; const quoteId = view.quoteId; const walletAddress = wallet.account.address;
    const signatures: string[] = [];
    let closedAccounts: string[] = [];
    let preparedForWallet = false; let walletOpened = false;
    try {
      const prepared = await api<{ claim: ClaimQuoteDetails }>('/api/claim/prepare', { sessionId, walletAddress, quoteId });
      closedAccounts = prepared.claim.batches.flatMap((batch) => batch.accounts.map((account) => account.address));
      const responseReceivedAt = Date.now();
      preparedForWallet = true;
      for (const batch of prepared.claim.batches) {
        if (!batch.prepared) throw new Error('Claim preparation expired. Review the Claim again.');
        const { blockHeight } = await api<{ blockHeight: number }>('/api/claim/blockheight', { sessionId, walletAddress, quoteId });
        const gate = walletGateForPreparedTransaction(batch.prepared, responseReceivedAt, Date.now(), blockHeight);
        if (!gate.allowed) {
          await api('/api/claim/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: gate.reason }).catch(() => undefined);
          preparedForWallet = false;
          throw new Error('Claim preparation expired before wallet approval. Review the Claim again.');
        }
        if (liveWalletAddress.current !== walletAddress) {
          await api('/api/claim/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'wallet_account_changed' }).catch(() => undefined);
          preparedForWallet = false;
          throw new Error('The connected wallet changed. Review the Claim again.');
        }
        setView((current) => ({ ...current, state: 'awaiting-signature' }));
        walletOpened = true; preparedForWallet = false;
        const invokedAt = new Date().toISOString();
        const approvalPromise = awaitWalletApproval({ sign: () => wallet.signTransaction(decodeBase64(batch.prepared!.serializedTransaction)), getBlockHeight: async () => (await api<{ blockHeight: number }>('/api/claim/wallet-blockheight', { sessionId, walletAddress, quoteId })).blockHeight, lastValidBlockHeight: batch.prepared.lastValidBlockHeight });
        await api('/api/claim/wallet-event', { sessionId, walletAddress, quoteId, event: 'invoked', metadata: { clientInvokedAt: invokedAt } }).catch(() => undefined);
        const approval = await approvalPromise;
        if (approval.status === 'failed') {
          await api('/api/claim/wallet-event', { sessionId, walletAddress, quoteId, event: 'failed', metadata: { classification: approval.classification, elapsedMs: approval.elapsedMs } }).catch(() => undefined);
          await api('/api/claim/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: false }).catch(() => undefined);
          throw new Error(approval.classification === 'USER_EXPLICITLY_CANCELLED' ? 'Claim approval was cancelled. Nothing was submitted.' : 'The wallet could not approve this Claim. Nothing was submitted.');
        }
        if (approval.status === 'expired') {
          await api('/api/claim/wallet-event', { sessionId, walletAddress, quoteId, event: 'expired', metadata: { classification: approval.classification, elapsedMs: approval.elapsedMs, userSignatureReturned: approval.userSignatureReturned, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks } }).catch(() => undefined);
          await api('/api/claim/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: approval.userSignatureReturned }).catch(() => undefined);
          throw new Error('Claim preparation expired while your wallet was open. Nothing was submitted.');
        }
        if (liveWalletAddress.current !== walletAddress) {
          await api('/api/claim/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: 'WALLET_ACCOUNT_CHANGED', userSignatureReturned: true }).catch(() => undefined);
          throw new Error('The connected wallet changed. Nothing was submitted.');
        }
        await api('/api/claim/wallet-event', { sessionId, walletAddress, quoteId, event: 'returned', metadata: { elapsedMs: approval.elapsedMs, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks, userSignatureReturned: true } }).catch(() => undefined);
        setView((current) => ({ ...current, state: 'submitting' }));
        rememberPendingClaim(walletAddress, quoteId);
        const result = await api<{ signature: string; reconciliation: { status: string } }>('/api/claim/submit', { sessionId, walletAddress, quoteId, batchIndex: batch.batchIndex, signedTransaction: encodeBase64(approval.signedTransaction), clientRequestId: crypto.randomUUID() });
        if (result.reconciliation.status !== 'confirmed') throw new Error('This Claim was submitted but its final result is still being verified.');
        signatures.push(result.signature);
      }
      forgetPendingClaim(walletAddress);
      showSuccess(signatures, closedAccounts.length);
      await refreshAfterSuccess(sessionId, walletAddress, signatures, closedAccounts);
    } catch (error) {
      if (preparedForWallet && !walletOpened) await api('/api/claim/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'final_gate_unavailable' }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "This claim couldn't be safely completed. Nothing was submitted.";
      const code = (error as Error & { code?: string }).code;
      setView((current) => ({ ...current, state: code === 'RECONCILIATION_FAILED' ? 'pending' : /reject|cancel/i.test(message) ? 'rejected' : 'failure', error: message, signatures }));
    } finally {
      signingLocked.current = false;
    }
  };

  const claimBusy = ['scanning', 'awaiting-signature', 'submitting'].includes(view.state) || refreshingWallet;
  const eligibleCount = view.discovery?.eligibleAccounts.length ?? 0;
  const nonemptyCount = nonemptySkippedAccountCount(view.discovery);
  const approvals = view.claim?.batches.length ?? 0;
  const displayedRecoverable = view.state === 'empty' || view.state === 'confirmed' ? '0' : view.claim?.grossRecoveredLamports;
  const transactionSignatures = view.signatures?.length ? view.signatures : lastConfirmedSignatures;
  const claimButton = !connected ? 'CONNECT WALLET' : view.state === 'scanning' ? 'SCANNING WALLET…' : view.state === 'review' ? `CLAIM SOL${approvals > 1 ? ` · ${approvals} APPROVALS` : ''}` : view.state === 'awaiting-signature' ? 'APPROVE IN WALLET' : view.state === 'submitting' ? `CONFIRMING ON ${appNetworkLabel}…` : view.state === 'pending' ? 'CHECK CLAIM STATUS' : refreshingWallet ? 'REFRESHING WALLET…' : view.state === 'confirmed' ? 'CLAIM COMPLETE' : view.state === 'empty' ? 'NO SOL TO CLAIM' : 'SCAN AGAIN';

  return <div className="feature-body claim-body">
    {confettiCount > 0 && <div className="swap-confetti" aria-hidden="true">{Array.from({ length: confettiCount }, (_, index) => <i key={index} style={particleStyle(index)} />)}</div>}
    {successToast && <div className="swap-success-toast" role="status">Claim complete · <a href={explorerTransactionUrl(successToast)} target="_blank" rel="noreferrer">View transaction</a></div>}
    <div className="clean-mode-selector" role="tablist" aria-label="CLEAN mode">
      {MODES.map((item) => <button key={item.id} id={`clean-tab-${item.id}`} type="button" role="tab" aria-selected={mode === item.id} aria-controls={`clean-panel-${item.id}`} className={mode === item.id ? 'is-active' : ''} onClick={() => setMode(item.id)}>{item.label}</button>)}
    </div>

    {mode === 'claim' && <div id="clean-panel-claim" role="tabpanel" aria-labelledby="clean-tab-claim" className="clean-mode-panel">
      <div className="console-lead"><span className="eyebrow">CLEAN / CLAIM SOL</span><h3>{view.state === 'confirmed' ? 'Claim complete.' : view.state === 'pending' ? 'Claim submitted.' : 'Recover SOL held by unused token accounts.'}</h3><p>{view.state === 'empty' ? 'No empty token accounts are ready to clean.' : view.state === 'confirmed' ? (completedAccountCount ? `${completedAccountCount} account${completedAccountCount === 1 ? '' : 's'} cleaned successfully. Refreshing your wallet now.` : 'The submitted Claim was reconciled successfully. Refreshing your wallet now.') : view.state === 'pending' ? 'GASLESS is checking the existing signature. It will not create or submit another transaction.' : 'Eligible empty accounts are found automatically and checked again before submission.'}</p></div>
      <div className="summary-line"><span>ACCOUNTS READY TO CLEAN</span><strong>{connected ? (view.state === 'scanning' ? 'SCANNING' : eligibleCount) : 'WALLET REQUIRED'}</strong></div>
      <div className="summary-line"><span>RECOVERABLE SOL</span><strong>{formatLamports(displayedRecoverable)}</strong></div>
      <GaslessStatus connected={connected} />
      <div className="receive-line"><span>YOU RECEIVE</span><strong>{formatLamports(view.state === 'empty' || view.state === 'confirmed' ? '0' : view.claim?.netUserLamports)}</strong></div>
      <button className="console-primary" type="button" onClick={!connected ? onConnect : view.state === 'review' ? () => void submitClaim() : () => void scan()} disabled={claimBusy || view.state === 'confirmed' || view.state === 'empty'}>{claimButton}</button>
      {view.state === 'empty' && <button className="claim-rescan" type="button" onClick={() => void scan()}>SCAN AGAIN</button>}
      {view.error && <p className="connection-message" role="alert">{view.error}</p>}
      {nonemptyCount > 0 && <p>{nonemptyCount} token account{nonemptyCount === 1 ? " isn't" : "s aren't"} empty and will remain untouched.</p>}
      {transactionSignatures.map((signature, index) => <a key={signature} href={explorerTransactionUrl(signature)} target="_blank" rel="noreferrer">VIEW TRANSACTION{transactionSignatures.length > 1 ? ` ${index + 1}` : ''}</a>)}
      <DetailSection><DetailRow label="Accounts selected" value={view.claim ? String(eligibleCount) : view.state === 'empty' ? '0' : '—'} /><DetailRow label="Wallet SOL balance" value={formatLamports(view.discovery?.walletBalanceLamports)} /><DetailRow label="Gross SOL recovered" value={formatLamports(view.claim?.grossRecoveredLamports)} /><DetailRow label="GASLESS service fee (3%)" value={formatLamports(view.claim?.gaslessFeeLamports)} /><DetailRow label="Sponsored network cost" value={formatLamports(view.claim?.sponsoredCostLamports)} /><DetailRow label="Final SOL received" value={formatLamports(view.claim?.netUserLamports)} /><p>{view.claim ? `${approvals} transaction${approvals === 1 ? '' : 's'} prepared. The account closures and disclosed costs settle atomically in each transaction.` : 'Eligible accounts, exact costs, and the final amount appear here before you sign.'}</p></DetailSection>
    </div>}

    {mode === 'recover' && <RecoverConsole connected={connected} onConnect={onConnect} />}

    {mode === 'burn' && <BurnConsole connected={connected} onConnect={onConnect} />}
  </div>;
}
