import { useState } from 'react';
import { appNetwork, appNetworkLabel } from '../../config/network';

export function GaslessDock() {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;
  return (
    <nav className={`gasless-dock${expanded ? ' is-expanded' : ''}`} aria-label="GASLESS navigation and network" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button className="dock-trigger" type="button" aria-expanded={expanded} aria-label="Toggle GASLESS navigation" onClick={() => setPinned((value) => !value)}>
        <span>G</span>
      </button>
      <div className="dock-content" aria-hidden={!expanded}>
        <strong className="dock-brand">GASLESS</strong>
        <div className="dock-links">
          <a href="https://gasless.exchange">ABOUT</a>
          <a href="https://github.com/gaslessdex" target="_blank" rel="noreferrer">GITHUB</a>
          <a href="https://x.com/gaslessdex" target="_blank" rel="noreferrer">X</a>
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
