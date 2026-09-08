import { useEffect, useRef, useState } from 'react';
import { PRODUCT_NETWORKS, type ProductNetworkId } from '../../../config/productNetworks';
import { trapDrawerFocus } from './drawerFocus';

export function NetworkDrawer({ open, selectedNetwork, onSelect, onClose }: {
  open: boolean;
  selectedNetwork: ProductNetworkId;
  onSelect: (network: ProductNetworkId) => void;
  onClose: () => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<{ networkLabel: string; gaslessStatus: string; sponsorshipAvailable: boolean; supportedTokenCount: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    drawer.current?.focus({ preventScroll: true });
    fetch('/api/public/status').then((response) => response.ok ? response.json() : Promise.reject()).then(setStatus).catch(() => setStatus(null));
  }, [open]);

  return (
    <aside ref={drawer} id="network-drawer" className={`hud-drawer hud-drawer--left${open ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!open} aria-labelledby="network-title" tabIndex={-1} onKeyDown={trapDrawerFocus}>
      <div className="drawer-header"><div><h2 id="network-title">NETWORK</h2></div><button type="button" aria-label="Close network panel" onClick={onClose}>×</button></div>
      <div className="network-list">
        {PRODUCT_NETWORKS.map((network) => (
          <button key={network.id} type="button" className={selectedNetwork === network.id ? 'is-active' : ''} aria-pressed={selectedNetwork === network.id} onClick={() => onSelect(network.id)}>
            <i aria-hidden="true" /><strong>{network.displayName.toUpperCase()}</strong><span>{network.status === 'operational' ? 'OPERATIONAL' : 'COMING SOON'}</span>
          </button>
        ))}
      </div>
      {selectedNetwork === 'solana' && <dl className="stats-list network-live-status">
        <div><dt>GASLESS STATUS</dt><dd>{status?.gaslessStatus?.toUpperCase() ?? 'UNAVAILABLE'}</dd></div>
        <div><dt>SPONSORSHIP</dt><dd>{status?.sponsorshipAvailable ? 'AVAILABLE' : 'PAUSED'}</dd></div>
        <div><dt>SUPPORTED TOKENS</dt><dd>{status?.supportedTokenCount ?? '—'}</dd></div>
      </dl>}
    </aside>
  );
}
