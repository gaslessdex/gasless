import { useEffect } from 'react';
import type { Theme } from '../../types/app';
import { ThemeToggle } from './ThemeToggle';
import { NetworkDrawer } from './drawers/NetworkDrawer';
import { StatsDrawer } from './drawers/StatsDrawer';

export type HudPanel = 'network' | 'stats' | null;

export function TopHud({ theme, onThemeChange, panel, onPanelChange }: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  panel: HudPanel;
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
        <button className={`hud-tab hud-tab--left${panel === 'network' ? ' is-active' : ''}`} type="button" aria-expanded={panel === 'network'} aria-controls="network-drawer" onClick={() => onPanelChange(panel === 'network' ? null : 'network')}><span className="hud-tab__kicker">NETWORK</span><span className="hud-tab__label">SOLANA</span><span className="hud-tab__shadow" aria-hidden="true">SOLANA</span></button>
        <ThemeToggle theme={theme} onChange={onThemeChange} />
        <button className={`hud-tab hud-tab--right${panel === 'stats' ? ' is-active' : ''}`} type="button" aria-expanded={panel === 'stats'} aria-controls="stats-drawer" onClick={() => onPanelChange(panel === 'stats' ? null : 'stats')}><span className="hud-tab__kicker">ACTIVITY METRICS</span><span className="hud-tab__label">STATS</span><span className="hud-tab__shadow" aria-hidden="true">STATS</span></button>
      </header>
      {panel && <button className="drawer-scrim" type="button" aria-label="Close drawer" onClick={() => onPanelChange(null)} />}
      <NetworkDrawer open={panel === 'network'} onClose={() => onPanelChange(null)} />
      <StatsDrawer open={panel === 'stats'} onClose={() => onPanelChange(null)} />
    </>
  );
}
