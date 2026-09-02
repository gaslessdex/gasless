import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { SendDiscoveryResult, SendQuoteDetails, SendToken } from '../../../../shared/transactions/types';
import { AccountSetupNotice } from '../../../components/ui/AccountSetupNotice';
import { claimAccountSetupNotice } from '../../../components/ui/accountSetupNoticeState';
import { DetailRow, DetailSection, FieldError, GaslessStatus, TokenSelector, type TokenOption } from '../../../components/ui/TransactionControls';
import { financialTokenSelectionLocked } from '../../../components/ui/financialControlState';
import { useWallet } from '../../../wallet/walletContext';
import { appNetwork, appNetworkLabel, explorerTransactionUrl } from '../../../config/network';
import { confettiParticleCount, createSwapSuccessFeedbackLifecycle } from '../../swap/quoteLifecycle';
import { discoveryReflectsSendSettlement, quoteIdForSendPrepare, shouldAcceptSendPreview, shouldReturnSendToReview, walletGateForSend } from '../lifecycle';
import { sendErrorMessage } from '../errors';
import { awaitSendWalletApproval } from '../walletApproval';

export type SendState = 'disconnected' | 'loading' | 'empty' | 'entry' | 'checking' | 'review' | 'preparing' | 'awaiting-signature' | 'submitting' | 'confirmed' | 'stale' | 'failure';
type View = { state: SendState; sessionId?: string; discovery?: SendDiscoveryResult; quoteId?: string; expiresAt?: string; send?: SendQuoteDetails; signature?: string; error?: string };

type ApiTiming = { responseReceivedAt?: number; responseParsedAt?: number; responseEnqueuedAt?: string };
async function api<T>(path: string, payload: Record<string, unknown>, signal?: AbortSignal, timing?: ApiTiming): Promise<T> { const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload), signal }); if (timing) { timing.responseReceivedAt = Date.now(); timing.responseEnqueuedAt = response.headers.get('X-Gasless-Send-Response-Enqueued-At') ?? undefined; window.performance?.mark('gasless-send:T2-prepare-response'); } const value = await response.json() as T & { error?: { code?: string; message?: string } }; if (timing) { timing.responseParsedAt = Date.now(); window.performance?.mark('gasless-send:T3-response-parsed'); } if (!response.ok) { const error = new Error(value.error?.message ?? 'Gasless Send is temporarily unavailable.') as Error & { code?: string }; error.code = value.error?.code; throw error; } return value; }
function markSendTimeline(stage: string) { window.performance?.mark(`gasless-send:${stage}`); return Date.now(); }
function display(raw?: string, decimals = 0) { if (raw === undefined) return '—'; if (!decimals) return raw; const padded = raw.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
function decode(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encode(value: Uint8Array) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }
function particleStyle(index: number): CSSProperties { const unit = (salt: number) => { const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453; return value - Math.floor(value); }; const origin = 20 + ((unit(1) + unit(2)) / 2) * 60; const horizontal = (unit(3) - .5) * 70; const rise = 38 + unit(4) * 22; const rotation = (unit(5) > .5 ? 1 : -1) * (240 + unit(6) * 600); return { '--origin': `${origin.toFixed(2)}%`, '--horizontal': `${horizontal.toFixed(2)}vw`, '--rise': `${rise.toFixed(2)}vh`, '--size': `${4 + Math.floor(unit(7) * 5)}px`, '--delay': `${Math.floor(unit(8) * 240)}ms`, '--duration': `${2200 + Math.floor(unit(9) * 600)}ms`, '--rotation': `${rotation.toFixed(0)}deg` } as CSSProperties; }

export function SendConsole({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const wallet = useWallet(); const [view, setView] = useState<View>({ state: connected ? 'loading' : 'disconnected' }); const [token, setToken] = useState<SendToken>(); const [amount, setAmount] = useState(''); const [recipient, setRecipient] = useState(''); const [max, setMax] = useState(false);
  const [sessionGeneration, setSessionGeneration] = useState(0); const [successToast, setSuccessToast] = useState<string>(); const [confettiCount, setConfettiCount] = useState(0); const [balancesRefreshing, setBalancesRefreshing] = useState(false); const [balanceRefreshFailed, setBalanceRefreshFailed] = useState(false);
  const [accountNotice, setAccountNotice] = useState<string>(); const seenAccountNotices = useRef(new Set<string>());
  const signingLocked = useRef(false); const preparing = useRef(false); const previewGeneration = useRef(0); const previewRequest = useRef<AbortController | null>(null); const successFeedback = useRef<ReturnType<typeof createSwapSuccessFeedbackLifecycle> | null>(null);
  const liveWalletAddress = useRef(wallet.account?.address); liveWalletAddress.current = wallet.account?.address;
  const tokens = useMemo<TokenOption[]>(() => (view.discovery?.tokens ?? []).map((item) => ({ id: item.sourceAccount, mint: item.mint, program: item.tokenProgram, symbol: item.symbol, name: 'Approved token', balance: display(item.balanceRaw, item.decimals), eligible: true })), [view.discovery]);
  const selectedToken = token ? tokens.find((item) => item.mint === token.mint) ?? null : null;
  const amountError = useMemo(() => !max && amount && (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) ? 'Enter an amount greater than zero.' : '', [amount, max]);
  const recipientError = useMemo(() => recipient && (recipient.length < 32 || recipient.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(recipient)) ? 'Enter a valid Solana wallet address.' : '', [recipient]);

  const clearSuccessFeedback = useCallback(() => { successFeedback.current?.clear(); setSuccessToast(undefined); setConfettiCount(0); }, []);
  const scan = async () => { if (!wallet.account) return onConnect(); try { setBalancesRefreshing(false); setBalanceRefreshFailed(false); setView({ state: 'loading' }); const session = await api<{ sessionId: string }>('/api/session', { walletAddress: wallet.account.address, network: appNetwork }); const discovery = await api<SendDiscoveryResult>('/api/send/discover', { sessionId: session.sessionId, walletAddress: wallet.account.address }); setView({ state: discovery.tokens.length ? 'entry' : 'empty', sessionId: session.sessionId, discovery }); } catch (error) { setView({ state: 'failure', error: error instanceof Error ? error.message : 'Gasless Send is temporarily unavailable.' }); } };
  useEffect(() => { successFeedback.current = createSwapSuccessFeedbackLifecycle({ schedule: (callback, delayMs) => window.setTimeout(callback, delayMs), cancel: (timer) => window.clearTimeout(timer as number), showToast: setSuccessToast, showConfetti: setConfettiCount }); return () => { successFeedback.current?.dispose(); successFeedback.current = null; }; }, []);
  useEffect(() => { if (!connected || !wallet.account) setView({ state: 'disconnected' }); else void scan();
    // A public-address change is the only wallet event that should restart discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionGeneration, wallet.account?.address]);
  useEffect(() => { if (view.state !== 'confirmed' || !view.signature) return; successFeedback.current?.show(view.signature, confettiParticleCount(window.innerWidth, window.matchMedia('(prefers-reduced-motion: reduce)').matches)); }, [view.signature, view.state]);
  useEffect(() => { const key = view.sessionId && view.quoteId && view.send ? `send:${view.sessionId}:${view.quoteId}` : undefined; if (claimAccountSetupNotice(seenAccountNotices.current, key, view.send?.recipientAtaExists)) setAccountNotice(view.send!.token.symbol); }, [view.quoteId, view.send, view.sessionId]);

  const invalidatePreview = () => { previewGeneration.current += 1; previewRequest.current?.abort(); previewRequest.current = null; setView((current) => ({ ...current, state: 'entry', quoteId: undefined, expiresAt: undefined, send: undefined, error: undefined })); };
  const preview = async () => {
    if (signingLocked.current || preparing.current || !wallet.account || !view.sessionId || !token || !recipient || (!max && (!amount || amountError)) || recipientError) return;
    const generation = ++previewGeneration.current;
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    try {
      setView((current) => ({ ...current, state: 'checking', send: undefined, quoteId: undefined, expiresAt: undefined, error: undefined }));
      const quote = await api<{ quoteId: string; expiresAt: string; send: SendQuoteDetails }>('/api/send/quote', { sessionId: view.sessionId, walletAddress: wallet.account.address, mint: token.mint, recipient, amount, max, clientRequestId: crypto.randomUUID() }, controller.signal);
      if (!shouldAcceptSendPreview(previewGeneration.current, generation, signingLocked.current)) return;
      setView((current) => ({ ...current, state: 'review', quoteId: quote.quoteId, expiresAt: quote.expiresAt, send: quote.send }));
    } catch (error) {
      if (controller.signal.aborted || !shouldAcceptSendPreview(previewGeneration.current, generation, signingLocked.current)) return;
      const code = (error as Error & { code?: string }).code;
      setView((current) => ({ ...current, state: shouldReturnSendToReview(code) ? 'stale' : 'failure', error: sendErrorMessage(error instanceof Error ? error as Error & { code?: string } : {}, 'review') }));
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
    }
  };
  const refreshBalanceAfterSuccess = async (sessionId: string, walletAddress: string, selected: SendToken) => { setBalancesRefreshing(true); setBalanceRefreshFailed(false); try { let discovery: SendDiscoveryResult | undefined; for (let attempt = 0; attempt < 4; attempt += 1) { const current = await api<SendDiscoveryResult>('/api/send/discover', { sessionId, walletAddress }); if (discoveryReflectsSendSettlement(current, selected.mint, selected.balanceRaw)) { discovery = current; break; } if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1))); } if (!discovery) throw new Error('Wallet balance is still updating.'); setView((current) => ({ ...current, discovery })); setToken(discovery.tokens.find((item) => item.mint === selected.mint)); } catch { setBalanceRefreshFailed(true); } finally { setBalancesRefreshing(false); } };
  const submit = async () => {
    markSendTimeline('T0-click');
    const quoteId = quoteIdForSendPrepare(view.state, view.quoteId, view.expiresAt);
    if (signingLocked.current || preparing.current || !wallet.account || !view.sessionId || !quoteId || !token) {
      if (view.state === 'review' && !quoteId) setView((current) => ({ ...current, state: 'stale', error: 'Send preview expired. Review the updated costs and try again.' }));
      return;
    }
    const sessionId = view.sessionId; const walletAddress = wallet.account.address; const selected = token;
    preparing.current = true; signingLocked.current = true; previewGeneration.current += 1; previewRequest.current?.abort(); previewRequest.current = null; clearSuccessFeedback();
    setAccountNotice(undefined);
    let walletOpened = false; let walletSigned = false; let preparedForWallet = false;
    try {
      setView((current) => ({ ...current, state: 'preparing', error: undefined }));
      const timing: ApiTiming = {}; markSendTimeline('T1-prepare-request');
      const prepared = await api<{ send: SendQuoteDetails }>('/api/send/prepare', { sessionId, walletAddress, quoteId }, undefined, timing);
      preparedForWallet = true;
      const parsedAt = timing.responseParsedAt ?? Date.now();
      const preparedTransaction = prepared.send.prepared;
      if (!preparedTransaction) { try { await api('/api/send/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'invalid_preparation' }); } catch { /* The server-side expiry still bounds exposure. */ } setView((current) => ({ ...current, state: 'stale', error: 'Send preparation could not be verified. Review the Send and try again.' })); return; }
      markSendTimeline('T4-blockheight-request');
      const { blockHeight } = await api<{ blockHeight: number }>('/api/send/blockheight', { sessionId, walletAddress, quoteId });
      markSendTimeline('T5-blockheight-response');
      const gate = walletGateForSend(preparedTransaction, parsedAt, markSendTimeline('T6-wallet-gate'), blockHeight);
      if (!gate.allowed) {
        try { await api('/api/send/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: gate.reason }); } catch { /* The server-side expiry and reservation window still bound exposure. */ }
        const error = gate.reason === 'blockhash_margin' ? 'Send blockhash is no longer safe. Review the updated costs and try again.' : gate.reason === 'invalid_preparation' ? 'Send preparation could not be verified. Review the Send and try again.' : 'Send preparation expired before wallet approval. Review the updated costs and try again.';
        setView((current) => ({ ...current, state: 'stale', error }));
        return;
      }
      markSendTimeline('T7-live-wallet-reread');
      if (liveWalletAddress.current !== walletAddress) {
        try { await api('/api/send/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'wallet_account_changed' }); } catch { /* The server-side expiry still bounds exposure. */ }
        setView((current) => ({ ...current, state: 'failure', error: sendErrorMessage({ code: 'WALLET_ACCOUNT_CHANGED' }, 'wallet') }));
        return;
      }
      setView((current) => ({ ...current, state: 'awaiting-signature', send: prepared.send }));
      walletOpened = true; preparedForWallet = false;
      const invokedAt = new Date(markSendTimeline('T8-wallet-invocation')).toISOString();
      const approvalPromise = awaitSendWalletApproval({
        sign: () => wallet.signTransaction(decode(preparedTransaction.serializedTransaction)),
        getBlockHeight: async () => (await api<{ blockHeight: number }>('/api/send/wallet-blockheight', { sessionId, walletAddress, quoteId })).blockHeight,
        lastValidBlockHeight: preparedTransaction.lastValidBlockHeight,
      });
      try { await api('/api/send/wallet-event', { sessionId, walletAddress, quoteId, event: 'invoked', metadata: { clientInvokedAt: invokedAt } }); } catch { /* Telemetry must not interrupt an already-open wallet request. */ }
      const approval = await approvalPromise;
      const clientWalletResponseAt = new Date().toISOString();
      if (approval.status === 'failed') {
        const details = approval.error && typeof approval.error === 'object' ? approval.error as Record<string, unknown> : {};
        try { await api('/api/send/wallet-event', { sessionId, walletAddress, quoteId, event: 'failed', metadata: { classification: approval.classification, clientWalletResponseAt, elapsedMs: approval.elapsedMs, providerCode: details.providerCode, providerName: details.providerName, providerMessage: details.providerMessage, mutationDiagnostics: details.mutationDiagnostics } }); } catch { /* Failure terminalization remains authoritative. */ }
        try { await api('/api/send/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: false }); } catch { /* The reservation TTL still bounds exposure. */ }
        setView((current) => ({ ...current, state: approval.classification === 'USER_EXPLICITLY_CANCELLED' ? 'stale' : 'failure', error: sendErrorMessage({ code: approval.classification }, 'wallet') }));
        return;
      }
      if (approval.status === 'expired') {
        try { await api('/api/send/wallet-event', { sessionId, walletAddress, quoteId, event: 'expired', metadata: { classification: approval.classification, clientWalletResponseAt, elapsedMs: approval.elapsedMs, userSignatureReturned: approval.userSignatureReturned, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks } }); } catch { /* Failure terminalization remains authoritative. */ }
        try { await api('/api/send/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: approval.classification, userSignatureReturned: approval.userSignatureReturned }); } catch { /* The reservation TTL still bounds exposure. */ }
        setView((current) => ({ ...current, state: 'stale', error: sendErrorMessage({ code: approval.classification }, 'wallet') }));
        return;
      }
      walletSigned = true;
      if (liveWalletAddress.current !== walletAddress) {
        try { await api('/api/send/wallet-event', { sessionId, walletAddress, quoteId, event: 'failed', metadata: { classification: 'WALLET_ACCOUNT_CHANGED', elapsedMs: approval.elapsedMs, userSignatureReturned: true } }); } catch { /* Failure terminalization remains authoritative. */ }
        try { await api('/api/send/abort-wallet-approval', { sessionId, walletAddress, quoteId, reason: 'WALLET_ACCOUNT_CHANGED', userSignatureReturned: true }); } catch { /* The reservation TTL still bounds exposure. */ }
        setView((current) => ({ ...current, state: 'failure', error: sendErrorMessage({ code: 'WALLET_ACCOUNT_CHANGED' }, 'wallet') }));
        return;
      }
      try { await api('/api/send/wallet-event', { sessionId, walletAddress, quoteId, event: 'returned', metadata: { clientWalletResponseAt, elapsedMs: approval.elapsedMs, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks, userSignatureReturned: true } }); } catch { /* Telemetry must not block an otherwise safe signed return. */ }
      setView((current) => ({ ...current, state: 'submitting' }));
      const result = await api<{ signature: string; reconciliation: { status: string } }>('/api/send/submit', { sessionId, walletAddress, quoteId, signedTransaction: encode(approval.signedTransaction), clientRequestId: crypto.randomUUID() });
      setView((current) => ({ ...current, state: result.reconciliation.status === 'confirmed' ? 'confirmed' : 'failure', signature: result.signature }));
      if (result.reconciliation.status === 'confirmed') await refreshBalanceAfterSuccess(sessionId, walletAddress, selected);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (preparedForWallet) { try { await api('/api/send/abort-wallet-gate', { sessionId, walletAddress, quoteId, reason: 'final_gate_unavailable' }); } catch { /* The server-side expiry still bounds exposure. */ } }
      setView((current) => ({ ...current, state: shouldReturnSendToReview(code) ? 'stale' : 'failure', error: sendErrorMessage(error instanceof Error ? error as Error & { code?: string } : {}, walletOpened && !walletSigned ? 'wallet' : walletSigned ? 'submit' : 'prepare') }));
    } finally {
      preparing.current = false; signingLocked.current = false;
    }
  };
  const sendAgain = () => { clearSuccessFeedback(); setBalancesRefreshing(false); setBalanceRefreshFailed(false); setAmount(''); setRecipient(''); setMax(false); setToken(undefined); setAccountNotice(undefined); setView({ state: 'loading' }); setSessionGeneration((value) => value + 1); };

  const busy = ['loading', 'checking', 'preparing', 'awaiting-signature', 'submitting'].includes(view.state) || balancesRefreshing; const selectorLocked = financialTokenSelectionLocked(view.state); const quoted = view.send; const symbol = quoted?.token.symbol ?? token?.symbol ?? ''; const button = !connected ? 'CONNECT WALLET' : view.state === 'loading' ? 'LOADING TOKENS…' : view.state === 'checking' ? 'CALCULATING PREVIEW…' : view.state === 'preparing' ? 'PREPARING TRANSACTION…' : view.state === 'review' ? 'SIGN & SEND' : view.state === 'awaiting-signature' ? 'APPROVE IN WALLET' : view.state === 'submitting' ? `CONFIRMING ON ${appNetworkLabel}…` : view.state === 'confirmed' ? 'SEND AGAIN' : view.state === 'empty' ? 'NO ELIGIBLE TOKENS' : 'REVIEW SEND';
  return <div className="feature-body send-body">
    <div className="transaction-field"><div className="field-heading"><span>TOKEN</span><span>{token ? `BALANCE ${display(token.balanceRaw, token.decimals)}` : 'APPROVED TOKENS'}</span></div><TokenSelector label="Token to send" value={selectedToken} tokens={tokens} disabled={selectorLocked} onChange={(option) => { const selected = view.discovery?.tokens.find((item) => item.mint === option.mint); setAccountNotice(undefined); setToken(selected); setMax(false); invalidatePreview(); }} /></div>
    <div className="transaction-field"><div className="field-heading"><label htmlFor="send-amount">AMOUNT</label><span>RECIPIENT AMOUNT</span></div><div className="amount-row"><input id="send-amount" inputMode="decimal" value={max && quoted ? display(quoted.recipientAmountRaw, quoted.token.decimals) : amount} disabled={busy} onChange={(event) => { setAccountNotice(undefined); setAmount(event.target.value); setMax(false); invalidatePreview(); }} placeholder="0.00" aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'send-amount-error' : undefined} /><button type="button" disabled={!token?.balanceRaw || busy} onClick={() => { setAccountNotice(undefined); setMax(true); setAmount(''); invalidatePreview(); }}>MAX</button></div><FieldError id="send-amount-error">{amountError}</FieldError></div>
    <label className="recipient-field" htmlFor="send-recipient"><span>RECIPIENT WALLET</span><input id="send-recipient" value={recipient} disabled={busy} onChange={(event) => { setAccountNotice(undefined); setRecipient(event.target.value.trim()); invalidatePreview(); }} placeholder="Solana wallet address" autoComplete="off" spellCheck={false} aria-invalid={Boolean(recipientError)} aria-describedby={recipientError ? 'send-recipient-error' : undefined} /></label><FieldError id="send-recipient-error">{recipientError}</FieldError>
    <GaslessStatus connected={connected} /><div className="summary-line"><span>RECIPIENT RECEIVES</span><strong>{quoted ? `${display(quoted.recipientAmountRaw, quoted.token.decimals)} ${symbol}` : max ? `MAX ${symbol}` : amount && !amountError ? `${amount} ${symbol}` : '—'}</strong></div>
    {quoted?.recipientAtaExists && <p className="connection-message" role="status">The recipient token account is ready.</p>}
    {accountNotice && <AccountSetupNotice tokenSymbol={accountNotice} recipient onDismiss={() => setAccountNotice(undefined)} />}
    <button className="console-primary" type="button" onClick={!connected ? onConnect : view.state === 'confirmed' ? sendAgain : view.state === 'review' ? () => void submit() : () => void preview()} disabled={busy || view.state === 'empty' || (connected && view.state !== 'confirmed' && (!token || !recipient || Boolean(recipientError) || (!max && (!amount || Boolean(amountError)))))}>{button}</button>
    {view.state === 'empty' && <p className="connection-message" role="status">No approved Send tokens are available in this wallet.</p>}{view.error && <p className="connection-message" role="alert">{view.error}</p>}
    {balanceRefreshFailed && <p className="connection-message" role="status">Wallet balance is still updating. Select SEND AGAIN to rescan before continuing.</p>}
    <DetailSection><DetailRow label="You send" value={quoted ? `${display(quoted.recipientAmountRaw, quoted.token.decimals)} ${symbol}` : '—'} /><DetailRow label="Recipient receives" value={quoted ? `${display(quoted.recipientAmountRaw, quoted.token.decimals)} ${symbol}` : '—'} /><DetailRow label="Network cost" value={quoted ? `${display(quoted.sponsorReimbursementRaw, quoted.token.decimals)} ${symbol}` : '—'} /><DetailRow label="GASLESS fee (0.10%, max $1)" value={quoted ? `${display(quoted.serviceFeeRaw, quoted.token.decimals)} ${symbol}` : '—'} /><DetailRow label="Total from wallet" value={quoted ? `${display(quoted.totalDebitRaw, quoted.token.decimals)} ${symbol}` : '—'} /><p>The recipient amount, sponsored network cost, and GASLESS fee settle atomically. SOL needed from you: 0.</p></DetailSection>
    {confettiCount > 0 && <div className="swap-confetti" aria-hidden="true">{Array.from({ length: confettiCount }, (_, index) => <i key={index} style={particleStyle(index)} />)}</div>}
    {successToast && <div className="swap-success-toast" role="status">Send complete · <a href={explorerTransactionUrl(successToast)} target="_blank" rel="noreferrer">View transaction</a></div>}
  </div>;
}
