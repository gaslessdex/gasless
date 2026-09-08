import { useEffect, useRef, useState } from 'react';
import { formatPublicNetworkFee, selectPublicNetworkStats, type PublicStatsResponse } from '../../../../shared/stats/public';
import { PRODUCT_NETWORKS, productNetwork, type ProductNetworkId } from '../../../config/productNetworks';
import { trapDrawerFocus } from './drawerFocus';

export function StatsDrawer({ open, initialNetwork, onClose }: { open: boolean; initialNetwork: ProductNetworkId; onClose: () => void }) {
  const drawer = useRef<HTMLElement>(null);
  const [selectedNetwork, setSelectedNetwork] = useState<ProductNetworkId>(initialNetwork);
  const [stats, setStats] = useState<PublicStatsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    drawer.current?.focus({ preventScroll: true });
    setSelectedNetwork(initialNetwork);
    setStats(null);
    setUnavailable(false);
    fetch('/api/public/stats').then((response) => response.ok ? response.json() : Promise.reject()).then(setStats).catch(() => { setStats(null); setUnavailable(true); });
  }, [open, initialNetwork]);

  const network = productNetwork(selectedNetwork);
  const selected = selectPublicNetworkStats(stats, selectedNetwork);
  const loading = !stats && !unavailable;
  const value = (content: string) => loading ? '—' : content;
  const primaryActions = 'cleanActions' in selected.actions
    ? ['CLEAN ACTIONS', selected.actions.cleanActions.toLocaleString()]
    : ['BRIDGE ACTIONS', selected.actions.bridgeActions.toLocaleString()];
  const metrics = [
    ['TRANSACTIONS SPONSORED', selected.transactionsSponsored.toLocaleString()],
    primaryActions,
    ['SWAPS', selected.actions.swaps.toLocaleString()],
    ['SENDS', selected.actions.sends.toLocaleString()],
    ['CROSS-CHAIN ACTIONS', selected.actions.crossChainActions.toLocaleString()],
    ['NETWORK FEES SPONSORED', formatPublicNetworkFee(selected.networkFeesSponsored)],
    ['SUPPORTED TOKENS', selected.supportedTokens.toLocaleString()],
  ] as const;

  return (
    <aside ref={drawer} id="stats-drawer" className={`hud-drawer hud-drawer--right stats-drawer${open ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!open} aria-labelledby="stats-title" tabIndex={-1} onKeyDown={trapDrawerFocus}>
      <div className="drawer-header"><div><h2 id="stats-title">GASLESS STATS</h2><p>Live activity across GASLESS.</p></div><button type="button" aria-label="Close stats panel" onClick={onClose}>×</button></div>
      <div className="stats-network-tabs" role="tablist" aria-label="Statistics network">
        {PRODUCT_NETWORKS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={selectedNetwork === item.id} className={selectedNetwork === item.id ? 'is-active' : ''} onClick={() => setSelectedNetwork(item.id)}>{item.shortName}</button>)}
      </div>
      {unavailable && selectedNetwork === 'solana' ? <p className="drawer-intro">LIVE STATISTICS ARE TEMPORARILY UNAVAILABLE.</p> : <>
        <div className="stats-hero"><span>TOTAL GASLESS ACTIONS</span><strong className={loading ? 'is-loading' : undefined}>{value(selected.totalGaslessActions.toLocaleString())}</strong><small>{network.status === 'operational' ? 'RECONCILED ACTIVITY' : 'COMING SOON'}</small></div>
        <dl className="stats-list stats-metrics" aria-busy={loading}>
          {metrics.map(([label, content]) => <div key={label}><dt>{label}</dt><dd className={loading ? 'is-loading' : undefined}>{value(content)}</dd></div>)}
        </dl>
      </>}
    </aside>
  );
}
