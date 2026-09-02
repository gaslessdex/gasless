import { useEffect, useState } from 'react';
import { appNetworkLabel } from '../../../config/network';

const networks = [{ name: 'SOLANA', status: appNetworkLabel, active: true }];

export function NetworkDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<{ networkLabel: string; gaslessStatus: string; sponsorshipAvailable: boolean; supportedTokenCount: number } | null>(null);
  useEffect(() => { if (open) fetch('/api/public/status').then((response) => response.ok ? response.json() : Promise.reject()).then(setStatus).catch(() => setStatus(null)); }, [open]);
  return (
    <aside id="network-drawer" className={`hud-drawer hud-drawer--left${open ? ' is-open' : ''}`} aria-hidden={!open} aria-label="Network selection">
      <div className="drawer-header"><div><span>01 / CHAIN</span><h2>NETWORK</h2></div><button type="button" aria-label="Close network drawer" onClick={onClose}>×</button></div>
      <p className="drawer-intro">SOLANA IS THE ONLY ACTIVE V1 CHAIN. STATUS VALUES COME FROM THE LIVE GASLESS BACKEND.</p>
      <div className="network-list">
        {networks.map((network, index) => (
          <button key={network.name} type="button" className={network.active ? 'is-active' : ''} disabled={!network.active}>
            <small>{String(index + 1).padStart(2, '0')}</small><strong>{network.name}</strong><span>{network.status}</span>
          </button>
        ))}
      </div>
      <dl className="stats-list">
        <div><dt>GASLESS STATUS</dt><dd>{status?.gaslessStatus?.toUpperCase() ?? 'UNAVAILABLE'}</dd></div>
        <div><dt>SPONSORSHIP</dt><dd>{status?.sponsorshipAvailable ? 'AVAILABLE' : 'PAUSED'}</dd></div>
        <div><dt>SUPPORTED TOKENS</dt><dd>{status?.supportedTokenCount ?? '—'}</dd></div>
      </dl>
      <div className="drawer-footer"><i /><span>{status?.networkLabel?.toUpperCase() ?? appNetworkLabel} / ENVIRONMENT LOCKED</span></div>
    </aside>
  );
}
