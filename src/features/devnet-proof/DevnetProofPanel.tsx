import { useState } from 'react';
import { useWallet } from '../../wallet/walletContext';

type ProofState = { label: string; transactionId?: string; signature?: string; error?: string };

async function api<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify(payload) });
  const value = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? 'The proof request failed.');
  return value;
}

export function DevnetProofPanel() {
  const wallet = useWallet();
  const [state, setState] = useState<ProofState>({ label: 'READY' });
  const run = async () => {
    if (!wallet.account) return wallet.requestConnection();
    try {
      setState({ label: 'SESSION' });
      const session = await api<{ sessionId: string }>('/api/session', { walletAddress: wallet.account.address, network: 'devnet' });
      setState({ label: 'QUOTE' });
      const quote = await api<{ quoteId: string }>('/api/transactions/quote', { sessionId: session.sessionId, walletAddress: wallet.account.address, clientRequestId: crypto.randomUUID() });
      setState({ label: 'SIMULATING' });
      const prepared = await api<{ transactionId: string; serializedTransaction: string }>('/api/transactions/prepare', { sessionId: session.sessionId, walletAddress: wallet.account.address, quoteId: quote.quoteId });
      setState({ label: 'AWAITING WALLET', transactionId: prepared.transactionId });
      const signed = await wallet.signTransaction(Uint8Array.from(atob(prepared.serializedTransaction), (char) => char.charCodeAt(0)));
      setState({ label: 'VALIDATING / RELAYING', transactionId: prepared.transactionId });
      const result = await api<{ signature: string }>('/api/transactions/submit', { sessionId: session.sessionId, walletAddress: wallet.account.address, quoteId: quote.quoteId, signedTransaction: btoa(String.fromCharCode(...signed)), clientRequestId: crypto.randomUUID() });
      setState({ label: 'RECONCILED', transactionId: prepared.transactionId, signature: result.signature });
    } catch (error) { setState({ label: 'FAILED', error: error instanceof Error ? error.message : 'Proof failed.' }); }
  };
  return <aside className="devnet-proof-panel" aria-label="Devnet transaction proof">
    <strong>DEVNET BACKBONE PROOF</strong><span>{state.label}</span>
    {state.transactionId && <small>TX {state.transactionId}</small>}
    {state.signature && <a href={`https://explorer.solana.com/tx/${state.signature}?cluster=devnet`} target="_blank" rel="noreferrer">VIEW DEVNET TRANSACTION</a>}
    {state.error && <small role="alert">{state.error}</small>}
    <button type="button" onClick={() => void run()} disabled={state.label !== 'READY' && state.label !== 'FAILED' && state.label !== 'RECONCILED'}>{wallet.connected ? 'RUN SAFE PROOF' : 'CONNECT WALLET'}</button>
  </aside>;
}
