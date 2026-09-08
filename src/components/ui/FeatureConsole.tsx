import { useEffect, useRef } from 'react';
import type { ProductNetwork } from '../../config/productNetworks';
import { ClaimConsole } from '../../features/clean';
import { SendConsole } from '../../features/send';
import { SwapConsole } from '../../features/swap';
import { FEATURE_COPY, type Feature } from '../../types/app';
import { useWallet } from '../../wallet/walletContext';
import { WalletButton } from '../wallet/WalletButton';
import { EvmPreviewConsole } from './EvmPreviewConsole';

export function FeatureConsole({ feature, network, closing, onClose }: { feature: Feature; network: ProductNetwork; closing: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const { connected, error, requestConnection } = useWallet();

  useEffect(() => {
    const node = dialog.current;
    node?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { if (node?.querySelector('[role="listbox"]')) return; event.preventDefault(); onClose(); return; }
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

  const liveSolana = network.productionFunctional;
  return <section ref={dialog} className={`feature-console${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="console-title" aria-describedby="console-description" tabIndex={-1}>
    <header className="console-header"><div><h2 id="console-title">{FEATURE_COPY[feature].title}</h2><p id="console-description">{FEATURE_COPY[feature].description}</p></div><div className="console-controls">{liveSolana ? <WalletButton /> : <button className="wallet-state preview-wallet" type="button" disabled>CONNECT WALLET · SOON</button>}<button className="console-close" type="button" onClick={onClose} aria-label={`Close ${FEATURE_COPY[feature].title}`}>×</button></div></header>
    {liveSolana && error && <p className="connection-message" role="status">{error}</p>}
    {liveSolana && feature === 'claim' && <ClaimConsole connected={connected} onConnect={requestConnection} />}
    {liveSolana && feature === 'swap' && <SwapConsole connected={connected} onConnect={requestConnection} />}
    {liveSolana && feature === 'send' && <SendConsole connected={connected} onConnect={requestConnection} />}
    {!liveSolana && feature !== 'claim' && <EvmPreviewConsole feature={feature} network={network} />}
  </section>;
}
