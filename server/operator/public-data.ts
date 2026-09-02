import type { SolanaNetwork } from '../../shared/transactions/types.js';
import type { DurableStore } from '../storage/durable.js';

type OperatorMetrics = Awaited<ReturnType<DurableStore['getOperatorMetrics']>>;

export function buildPublicStats(visible: boolean, network: SolanaNetwork, metrics?: OperatorMetrics, supportedTokens = 0, scope: 'public' | 'local-private-pilot' = 'public') {
  if (!visible || !metrics) return { visible: false as const, reason: 'private-pilot' as const };
  return {
    visible: true as const,
    network,
    scope,
    totals: { successfulActions: metrics.successCount, uniqueWallets: metrics.uniqueWalletCount, sponsoredLamports: metrics.sponsoredLamports, supportedTokens, byAction: metrics.successfulByAction },
  };
}
