import { useEffect, useRef } from 'react';

export function AccountSetupNotice({ tokenSymbol, recipient = false, onDismiss, durationMs = 7_000 }: { tokenSymbol: string; recipient?: boolean; onDismiss: () => void; durationMs?: number }) {
  const dismiss = useRef(onDismiss); useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => { if (recipient) return; const timer = window.setTimeout(() => dismiss.current(), durationMs); return () => window.clearTimeout(timer); }, [durationMs, recipient, tokenSymbol]);
  return <aside className="account-setup-notice" role="status" aria-live="polite">
    <span><strong>{recipient ? 'Recipient setup required' : `First time receiving ${tokenSymbol}`}</strong><small>{recipient ? 'This wallet is receiving this token for the first time. GASLESS will cover the SOL account setup cost and include it in the quoted network cost.' : 'A token account needs to be created. GASLESS will cover the SOL cost and include it in the quoted network cost.'}</small></span>
    <button type="button" aria-label={recipient ? 'Dismiss recipient setup notice' : `Dismiss ${tokenSymbol} token account notice`} onClick={onDismiss}>×</button>
  </aside>;
}
