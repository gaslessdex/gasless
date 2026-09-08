import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { SwapDiscoveryResult, SwapQuoteDetails, SwapToken } from '../../../../shared/transactions/types';
import { AccountSetupNotice } from '../../../components/ui/AccountSetupNotice';
import { claimAccountSetupNotice } from '../../../components/ui/accountSetupNoticeState';
import { ChoiceSelect, DetailRow, DetailSection, FieldError, TokenSelector, type TokenOption } from '../../../components/ui/TransactionControls';
import { financialTokenSelectionLocked } from '../../../components/ui/financialControlState';
import { appNetwork, explorerTransactionUrl } from '../../../config/network';
import { useWallet } from '../../../wallet/walletContext';
import { canOpenWalletForSwap, canSubmitSignedSwap, confettiParticleCount, createSwapSuccessFeedbackLifecycle, discoveryReflectsSwapSettlement, quoteIdForPrepare, quoteRefreshDelay, shouldAcceptQuote, shouldRefreshQuoteAfterPrepareError, type SwapQuoteState } from '../quoteLifecycle';
import { useApplicationActivity } from '../../../activity/applicationActivityContext';
import { activityHeaders } from '../../../activity/activityState';
import { CrossChainPanel } from '../../cross-chain/CrossChainPanel';
import { scaledTokenAmountToUi } from '../../../utils/scaledTokenAmount';
import { swapInputTokenCatalog, swapOutputTokenCatalog, type SolanaCatalogToken } from '../../../config/solanaTokenCatalog';

export type SwapState = 'disconnected' | 'loading' | 'unavailable' | SwapQuoteState;
type View = { state: SwapState; sessionId?: string; discovery?: SwapDiscoveryResult; quoteId?: string; expiresAt?: string; swap?: SwapQuoteDetails; signature?: string; error?: string; notice?: string };
type QuoteResponse = { quoteId: string; expiresAt: string; swap: SwapQuoteDetails };

async function api<T>(path: string, payload: Record<string, unknown>, activity: 'active' | 'idle' | 'background', signal?: AbortSignal): Promise<T> { const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID(), ...activityHeaders(activity) }, body: JSON.stringify(payload), signal }); const value = await response.json() as T & { error?: { code?: string; message?: string } }; if (!response.ok) { const error = new Error(value.error?.message ?? 'GASLESS Swap is temporarily unavailable.') as Error & { code?: string }; error.code = value.error?.code; throw error; } return value; }
function display(raw?: string, decimals = 0, multiplier = 1) { if (raw === undefined) return '—'; if (multiplier !== 1) return scaledTokenAmountToUi(BigInt(raw), decimals, multiplier); if (!decimals) return raw; const padded = raw.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
function decode(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encode(value: Uint8Array) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }
function option(token: { mint: string; symbol: string; name?: string; image?: string; tokenProgram: string; balanceRaw?: string; decimals: number; uiMultiplier?: number }): TokenOption { return { id: token.mint, mint: token.mint, program: token.tokenProgram, symbol: token.symbol, name: token.name ?? 'Approved token', image: token.image, balance: token.balanceRaw === undefined ? undefined : display(token.balanceRaw, token.decimals, token.uiMultiplier), eligible: true }; }
function catalogSwapToken(token: SolanaCatalogToken, balanceRaw = '0'): SwapToken & { outputAtaExists?: boolean } { return { mint: token.mint, symbol: token.symbol, name: token.name, image: token.image, decimals: token.decimals, tokenProgram: token.tokenProgram, balanceRaw, sourceAccount: '', swapInputEnabled: swapInputTokenCatalog.some((item) => item.mint === token.mint), swapOutputEnabled: swapOutputTokenCatalog.some((item) => item.mint === token.mint) }; }
function amountExceedsBalance(value: string, token?: SwapToken) { if (!token || token.balanceRaw === undefined || (token.uiMultiplier ?? 1) !== 1 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false; const [whole, fraction = ''] = value.split('.'); if (fraction.length > token.decimals) return false; return BigInt(`${whole}${fraction.padEnd(token.decimals, '0')}`) > BigInt(token.balanceRaw); }
function particleStyle(index: number): CSSProperties { const unit = (salt: number) => { const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453; return value - Math.floor(value); }; const origin = 20 + ((unit(1) + unit(2)) / 2) * 60; const horizontal = (unit(3) - .5) * 70; const rise = 38 + unit(4) * 22; const rotation = (unit(5) > .5 ? 1 : -1) * (240 + unit(6) * 600); return { '--origin': `${origin.toFixed(2)}%`, '--horizontal': `${horizontal.toFixed(2)}vw`, '--rise': `${rise.toFixed(2)}vh`, '--size': `${4 + Math.floor(unit(7) * 5)}px`, '--delay': `${Math.floor(unit(8) * 240)}ms`, '--duration': `${2200 + Math.floor(unit(9) * 600)}ms`, '--rotation': `${rotation.toFixed(0)}deg` } as CSSProperties; }

function SolanaSwapPanel({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const wallet = useWallet();
  const activity = useApplicationActivity();
  const [view, setView] = useState<View>({ state: connected ? 'loading' : 'disconnected' });
  const [payToken, setPayToken] = useState<SwapToken>();
  const [receiveMint, setReceiveMint] = useState('');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [successToast, setSuccessToast] = useState<string>();
  const [confettiCount, setConfettiCount] = useState(0);
  const [balancesRefreshing, setBalancesRefreshing] = useState(false);
  const [balanceRefreshFailed, setBalanceRefreshFailed] = useState(false);
  const [accountNotice, setAccountNotice] = useState<string>();
  const generation = useRef(0);
  const successFeedback = useRef<ReturnType<typeof createSwapSuccessFeedbackLifecycle> | null>(null);
  const quoteRequest = useRef<AbortController | null>(null);
  const preparing = useRef(false);
  const signingLocked = useRef(false);
  const seenAccountNotices = useRef(new Set<string>());
  const outputs = useMemo(() => view.discovery?.outputTokens ?? [], [view.discovery]);
  const receiveToken = outputs.find((token) => token.mint === receiveMint) ?? (swapOutputTokenCatalog.find((token) => token.mint === receiveMint) ? catalogSwapToken(swapOutputTokenCatalog.find((token) => token.mint === receiveMint)!) : undefined);
  const inputOptions = useMemo(() => view.discovery ? view.discovery.inputTokens.map(option) : swapInputTokenCatalog.map((token) => option(catalogSwapToken(token))), [view.discovery]);
  const outputOptions = useMemo(() => view.discovery ? outputs.map(option) : swapOutputTokenCatalog.map((token) => option(catalogSwapToken(token))), [outputs, view.discovery]);
  const amountError = useMemo(() => amount && (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) ? 'Enter an amount greater than zero.' : amountExceedsBalance(amount, payToken) ? `You don't have enough ${payToken?.symbol ?? 'tokens'} for this swap.` : '', [amount, payToken]);
  const quoteInputValid = Boolean(wallet.account && view.sessionId && payToken && receiveToken && amount && !amountError && payToken.mint !== receiveToken.mint);

  const clearSuccessFeedback = useCallback(() => {
    successFeedback.current?.clear();
    setSuccessToast(undefined);
    setConfettiCount(0);
  }, []);

  const invalidate = useCallback(() => {
    clearSuccessFeedback();
    generation.current += 1;
    quoteRequest.current?.abort();
    setView((current) => ({ ...current, state: 'idle', quoteId: undefined, expiresAt: undefined, swap: undefined, error: undefined, notice: undefined }));
  }, [clearSuccessFeedback]);

  useEffect(() => {
    successFeedback.current = createSwapSuccessFeedbackLifecycle({
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timer) => window.clearTimeout(timer as number),
      showToast: setSuccessToast,
      showConfetti: setConfettiCount,
    });
    return () => { successFeedback.current?.dispose(); successFeedback.current = null; };
  }, []);

  useEffect(() => {
    const walletAddress = wallet.account?.address;
    clearSuccessFeedback();
    if (!connected || !walletAddress) { setView({ state: 'disconnected' }); return; }
    let cancelled = false;
    void (async () => {
      try {
        setBalancesRefreshing(false);
        setBalanceRefreshFailed(false);
        setView({ state: 'loading' });
        const session = await api<{ sessionId: string }>('/api/session', { walletAddress, network: appNetwork }, activity.state);
        const discovery = await api<SwapDiscoveryResult>('/api/swap/discover', { sessionId: session.sessionId, walletAddress }, activity.state);
        if (!cancelled) setView({ state: 'idle', sessionId: session.sessionId, discovery });
      } catch (error) {
        if (!cancelled) setView({ state: 'unavailable', error: error instanceof Error ? error.message : 'GASLESS Swap is temporarily unavailable.' });
      }
    })();
    return () => { cancelled = true; generation.current += 1; quoteRequest.current?.abort(); };
  // Activity changes must not restart wallet discovery; they only govern optional refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSuccessFeedback, connected, sessionGeneration, wallet.account?.address]);

  useEffect(() => {
    if (view.state !== 'confirmed' || !view.signature) return;
    successFeedback.current?.show(view.signature, confettiParticleCount(window.innerWidth, window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  }, [view.signature, view.state]);

  useEffect(() => { if (!view.discovery) return; setPayToken((current) => current ? view.discovery!.inputTokens.find((token) => token.mint === current.mint) ?? current : current); }, [view.discovery]);

  useEffect(() => {
    const key = view.sessionId && receiveToken ? `swap:${view.sessionId}:${receiveToken.mint}` : undefined;
    if (claimAccountSetupNotice(seenAccountNotices.current, key, receiveToken?.outputAtaExists)) setAccountNotice(receiveToken!.symbol);
  }, [receiveToken, view.sessionId]);

  const refreshBalancesAfterSuccess = async (sessionId: string, walletAddress: string, inputMint: string, previousInputBalanceRaw: string, outputMint: string, previousOutputBalanceRaw?: string) => {
    setBalancesRefreshing(true); setBalanceRefreshFailed(false);
    try {
      let discovery: SwapDiscoveryResult | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        discovery = await api<SwapDiscoveryResult>('/api/swap/discover', { sessionId, walletAddress }, activity.state);
        if (discoveryReflectsSwapSettlement(discovery, inputMint, previousInputBalanceRaw, outputMint, previousOutputBalanceRaw)) break;
        discovery = undefined;
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
      }
      if (!discovery) throw new Error('Wallet balances are still updating.');
      setView((current) => ({ ...current, discovery }));
      setPayToken(discovery.inputTokens.find((token) => token.mint === inputMint));
    } catch { setBalanceRefreshFailed(true); }
    finally { setBalancesRefreshing(false); }
  };

  const requestQuote = useCallback(async (mode: 'initial' | 'refresh' | 'retry' = 'initial', notice?: string) => {
    if (signingLocked.current) return;
    if (activity.state !== 'active') return;
    const walletAddress = wallet.account?.address;
    if (!walletAddress || !view.sessionId || !payToken || !receiveToken || !amount || amountError || payToken.mint === receiveToken.mint) return;
    const current = ++generation.current;
    quoteRequest.current?.abort();
    const controller = new AbortController();
    quoteRequest.current = controller;
    setView((value) => ({ ...value, state: mode === 'initial' ? 'quoting' : 'refreshing-quote', quoteId: undefined, expiresAt: undefined, swap: undefined, error: undefined, notice }));
    try {
      const result = await api<QuoteResponse>('/api/swap/quote', { sessionId: view.sessionId, walletAddress, inputMint: payToken.mint, outputMint: receiveToken.mint, amount, slippageBps, clientRequestId: crypto.randomUUID() }, activity.state, controller.signal);
      if (shouldAcceptQuote(generation.current, current, signingLocked.current)) setView((value) => ({ ...value, state: 'quote-ready', quoteId: result.quoteId, expiresAt: result.expiresAt, swap: result.swap, error: undefined }));
    } catch (error) {
      if (controller.signal.aborted || !shouldAcceptQuote(generation.current, current, signingLocked.current)) return;
      const code = (error as Error & { code?: string }).code;
      setView((value) => ({ ...value, state: code === 'TOKEN_UNSUPPORTED' ? 'unavailable' : 'error', quoteId: undefined, expiresAt: undefined, swap: undefined, notice: undefined, error: error instanceof Error ? error.message : 'No safe swap route is available right now.' }));
    } finally {
      if (quoteRequest.current === controller) quoteRequest.current = null;
    }
  }, [activity.state, amount, amountError, payToken, receiveToken, slippageBps, view.sessionId, wallet.account?.address]);

  useEffect(() => {
    if (!quoteInputValid || activity.state !== 'active') return;
    const timer = window.setTimeout(() => void requestQuote('initial'), 500);
    return () => window.clearTimeout(timer);
  }, [activity.state, quoteInputValid, requestQuote]);

  useEffect(() => {
    if (view.state !== 'quote-ready' || !view.expiresAt || activity.state !== 'active') return;
    const timer = window.setTimeout(() => void requestQuote('refresh', 'Price refreshed. Review the updated amounts before continuing.'), quoteRefreshDelay(view.expiresAt));
    return () => window.clearTimeout(timer);
  }, [activity.state, requestQuote, view.expiresAt, view.state]);

  useEffect(() => {
    if (activity.state === 'active') return;
    generation.current += 1;
    quoteRequest.current?.abort();
    quoteRequest.current = null;
  }, [activity.state]);

  const submit = async () => {
    if (preparing.current || !wallet.account || !view.sessionId) return;
    const quoteId = quoteIdForPrepare(view.state, view.quoteId, view.expiresAt);
    if (!quoteId) { await requestQuote('refresh', 'The previous quote expired. Review the refreshed amounts before continuing.'); return; }
    clearSuccessFeedback();
    const sessionId = view.sessionId;
    const walletAddress = wallet.account.address;
    preparing.current = true;
    signingLocked.current = true;
    generation.current += 1;
    quoteRequest.current?.abort();
    let walletOpened = false;
    try {
      setView((current) => ({ ...current, state: 'validating', error: undefined, notice: undefined }));
      const prepared = await api<{ swap: SwapQuoteDetails }>('/api/swap/prepare', { sessionId, walletAddress, quoteId }, activity.state);
      const signingExpiresAt = prepared.swap.prepared?.walletSigningExpiresAt;
      if (!canOpenWalletForSwap(signingExpiresAt)) { signingLocked.current = false; await requestQuote('refresh', 'Price refreshed. Review the updated amounts before continuing.'); return; }
      setView((current) => ({ ...current, state: 'awaiting-signature', swap: prepared.swap }));
      walletOpened = true;
      const signed = await wallet.signTransaction(decode(prepared.swap.prepared!.serializedTransaction));
      if (!canSubmitSignedSwap(signingExpiresAt)) { signingLocked.current = false; await requestQuote('refresh', 'Price refreshed. Review the updated amounts before continuing.'); return; }
      setView((current) => ({ ...current, state: 'submitting' }));
      const result = await api<{ signature: string; reconciliation: { status: string } }>('/api/swap/submit', { sessionId, walletAddress, quoteId, signedTransaction: encode(signed), clientRequestId: crypto.randomUUID() }, activity.state);
      setView((current) => ({ ...current, state: result.reconciliation.status === 'confirmed' ? 'confirmed' : 'error', signature: result.signature }));
      if (result.reconciliation.status === 'confirmed' && payToken && receiveToken) await refreshBalancesAfterSuccess(sessionId, walletAddress, payToken.mint, payToken.balanceRaw, receiveToken.mint, receiveToken.balanceRaw);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      signingLocked.current = false;
      if (shouldRefreshQuoteAfterPrepareError(code)) await requestQuote('refresh', 'Price refreshed. Review the updated amounts before continuing.');
      else if (walletOpened) await requestQuote('refresh', 'Wallet approval ended. Review the refreshed amounts before continuing.');
      else setView((current) => ({ ...current, state: 'error', error: error instanceof Error ? error.message : 'Your tokens have not moved.' }));
    } finally {
      signingLocked.current = false;
      preparing.current = false;
    }
  };

  const reverse = () => { setAccountNotice(undefined); setPayToken(view.discovery?.inputTokens.find((token) => token.mint === receiveMint)); setReceiveMint(payToken?.mint ?? ''); invalidate(); };
  const swapAgain = () => { clearSuccessFeedback(); generation.current += 1; quoteRequest.current?.abort(); setBalancesRefreshing(false); setBalanceRefreshFailed(false); setAmount(''); setPayToken(undefined); setReceiveMint(''); setView({ state: 'loading' }); setSessionGeneration((value) => value + 1); };
  const quoted = view.swap;
  const busy = ['loading', 'quoting', 'refreshing-quote', 'validating', 'preparing', 'awaiting-signature', 'submitting'].includes(view.state) || balancesRefreshing;
  const selectorLocked = financialTokenSelectionLocked(view.state);
  const currentQuoteId = quoteIdForPrepare(view.state, view.quoteId, view.expiresAt);
  const canRetry = view.state === 'error' && quoteInputValid;
  const action = !connected ? 'CONNECT WALLET' : view.state === 'loading' ? 'LOADING TOKENS…' : view.state === 'quoting' ? 'FETCHING QUOTE…' : view.state === 'refreshing-quote' ? 'REFRESHING QUOTE…' : currentQuoteId ? 'REVIEW & SWAP' : view.state === 'validating' || view.state === 'preparing' ? 'VALIDATING…' : view.state === 'awaiting-signature' ? 'APPROVE IN WALLET' : view.state === 'submitting' ? 'CONFIRMING…' : view.state === 'confirmed' ? 'SWAP AGAIN' : canRetry ? 'RETRY QUOTE' : 'WAITING FOR QUOTE';

  return <div className="feature-body swap-body">
    <div className="transaction-field"><div className="field-heading"><label htmlFor="swap-amount">YOU PAY</label>{(balancesRefreshing || balanceRefreshFailed || payToken) && <span>{balancesRefreshing ? 'BALANCE REFRESHING…' : balanceRefreshFailed ? 'BALANCE REFRESH NEEDED' : view.discovery ? `BALANCE ${display(payToken!.balanceRaw, payToken!.decimals, payToken!.uiMultiplier)}` : 'BALANCE LOADING'}</span>}</div><div className="amount-row"><input id="swap-amount" inputMode="decimal" value={amount} disabled={busy || balanceRefreshFailed} onChange={(event) => { setAmount(event.target.value); invalidate(); }} placeholder="0.00" aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'swap-amount-error' : undefined} /><button type="button" disabled={!payToken?.balanceRaw || payToken.balanceRaw === '0' || busy || balanceRefreshFailed} onClick={() => { if (payToken) setAmount(display(payToken.balanceRaw, payToken.decimals, payToken.uiMultiplier)); invalidate(); }}>MAX</button></div><TokenSelector label="Pay token" value={payToken ? option(payToken) : null} tokens={inputOptions} disabled={selectorLocked} onChange={(selected) => { const catalog = swapInputTokenCatalog.find((token) => token.mint === selected.mint); setPayToken(view.discovery?.inputTokens.find((token) => token.mint === selected.mint) ?? (catalog ? catalogSwapToken(catalog, '0') : undefined)); invalidate(); }} /><FieldError id="swap-amount-error">{amountError}</FieldError></div>
    <button className="transfer-mark" type="button" disabled={busy} onClick={reverse} aria-label="Swap token direction">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="transfer-mark__down" d="M8 4v13m0 0-3-3m3 3 3-3" />
        <path className="transfer-mark__up" d="M16 20V7m0 0-3 3m3-3 3 3" />
      </svg>
    </button>
    <div className="transaction-field"><div className="field-heading"><label htmlFor="swap-output">YOU RECEIVE</label>{(view.state === 'quoting' || view.state === 'refreshing-quote') && <span>UPDATING</span>}</div><input id="swap-output" className="output-value" readOnly value={quoted ? display(quoted.expectedOutputRaw, quoted.outputToken.decimals, quoted.outputToken.uiMultiplier) : ''} placeholder="0.00" /><TokenSelector label="Receive token" value={receiveToken ? option(receiveToken) : null} tokens={outputOptions} disabled={selectorLocked} onChange={(selected) => { setAccountNotice(undefined); setReceiveMint(selected.mint); invalidate(); }} /></div>
    {accountNotice && <AccountSetupNotice tokenSymbol={accountNotice} onDismiss={() => setAccountNotice(undefined)} />}
    <div className="summary-line"><span>MINIMUM RECEIVED</span><strong>{quoted ? `${display(quoted.minimumOutputRaw, quoted.outputToken.decimals, quoted.outputToken.uiMultiplier)} ${quoted.outputToken.symbol}` : '—'}</strong></div>
    <button className="console-primary" type="button" onClick={!connected ? onConnect : view.state === 'confirmed' ? swapAgain : currentQuoteId ? () => void submit() : canRetry ? () => void requestQuote('retry') : undefined} disabled={balancesRefreshing || (connected && view.state !== 'confirmed' && (busy || balanceRefreshFailed || (!currentQuoteId && !canRetry)))}>{action}</button>{view.notice && <p className="connection-message" role="status">{view.notice}</p>}{balanceRefreshFailed && <p className="connection-message" role="status">Wallet balances are still updating. Select SWAP AGAIN to rescan before continuing.</p>}{view.error && <p className="connection-message" role="alert">{view.error}</p>}
    <DetailSection><div className="detail-group"><DetailRow label="GASLESS fee (0.30%)" value={quoted ? `${display(quoted.serviceFeeRaw, quoted.inputToken.decimals, quoted.inputToken.uiMultiplier)} ${quoted.inputToken.symbol}` : '—'} /><DetailRow label="Sponsored network cost" value={quoted ? `${display(quoted.sponsorReimbursementRaw, quoted.inputToken.decimals, quoted.inputToken.uiMultiplier)} ${quoted.inputToken.symbol}` : '—'} /><DetailRow label="Minimum received" value={quoted ? `${display(quoted.minimumOutputRaw, quoted.outputToken.decimals, quoted.outputToken.uiMultiplier)} ${quoted.outputToken.symbol}` : '—'} /><ChoiceSelect id="swap-slippage" label="Slippage" value={slippageBps} disabled={busy} options={[{ value: 30, label: '0.30%' }, { value: 50, label: '0.50%' }, { value: 100, label: '1.00%' }]} onChange={(value) => { setSlippageBps(value); invalidate(); }} /><DetailRow label="Price impact" value={quoted ? `${(quoted.priceImpactBps / 100).toFixed(2)}%` : '—'} /></div><div className="detail-group detail-group--secondary"><DetailRow label="Token account setup" value={quoted?.outputAtaExists === false ? `${quoted.outputAtaRentLamports} sponsored lamports` : quoted ? 'Not needed' : '—'} /><DetailRow label="Amount routed" value={quoted ? `${display(quoted.routedInputRaw, quoted.inputToken.decimals, quoted.inputToken.uiMultiplier)} ${quoted.inputToken.symbol}` : '—'} /><DetailRow label="Total from wallet" value={quoted ? `${display(quoted.totalInputRaw, quoted.inputToken.decimals, quoted.inputToken.uiMultiplier)} ${quoted.inputToken.symbol}` : '—'} /></div><p>All costs settle atomically. SOL needed from you: 0.</p></DetailSection>
    {confettiCount > 0 && <div className="swap-confetti" aria-hidden="true">{Array.from({ length: confettiCount }, (_, index) => <i key={index} style={particleStyle(index)} />)}</div>}
    {successToast && <div className="swap-success-toast" role="status">Swap complete · <a href={explorerTransactionUrl(successToast)} target="_blank" rel="noreferrer">View transaction</a></div>}
  </div>;
}

export function SwapConsole({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const [tab, setTab] = useState<'swap' | 'cross-chain'>('swap');
  return <>
    <div className="console-mode-tabs" role="tablist" aria-label="Swap mode">
      <button id="swap-tab" type="button" role="tab" aria-selected={tab === 'swap'} aria-controls="swap-panel" className={tab === 'swap' ? 'is-active' : ''} onClick={() => setTab('swap')}>SWAP</button>
      <button id="cross-chain-tab" type="button" role="tab" aria-selected={tab === 'cross-chain'} aria-controls="cross-chain-panel" className={tab === 'cross-chain' ? 'is-active' : ''} onClick={() => setTab('cross-chain')}>CROSS-CHAIN</button>
    </div>
    <div id="swap-panel" role="tabpanel" aria-labelledby="swap-tab" hidden={tab !== 'swap'}><SolanaSwapPanel connected={connected} onConnect={onConnect} /></div>
    <div id="cross-chain-panel" role="tabpanel" aria-labelledby="cross-chain-tab" hidden={tab !== 'cross-chain'}><CrossChainPanel entryMode="swap" /></div>
  </>;
}
