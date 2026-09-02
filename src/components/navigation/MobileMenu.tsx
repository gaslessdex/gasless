import { useEffect, useRef } from 'react';
import type { Theme } from '../../types/app';
import type { HudPanel } from '../ui/TopHud';
import darkLogo from '../../../assets/brand/word-logo-darkmode.png';
import lightLogo from '../../../assets/brand/word-logo-lightmode.png';

export function MobileMenu({ theme, onClose, onPanelSelect, onFaqSelect }: {
  theme: Theme;
  onClose: () => void;
  onPanelSelect: (panel: Exclude<HudPanel, null>) => void;
  onFaqSelect: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const logo = theme === 'dark' ? lightLogo : darkLogo;

  useEffect(() => {
    dialog.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  return <nav ref={dialog} className="mobile-menu" role="dialog" aria-modal="true" aria-label="GASLESS menu" tabIndex={-1}>
    <header><img src={logo} alt="GASLESS" /><button type="button" onClick={onClose} aria-label="Close menu">×</button></header>
    <div className="mobile-menu__links">
      <button type="button" onClick={() => onPanelSelect('network')}>NETWORK</button>
      <button type="button" onClick={() => onPanelSelect('stats')}>STATS</button>
      <a href="https://github.com/gaslessdex/gasless" target="_blank" rel="noreferrer">GITHUB</a>
      <a href="https://x.com/gaslessdex" target="_blank" rel="noreferrer">TWITTER</a>
      <button type="button" onClick={onFaqSelect}>FAQ</button>
      <a href="#gasless-token" onClick={onClose}>GASLESS TOKEN</a>
    </div>
  </nav>;
}
