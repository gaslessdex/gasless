import { useEffect } from 'react';
import type { Theme } from '../../types/app';
import { ThemeToggle } from './ThemeToggle';
import { NetworkDrawer } from './drawers/NetworkDrawer';
import { StatsDrawer } from './drawers/StatsDrawer';
import type { ProductNetwork, ProductNetworkId } from '../../config/productNetworks';

export type HudPanel = 'network' | 'stats' | null;

export function TopHud({ theme, onThemeChange, panel, menuOpen, selectedNetwork, interactionLocked, onMenuOpen, onNetworkSelect, onPanelChange }: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  panel: HudPanel;
  menuOpen: boolean;
  selectedNetwork: ProductNetwork;
  interactionLocked: boolean;
  onMenuOpen: () => void;
  onNetworkSelect: (network: ProductNetworkId) => void;
  onPanelChange: (panel: HudPanel) => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onPanelChange(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onPanelChange]);

  return (
    <>
      <header className="top-hud" aria-label="Driving controls">
        <button className={`hud-tab hud-tab--left${panel === 'network' ? ' is-active' : ''}`} type="button" disabled={interactionLocked} aria-expanded={panel === 'network'} aria-controls="network-drawer" onClick={() => onPanelChange(panel === 'network' ? null : 'network')}><span className="hud-tab__reveal" aria-hidden="true">{selectedNetwork.shortName}</span><span className="hud-tab__label">NETWORK</span></button>
        <ThemeToggle theme={theme} onChange={onThemeChange} />
        <button className="mobile-menu-trigger" type="button" disabled={interactionLocked} aria-expanded={menuOpen} aria-controls="mobile-menu" aria-label="Open GASLESS menu" onClick={onMenuOpen}><span aria-hidden="true">G</span></button>
        <button className={`hud-tab hud-tab--right${panel === 'stats' ? ' is-active' : ''}`} type="button" disabled={interactionLocked} aria-expanded={panel === 'stats'} aria-controls="stats-drawer" onClick={() => onPanelChange(panel === 'stats' ? null : 'stats')}><span className="hud-tab__reveal" aria-hidden="true">ACTIVITY</span><span className="hud-tab__label">STATS</span></button>
      </header>
      {panel && <button className="drawer-scrim" type="button" aria-label="Close drawer" onClick={() => onPanelChange(null)} />}
      <NetworkDrawer open={panel === 'network'} selectedNetwork={selectedNetwork.id} onSelect={onNetworkSelect} onClose={() => onPanelChange(null)} />
      <StatsDrawer open={panel === 'stats'} initialNetwork={selectedNetwork.id} onClose={() => onPanelChange(null)} />
    </>
  );
}
