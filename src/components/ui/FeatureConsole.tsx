import { useEffect, useRef } from 'react';
import type { Feature } from '../../types/app';
import { FEATURE_COPY } from '../../types/app';
import { ClaimConsole } from '../../features/clean';
import { SendConsole } from '../../features/send';
import { SwapConsole } from '../../features/swap';
import { WalletButton } from '../wallet/WalletButton';
import { useWallet } from '../../wallet/walletContext';

export function FeatureConsole({ feature, closing, onClose }: { feature: Feature; closing: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const { connected, error, requestConnection } = useWallet();
  useEffect(() => {
    const node = dialog.current;
    node?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);
  return <section ref={dialog} className={`feature-console${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="console-title" aria-describedby="console-description" tabIndex={-1}>
    <header className="console-header"><div><span>GASLESS / {FEATURE_COPY[feature].index}</span><h2 id="console-title">{feature === 'claim' ? 'clean' : feature}</h2><p id="console-description">{FEATURE_COPY[feature].description}</p></div><div className="console-controls"><WalletButton /><button className="console-close" type="button" onClick={onClose} aria-label={`Close ${feature === 'claim' ? 'clean' : feature}`}>×</button></div></header>
    {error && <p className="connection-message" role="status">{error}</p>}
    {feature === 'claim' && <ClaimConsole connected={connected} onConnect={requestConnection} />}
    {feature === 'swap' && <SwapConsole connected={connected} onConnect={requestConnection} />}
    {feature === 'send' && <SendConsole connected={connected} onConnect={requestConnection} />}
  </section>;
}
