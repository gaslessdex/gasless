import { useEffect, useRef } from 'react';
import type { Theme } from '../../types/app';
import type { HudPanel } from '../ui/TopHud';
import { ThemeToggle } from '../ui/ThemeToggle';

export function MobileMenu({ theme, onThemeChange, onClose, onPanelSelect, onFaqSelect }: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
  onPanelSelect: (panel: Exclude<HudPanel, null>) => void;
  onFaqSelect: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  return <nav ref={dialog} id="mobile-menu" className="mobile-menu" role="dialog" aria-modal="true" aria-label="GASLESS menu" tabIndex={-1}>
    <header><strong className="mobile-menu__brand">GASLESS</strong><button type="button" onClick={onClose} aria-label="Close menu">×</button></header>
    <div className="mobile-menu__links">
      <button type="button" onClick={() => onPanelSelect('network')}>NETWORK</button>
      <button type="button" onClick={() => onPanelSelect('stats')}>STATS</button>
      <a href="https://github.com/gaslessdex" target="_blank" rel="noreferrer">GITHUB</a>
      <a href="https://x.com/gaslessdex" target="_blank" rel="noreferrer">TWITTER</a>
      <button type="button" onClick={onFaqSelect}>FAQ</button>
      <a href="#gasless-token" onClick={onClose}>GASLESS TOKEN</a>
    </div>
    <footer className="mobile-menu__footer"><ThemeToggle theme={theme} onChange={onThemeChange} /></footer>
  </nav>;
}
