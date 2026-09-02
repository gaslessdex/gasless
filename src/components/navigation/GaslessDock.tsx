import { useState } from 'react';
import type { Theme } from '../../types/app';
import darkLogo from '../../../assets/brand/word-logo-darkmode.png';
import lightLogo from '../../../assets/brand/word-logo-lightmode.png';
import { appNetwork, appNetworkLabel } from '../../config/network';

export function GaslessDock({ theme }: { theme: Theme }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;
  const logo = theme === 'dark' ? lightLogo : darkLogo;
  return (
    <nav className={`gasless-dock${expanded ? ' is-expanded' : ''}`} aria-label="GASLESS navigation and network" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button className="dock-trigger" type="button" aria-expanded={expanded} aria-label="Toggle GASLESS navigation" onClick={() => setPinned((value) => !value)}>
        <span>G</span>
      </button>
      <div className="dock-content" aria-hidden={!expanded}>
        <img src={logo} alt="GASLESS" />
        <div className="dock-links">
          <a href="#about">ABOUT</a>
          <a href="#docs">DOCS</a>
          <a href="#social">X</a>
        </div>
        <label className="network-select">
          <span>NETWORK</span>
          <select value={appNetwork} aria-label="Solana network" disabled>
            <option value={appNetwork}>{appNetworkLabel}</option>
          </select>
        </label>
      </div>
    </nav>
  );
}
