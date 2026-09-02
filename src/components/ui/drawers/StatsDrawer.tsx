import { useEffect, useState } from 'react';

interface PublicStats { visible: boolean; reason?: string; network?: string; scope?: 'public' | 'local-private-pilot'; totals?: { successfulActions: number; uniqueWallets: number; sponsoredLamports: string; supportedTokens: number; byAction: Record<string, number> } }

export function StatsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [stats, setStats] = useState<PublicStats | null>(null);
  useEffect(() => { if (open) fetch('/api/public/stats').then((response) => response.ok ? response.json() : Promise.reject()).then(setStats).catch(() => setStats(null)); }, [open]);
  const actions = stats?.totals?.byAction ?? {};
  return (
    <aside id="stats-drawer" className={`hud-drawer hud-drawer--right${open ? ' is-open' : ''}`} aria-hidden={!open} aria-label="GASLESS statistics availability">
      <div className="drawer-header"><div><span>02 / TELEMETRY</span><h2>GASLESS STATS</h2></div><button type="button" aria-label="Close stats drawer" onClick={onClose}>×</button></div>
      {!stats ? <p className="drawer-intro">LIVE GASLESS STATISTICS ARE TEMPORARILY UNAVAILABLE.</p> : !stats.visible ? <p className="drawer-intro">VERIFIED PRIVATE-PILOT ACTIVITY IS HIDDEN UNTIL THE PUBLIC STATS SWITCH IS ENABLED.</p> : <>
        <p className="drawer-intro">{stats.scope === 'local-private-pilot' ? 'REAL PRIVATE-PILOT RESULTS FROM RECONCILED MAINNET ACTIVITY.' : 'REAL, NETWORK-SCOPED COUNTS FROM RECONCILED GASLESS ACTIVITY.'}</p>
        <dl className="stats-list">
          <div><dt>SUCCESSFUL ACTIONS</dt><dd>{stats.totals?.successfulActions ?? 0}</dd></div>
          <div><dt>SOL SPONSORED</dt><dd>{(Number(stats.totals?.sponsoredLamports ?? 0) / 1e9).toFixed(5)}</dd></div>
          <div><dt>UNIQUE WALLETS</dt><dd>{stats.totals?.uniqueWallets ?? 0}</dd></div>
          <div><dt>SUPPORTED TOKENS</dt><dd>{stats.totals?.supportedTokens ?? 0}</dd></div>
          <div><dt>CLAIM</dt><dd>{actions.CLEAN_CLAIM ?? 0}</dd></div><div><dt>BURN</dt><dd>{actions.CLEAN_BURN ?? 0}</dd></div>
          <div><dt>RECOVER</dt><dd>{actions.CLEAN_RECOVER ?? 0}</dd></div><div><dt>SEND</dt><dd>{actions.SEND ?? 0}</dd></div><div><dt>SWAP</dt><dd>{actions.SWAP ?? 0}</dd></div>
        </dl>
      </>}
      <div className="drawer-footer"><i /><span>{stats?.visible ? `${stats.scope === 'local-private-pilot' ? 'LOCAL PILOT' : stats.network} / VERIFIED DATA` : 'PRIVATE PILOT / HIDDEN'}</span></div>
    </aside>
  );
}
