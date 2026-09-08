import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CrossChainPreparedTransaction, CrossChainQuote, CrossChainStatus, CrossChainSubmissionResult } from '../../../shared/cross-chain/types';
import { DetailRow, DetailSection, FieldError } from '../../components/ui/TransactionControls';
import { appNetwork } from '../../config/network';
import { useWallet } from '../../wallet/walletContext';
import { CROSS_CHAIN_DESTINATIONS, CROSS_CHAIN_INPUT_ASSETS, CROSS_CHAIN_SOURCE, type CrossChainDestinationId, type CrossChainInputAsset, type CrossChainOutputAsset } from '../../config/crossChain';
import { CrossChainSelect } from './CrossChainSelect';
import { crossChainFailurePresentation, crossChainStatusPresentation, type CrossChainUiStatus } from './status';
import { crossChainAmountError, crossChainRecipientError } from './validation';

export type CrossChainEntryMode = 'bridge' | 'swap';
type QuoteState = { sessionId?: string; quote?: CrossChainQuote; loading: boolean; error?: string };
type ExecutionState = { status?: CrossChainUiStatus; transactionId?: string; signature?: string; label?: string; message?: string };

class CrossChainApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function api<T>(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload), signal });
  const value = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new CrossChainApiError(value.error?.message ?? 'Cross-chain is temporarily unavailable.', value.error?.code);
  return value;
}

function decode(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encode(value: Uint8Array) { return btoa(String.fromCharCode(...value)); }
function wait(milliseconds: number) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

export function CrossChainPanel({ entryMode }: { entryMode: CrossChainEntryMode }) {
  const id = useId(); const wallet = useWallet();
  const [destinationId, setDestinationId] = useState<CrossChainDestinationId>('robinhood');
  const [inputAsset, setInputAsset] = useState<CrossChainInputAsset>('SOL'); const [outputAsset, setOutputAsset] = useState<CrossChainOutputAsset>('ETH');
  const [amount, setAmount] = useState(''); const [recipient, setRecipient] = useState(''); const [reviewing, setReviewing] = useState(false);
  const [state, setState] = useState<QuoteState>({ loading: false }); const generation = useRef(0); const request = useRef<AbortController | undefined>(undefined);
  const [execution, setExecution] = useState<ExecutionState>({}); const signingLocked = useRef(false); const mounted = useRef(true);
  const walletAddress = wallet.account?.address;
  const destination = CROSS_CHAIN_DESTINATIONS.find((option) => option.id === destinationId) ?? CROSS_CHAIN_DESTINATIONS[0];
  const amountError = useMemo(() => crossChainAmountError(amount), [amount]); const recipientError = useMemo(() => crossChainRecipientError(recipient), [recipient]);
  const valid = Boolean(walletAddress && amount && recipient && !amountError && !recipientError); const quoteFresh = Boolean(state.quote && Date.parse(state.quote.expiresAt) > Date.now());
  const executionPresentation = execution.status ? crossChainStatusPresentation(execution.status) : execution.label ? { label: execution.label, message: execution.message ?? '', terminal: true } : undefined;
  const executionActive = Boolean(executionPresentation && !executionPresentation.terminal);
  const payLabel = entryMode === 'bridge' ? 'YOU SEND' : 'YOU PAY'; const actionLabel = entryMode === 'bridge' ? 'REVIEW BRIDGE' : 'REVIEW CROSS-CHAIN SWAP';
  const invalidate = () => { if (executionActive) return; generation.current += 1; request.current?.abort(); setReviewing(false); setExecution({}); setState((current) => ({ sessionId: current.sessionId, loading: false })); };
  const selectDestination = (nextId: CrossChainDestinationId) => {
    const next = CROSS_CHAIN_DESTINATIONS.find((option) => option.id === nextId);
    if (!next?.enabled) return;
    setDestinationId(nextId);
    const firstOutput = next.outputs[0];
    if (firstOutput) setOutputAsset(firstOutput.symbol);
    invalidate();
  };

  useEffect(() => {
    request.current?.abort(); setReviewing(false);
    if (!walletAddress) { setState({ loading: false }); return; }
    const controller = new AbortController(); request.current = controller;
    void api<{ sessionId: string }>('/api/session', { walletAddress, network: appNetwork }, controller.signal).then((session) => { if (!controller.signal.aborted) setState({ sessionId: session.sessionId, loading: false }); }).catch((error) => { if (!controller.signal.aborted) setState({ loading: false, error: error instanceof Error ? error.message : 'Cross-chain quotes are temporarily unavailable.' }); });
    return () => controller.abort();
  }, [walletAddress]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!valid || !state.sessionId || !walletAddress) return;
    const currentGeneration = ++generation.current; const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const timer = window.setTimeout(() => {
      setState((current) => ({ sessionId: current.sessionId, loading: true }));
      void api<CrossChainQuote>('/api/cross-chain/quote', { sessionId: state.sessionId, walletAddress, recipient, inputAsset, outputAsset, amount }, controller.signal)
        .then((quote) => { if (!controller.signal.aborted && generation.current === currentGeneration) setState({ sessionId: state.sessionId, quote, loading: false }); })
        .catch((error) => { if (!controller.signal.aborted && generation.current === currentGeneration) setState({ sessionId: state.sessionId, loading: false, error: error instanceof Error ? error.message : 'Cross-chain quotes are temporarily unavailable.' }); });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [amount, inputAsset, outputAsset, recipient, state.sessionId, valid, walletAddress]);

  useEffect(() => { if (!state.quote || execution.status) return; const delay = Date.parse(state.quote.expiresAt) - Date.now(); const timer = window.setTimeout(() => setState((current) => ({ sessionId: current.sessionId, loading: false, error: 'That quote expired. Change the amount to refresh it.' })), Math.max(0, delay)); return () => window.clearTimeout(timer); }, [execution.status, state.quote]);

  const poll = async (transactionId: string, sessionId: string, address: string, signature: string) => {
    const deadline = Date.now() + 20 * 60_000; let transientFailures = 0;
    while (Date.now() < deadline) {
      await wait(5_000);
      try {
        const result = await api<{ status: CrossChainStatus }>('/api/cross-chain/status', { sessionId, walletAddress: address, transactionId });
        if (!mounted.current) return;
        transientFailures = 0; setExecution({ status: result.status, transactionId, signature });
        if (crossChainStatusPresentation(result.status).terminal) return;
      } catch {
        transientFailures += 1;
        if (mounted.current && transientFailures >= 2) setExecution({ status: 'unknown_retryable', transactionId, signature });
      }
    }
    if (mounted.current) setExecution({ status: 'unknown_retryable', transactionId, signature });
  };

  const execute = async () => {
    const quote = state.quote; const sessionId = state.sessionId; const account = wallet.account;
    if (signingLocked.current || !quote || !quoteFresh || !quote.executionReady || !sessionId || !account) return;
    signingLocked.current = true; const address = account.address;
    try {
      setState((current) => ({ ...current, error: undefined })); setExecution({ status: 'preparing' });
      const prepared = await api<CrossChainPreparedTransaction>('/api/cross-chain/build', { sessionId, walletAddress: address, quoteId: quote.quoteId });
      if (wallet.account?.address !== address) throw new CrossChainApiError('The connected wallet changed.', 'MESSAGE_MISMATCH');
      setExecution({ status: 'awaiting_signature', transactionId: prepared.transactionId });
      const signed = await wallet.signTransaction(decode(prepared.serializedTransaction));
      if (wallet.account?.address !== address) throw new CrossChainApiError('The connected wallet changed.', 'MESSAGE_MISMATCH');
      setExecution({ status: 'sending', transactionId: prepared.transactionId });
      const submitted = await api<CrossChainSubmissionResult>('/api/cross-chain/submit', { sessionId, walletAddress: address, transactionId: prepared.transactionId, signedTransaction: encode(signed) });
      setExecution({ status: submitted.sourceStatus === 'confirmed' ? 'source_confirmed' : 'submitted', transactionId: prepared.transactionId, signature: submitted.signature });
      await poll(prepared.transactionId, sessionId, address, submitted.signature);
    } catch (error) {
      if (!mounted.current) return;
      const presentation = crossChainFailurePresentation(error instanceof CrossChainApiError ? error.code : undefined);
      setExecution({ label: presentation.label, message: presentation.message });
    } finally { signingLocked.current = false; }
  };

  const quote = state.quote;
  return <div className="feature-body cross-chain-panel" data-cross-chain-entry={entryMode}>
    <div className="cross-chain-route" aria-label="Cross-chain route">
      <div><span>FROM</span><strong>{CROSS_CHAIN_SOURCE.name}</strong></div>
      <div><span>TO</span><CrossChainSelect id={`${id}-destination`} label="Destination network" value={destinationId} options={CROSS_CHAIN_DESTINATIONS.map((option) => ({ value: option.id, label: option.name, disabled: !option.enabled }))} onChange={selectDestination} className="cross-chain-select--destination" disabled={executionActive} /></div>
    </div>
    <div className="cross-chain-asset-field">
      <div className="field-heading"><label htmlFor={`${id}-amount`}>{payLabel}</label></div>
      <div className="cross-chain-value-row"><input id={`${id}-amount`} inputMode="decimal" value={amount} disabled={executionActive} onChange={(event) => { setAmount(event.target.value); invalidate(); }} placeholder="0.00" aria-invalid={Boolean(amountError)} aria-describedby={amountError ? `${id}-amount-error` : undefined} /><CrossChainSelect id={`${id}-input-asset`} label="Input asset" value={inputAsset} options={CROSS_CHAIN_INPUT_ASSETS.map((asset) => ({ value: asset.symbol, label: asset.symbol }))} onChange={(value) => { setInputAsset(value); invalidate(); }} className="cross-chain-select--asset" disabled={executionActive} /></div>
      <FieldError id={`${id}-amount-error`}>{amountError}</FieldError><small className="cross-chain-network">ON SOLANA</small>
    </div>
    <div className="cross-chain-asset-field">
      <div className="field-heading"><label htmlFor={`${id}-output`}>YOU RECEIVE</label></div>
      <div className="cross-chain-value-row"><input id={`${id}-output`} readOnly value={quote?.estimatedOutput ?? ''} placeholder={state.loading ? 'LOADING QUOTE…' : 'QUOTE REQUIRED'} /><CrossChainSelect id={`${id}-output-asset`} label="Output asset" value={outputAsset} options={destination.outputs.map((asset) => ({ value: asset.symbol, label: asset.symbol }))} onChange={(value) => { setOutputAsset(value); invalidate(); }} className="cross-chain-select--asset" disabled={executionActive} /></div>
      <small className="cross-chain-network">ON {destination.name.toUpperCase()}</small>
    </div>
    <label className="recipient-field" htmlFor={`${id}-recipient`}><span>RECIPIENT WALLET</span><input id={`${id}-recipient`} value={recipient} disabled={executionActive} onChange={(event) => { setRecipient(event.target.value.trim()); invalidate(); }} placeholder="0x wallet address" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(recipientError)} aria-describedby={recipientError ? `${id}-recipient-error` : undefined} /></label><FieldError id={`${id}-recipient-error`}>{recipientError}</FieldError>
    {state.error && <p className="connection-message" role="alert">{state.error}</p>}
    {reviewing && quote && (quoteFresh || Boolean(executionPresentation)) ? <section className="cross-chain-review" aria-live="polite"><header><span>REVIEW</span><strong>LIVE RELAY QUOTE</strong></header><dl><div><dt>You send</dt><dd>{quote.inputAmount} {quote.inputAsset}</dd></div><div><dt>From</dt><dd>Solana</dd></div><div><dt>You receive</dt><dd>≈ {quote.estimatedOutput} {quote.outputAsset}</dd></div>{quote.minimumOutput && <div><dt>Minimum received</dt><dd>{quote.minimumOutput} {quote.outputAsset}</dd></div>}<div><dt>To</dt><dd>{destination.name}</dd></div><div><dt>Recipient</dt><dd className="cross-chain-address">{quote.recipient}</dd></div><div><dt>Network fee</dt><dd>Covered by GASLESS</dd></div><div><dt>Route / bridge cost</dt><dd>{quote.routeCost ? `${quote.routeCost.amount} ${quote.routeCost.symbol}` : 'Included'}</dd></div><div><dt>GASLESS fee</dt><dd>{quote.appFee.amount} {quote.appFee.symbol}</dd></div>{quote.estimatedDurationSeconds !== undefined && <div><dt>Estimated time</dt><dd>≈ {quote.estimatedDurationSeconds}s</dd></div>}</dl>{executionPresentation && <div className={`cross-chain-progress${executionPresentation.terminal ? ' is-terminal' : ''}`} role="status"><strong>{executionPresentation.label}</strong><span>{executionPresentation.message}</span></div>}<button className="console-primary" type="button" onClick={executionPresentation?.terminal ? () => { setAmount(''); setReviewing(false); setExecution({}); setState((current) => ({ sessionId: current.sessionId, loading: false })); } : () => void execute()} disabled={executionActive || (!executionPresentation && !quote.executionReady)}>{executionPresentation?.terminal ? 'START ANOTHER' : executionActive ? executionPresentation?.label : quote.executionReady ? 'CONFIRM & SIGN' : 'PRIVATE TESTING'}</button></section> : <button className="console-primary" type="button" onClick={!wallet.account ? wallet.requestConnection : () => setReviewing(true)} disabled={Boolean(wallet.account) && (!valid || state.loading || !quoteFresh)}>{!wallet.account ? 'CONNECT WALLET' : state.loading ? 'GETTING LIVE QUOTE…' : actionLabel}</button>}
    {!reviewing && <DetailSection><DetailRow label="Network fee" value="Covered by GASLESS" /><DetailRow label="GASLESS fee" value={quote ? `${quote.appFee.amount} ${quote.appFee.symbol}` : '—'} /><DetailRow label="Route cost" value={quote?.routeCost ? `${quote.routeCost.amount} ${quote.routeCost.symbol}` : quote ? 'Included' : '—'} /><DetailRow label="Minimum received" value={quote?.minimumOutput ? `${quote.minimumOutput} ${quote.outputAsset}` : '—'} /><DetailRow label="Estimated time" value={quote?.estimatedDurationSeconds !== undefined ? `≈ ${quote.estimatedDurationSeconds}s` : '—'} /></DetailSection>}
  </div>;
}
