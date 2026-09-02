import { useEffect, useMemo, useRef, useState } from 'react';
import type { RecoverAccount, RecoverDiscoveryResult, RecoverQuoteDetails } from '../../../../shared/transactions/types';
import { DetailRow, DetailSection, GaslessStatus, TokenSelector, type TokenOption } from '../../../components/ui/TransactionControls';
import { useWallet } from '../../../wallet/walletContext';
import { appNetwork, appNetworkLabel, explorerTransactionUrl } from '../../../config/network';
import { awaitWalletApproval } from '../../transactions/walletApproval';
import { walletGateForPreparedTransaction } from '../../transactions/walletLifecycle';
import { recoverHasEconomicDownside } from '../recoverLifecycle';

type RecoverState = 'disconnected' | 'loading' | 'empty' | 'selecting' | 'previewing' | 'ready' | 'preparing' | 'awaiting-signature' | 'processing' | 'confirmed' | 'unsupported' | 'pending' | 'failure';
type View = { state: RecoverState; sessionId?: string; discovery?: RecoverDiscoveryResult; quoteId?: string; recover?: RecoverQuoteDetails; signature?: string; error?: string };

async function api<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload) });
  const value = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) { const error = new Error(value.error?.message ?? 'Recover Value is temporarily unavailable.') as Error & { code?: string }; error.code = value.error?.code; throw error; }
  return value;
}

function sol(value?: string) { if (!value) return '— SOL'; const amount = BigInt(value); const whole = amount / 1_000_000_000n; const fraction = (amount % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''} SOL`; }
function amount(raw: string, decimals: number) { if (!decimals) return raw; const padded = raw.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
function shortMint(mint: string) { return `${mint.slice(0, 4)}…${mint.slice(-4)}`; }
function decode(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encode(value: Uint8Array) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }
function pendingRecoverKey(walletAddress: string) { return `gasless:pending-recover:${appNetwork}:${walletAddress}`; }
function readPendingRecover(walletAddress: string) { try { return localStorage.getItem(pendingRecoverKey(walletAddress)); } catch { return null; } }
function rememberPendingRecover(walletAddress: string, quoteId: string) { try { localStorage.setItem(pendingRecoverKey(walletAddress), quoteId); } catch { /* Durable state is authoritative. */ } }
function forgetPendingRecover(walletAddress: string) { try { localStorage.removeItem(pendingRecoverKey(walletAddress)); } catch { /* Nothing to clear. */ } }

export function RecoverConsole({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  const wallet = useWallet();
  const [view, setView] = useState<View>({ state: connected ? 'loading' : 'disconnected' });
  const [selected, setSelected] = useState<RecoverAccount>();
  const [confirmed, setConfirmed] = useState(false);
  const signingLocked = useRef(false);
  const tokens = useMemo<TokenOption[]>(() => (view.discovery?.eligibleAccounts ?? []).map((account) => ({ id: account.address, mint: account.mint, program: account.tokenProgram, symbol: account.symbol ?? shortMint(account.mint), name: 'Approved fungible token', balance: amount(account.tokenAmountRaw, account.decimals), eligible: true })), [view.discovery]);
  const selectedToken = selected ? tokens.find((token) => token.id === selected.address) ?? null : null;

  const scan = async () => {
    if (!wallet.account) return onConnect();
    try { setSelected(undefined); setConfirmed(false); setView({ state: 'loading' }); const session = await api<{ sessionId: string }>('/api/session', { walletAddress: wallet.account.address, network: appNetwork }); const pendingQuoteId = readPendingRecover(wallet.account.address); if (pendingQuoteId) { const prior = await api<{ status: 'confirmed' | 'failed' | 'pending' | 'not_submitted'; signature?: string }>('/api/recover/status', { sessionId: session.sessionId, walletAddress: wallet.account.address, quoteId: pendingQuoteId }); if (prior.status === 'confirmed') { forgetPendingRecover(wallet.account.address); setView({ state: 'confirmed', sessionId: session.sessionId, signature: prior.signature }); return; } if (prior.status === 'pending') { setView({ state: 'pending', sessionId: session.sessionId, signature: prior.signature, error: 'This Recover Value transaction is still being verified. No second transaction will be sent.' }); return; } forgetPendingRecover(wallet.account.address); } const discovery = await api<RecoverDiscoveryResult>('/api/recover/discover', { sessionId: session.sessionId, walletAddress: wallet.account.address }); setView({ state: discovery.eligibleAccounts.length ? 'selecting' : 'empty', sessionId: session.sessionId, discovery }); }
    catch (error) { setView({ state: 'failure', error: error instanceof Error ? error.message : 'Recover Value is temporarily unavailable.' }); }
  };

  useEffect(() => { if (!connected || !wallet.account) setView({ state: 'disconnected' }); else void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, wallet.account?.address]);

  const preview = async (account: RecoverAccount, options: { preserveConfirmation?: boolean; message?: string } = {}) => {
    if (!wallet.account || !view.sessionId) return;
    setSelected(account); if (!options.preserveConfirmation) setConfirmed(false);
    setView((current) => ({ ...current, state: 'previewing', recover: undefined, quoteId: undefined, error: options.message }));
    try { const quote = await api<{ quoteId: string; recover: RecoverQuoteDetails }>('/api/recover/quote', { sessionId: view.sessionId, walletAddress: wallet.account.address, tokenAccount: account.address, clientRequestId: crypto.randomUUID() }); setView((current) => ({ ...current, state: 'ready', quoteId: quote.quoteId, recover: quote.recover, error: options.message })); }
    catch (error) { const code = (error as Error & { code?: string }).code; setView((current) => ({ ...current, state: code === 'TOKEN_UNSUPPORTED' ? 'unsupported' : 'failure', error: error instanceof Error ? error.message : 'No safe Recover Value route is available.' })); }
  };

  const submit = async () => {
    if (signingLocked.current || !wallet.account || !view.sessionId || !view.quoteId || !view.recover || !confirmed) return;
    signingLocked.current = true;
    const sessionId = view.sessionId; const previewQuoteId = view.quoteId; const previewEconomics = view.recover; const walletAddress = wallet.account.address; let activeQuoteId = previewQuoteId; let preparedForWallet = false; let walletOpened = false;
    setView((current) => ({ ...current, state: 'preparing', error: undefined }));
    try {
      const prepared = await api<{ quoteId: string; recover: RecoverQuoteDetails }>('/api/recover/prepare', { sessionId, walletAddress, quoteId: previewQuoteId });
      const responseReceivedAt = Date.now(); activeQuoteId = prepared.quoteId; const exact = prepared.recover.prepared;
      if (!exact) throw new Error('The final Recover Value transaction could not be prepared. Try again.');
      preparedForWallet = true;
      if (recoverHasEconomicDownside(previewEconomics, prepared.recover)) {
        await api('/api/recover/abort-wallet-gate', { sessionId, walletAddress, quoteId: activeQuoteId, reason: 'economics_changed' }).catch(() => undefined);
        preparedForWallet = false;
        await preview(selected!, { preserveConfirmation: true, message: 'The live minimum changed. Review the updated estimate, then approve again.' });
        return;
      }
      const gate = walletGateForPreparedTransaction(exact, responseReceivedAt, Date.now(), exact.preparedBlockHeight);
      if (!gate.allowed) {
        await api('/api/recover/abort-wallet-gate', { sessionId, walletAddress, quoteId: activeQuoteId, reason: gate.reason }).catch(() => undefined);
        preparedForWallet = false;
        await preview(selected!, { preserveConfirmation: true, message: 'Transaction expired before approval. Try again.' });
        return;
      }

      setView((current) => ({ ...current, state: 'awaiting-signature', quoteId: activeQuoteId, recover: prepared.recover }));
      performance.mark?.('gasless:recover-wallet-invoked');
      window.dispatchEvent(new CustomEvent('gasless:recover-wallet-invoked', { detail: { quoteId: activeQuoteId } }));
      walletOpened = true;
      let signingRequest: Promise<Uint8Array>;
      try { signingRequest = wallet.signTransaction(decode(exact.serializedTransaction)); }
      catch (error) { await api('/api/recover/abort-wallet-approval', { sessionId, walletAddress, quoteId: activeQuoteId, reason: 'wallet_invocation_failed', userSignatureReturned: false }).catch(() => undefined); walletOpened = false; preparedForWallet = false; throw error; }
      preparedForWallet = false;
      void api('/api/recover/wallet-event', { sessionId, walletAddress, quoteId: activeQuoteId, event: 'invoked' }).catch(() => undefined);
      const approval = await awaitWalletApproval({ sign: () => signingRequest, getBlockHeight: async () => (await api<{ blockHeight: number }>('/api/recover/wallet-blockheight', { sessionId, walletAddress, quoteId: activeQuoteId })).blockHeight, lastValidBlockHeight: exact.lastValidBlockHeight });
      if (approval.status !== 'signed') { await api('/api/recover/wallet-event', { sessionId, walletAddress, quoteId: activeQuoteId, event: approval.status === 'expired' ? 'expired' : 'failed', metadata: { classification: approval.classification, elapsedMs: approval.elapsedMs } }).catch(() => undefined); await api('/api/recover/abort-wallet-approval', { sessionId, walletAddress, quoteId: activeQuoteId, reason: approval.classification, userSignatureReturned: approval.status === 'expired' && approval.userSignatureReturned }).catch(() => undefined); walletOpened = false; await preview(selected!, { message: approval.status === 'expired' ? 'Transaction expired before approval. Try again.' : 'The wallet did not approve Recover Value. Try again when ready.' }); return; }
      await api('/api/recover/wallet-event', { sessionId, walletAddress, quoteId: activeQuoteId, event: 'returned', metadata: { elapsedMs: approval.elapsedMs, blockHeight: approval.blockHeight, remainingBlocks: approval.remainingBlocks, userSignatureReturned: true } }).catch(() => undefined);
      setView((current) => ({ ...current, state: 'processing' })); rememberPendingRecover(walletAddress, activeQuoteId); const result = await api<{ signature: string; reconciliation: { status: string } }>('/api/recover/submit', { sessionId, walletAddress, quoteId: activeQuoteId, signedTransaction: encode(approval.signedTransaction), clientRequestId: crypto.randomUUID() }); if (result.reconciliation.status === 'confirmed') forgetPendingRecover(walletAddress); setView((current) => ({ ...current, state: result.reconciliation.status === 'confirmed' ? 'confirmed' : 'pending', signature: result.signature }));
    } catch (error) {
      if (preparedForWallet && !walletOpened) await api('/api/recover/abort-wallet-gate', { sessionId, walletAddress, quoteId: activeQuoteId, reason: 'final_gate_unavailable' }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "This Recover Value transaction couldn't be safely completed."; const code = (error as Error & { code?: string }).code;
      if (!walletOpened && selected && code !== 'RECONCILIATION_FAILED') await preview(selected, { preserveConfirmation: true, message: code === 'QUOTE_EXPIRED' ? 'Transaction expired before approval. Try again.' : message });
      else setView((current) => ({ ...current, state: code === 'RECONCILIATION_FAILED' ? 'pending' : code === 'TOKEN_UNSUPPORTED' ? 'unsupported' : 'failure', error: message }));
    } finally { signingLocked.current = false; }
  };

  const busy = ['loading', 'previewing', 'preparing', 'awaiting-signature', 'processing'].includes(view.state); const selectedAmount = selected ? amount(selected.tokenAmountRaw, selected.decimals) : undefined;
  const button = !connected ? 'CONNECT WALLET' : view.state === 'loading' ? 'LOADING APPROVED TOKENS…' : view.state === 'previewing' ? 'REQUESTING LIVE ESTIMATE…' : view.state === 'preparing' ? 'PREPARING TRANSACTION…' : view.state === 'ready' ? 'APPROVE IN WALLET' : view.state === 'awaiting-signature' ? 'APPROVE IN PHANTOM' : view.state === 'processing' ? `SUBMITTING ON ${appNetworkLabel}…` : view.state === 'confirmed' ? 'RECOVERY COMPLETE' : selected ? 'TRY AGAIN' : 'SCAN AGAIN';
  const handlePrimary = () => { if (!connected) onConnect(); else if (view.state === 'ready') void submit(); else if (selected) void preview(selected); else void scan(); };
  return <div id="clean-panel-recover" role="tabpanel" aria-labelledby="clean-tab-recover" className="clean-mode-panel recover-panel">
    <div className="console-lead"><span className="eyebrow">CLEAN / RECOVER VALUE</span><h3>{view.state === 'confirmed' ? 'Recovered successfully.' : 'Convert a complete approved token balance to SOL.'}</h3><p>Only exact whitelisted legacy SPL tokens with a live Jupiter route are shown. Nothing is preselected.</p></div>
    <div className="transaction-field"><div className="field-heading"><span>TOKEN</span><span>{selected ? `FULL BALANCE ${selectedAmount}` : 'FULL BALANCE ONLY'}</span></div><TokenSelector label="Token to recover" value={selectedToken} tokens={tokens} onChange={(token) => { const account = view.discovery?.eligibleAccounts.find((item) => item.address === token.id); if (account) void preview(account); }} /></div>
    <div className="summary-line"><span>ESTIMATED OUTPUT</span><strong>{sol(view.recover?.estimatedSwapOutputLamports)}</strong></div>
    <GaslessStatus connected={connected} />
    <div className="receive-line"><span>ESTIMATED MINIMUM YOU RECEIVE</span><strong>{sol(view.recover?.minimumUserPayoutLamports)}</strong></div>
    {view.state === 'ready' && <label className="burn-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Sell the full {selectedAmount} token balance and close this token account.</span></label>}
    <button className="console-primary" type="button" onClick={handlePrimary} disabled={busy || view.state === 'confirmed' || (view.state === 'ready' && !confirmed)}>{button}</button>
    {view.state === 'empty' && <p className="connection-message" role="status">No whitelisted token balance with V1 eligibility is available. Other assets remain untouched.</p>}
    {view.error && <p className="connection-message" role="alert">{view.error}</p>}
    {view.state === 'confirmed' && view.signature && <a href={explorerTransactionUrl(view.signature)} target="_blank" rel="noreferrer">VIEW TRANSACTION</a>}
    <DetailSection><DetailRow label="Token amount recovered" value={selectedAmount ?? '—'} /><DetailRow label="Jupiter route" value={view.recover?.routeLabel ?? '—'} /><DetailRow label="Guaranteed swap output" value={sol(view.recover?.minimumSwapOutputLamports)} /><DetailRow label="Account SOL recovered" value={sol(view.recover?.account.recoverableLamports)} /><DetailRow label="Swap fee (0.30%)" value={sol(view.recover?.swapServiceFeeLamports)} /><DetailRow label="Rent recovery fee (3%)" value={sol(view.recover?.rentServiceFeeLamports)} /><DetailRow label="Maximum preview network cost" value={sol(view.recover?.networkFeeLamports)} /><DetailRow label="Temporary account rent" value={view.recover ? `${sol(view.recover.temporaryAccountRentLamports)} · refunded in transaction` : '— SOL'} /><DetailRow label="Minimum SOL received" value={sol(view.recover?.minimumUserPayoutLamports)} /><p>The preview is read-only. Your click creates and simulates one fresh transaction, then opens your wallet immediately.</p></DetailSection>
  </div>;
}
