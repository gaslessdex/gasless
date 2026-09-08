import type { SolanaNetwork } from '../../shared/transactions/types.js';
import type { PublicActionFamilyCounts, PublicEvmActionFamilyCounts, PublicNetworkStats, PublicSolanaActionFamilyCounts, PublicStats } from '../../shared/stats/public.js';
import type { DurableStore } from '../storage/durable.js';

type OperatorMetrics = Awaited<ReturnType<DurableStore['getOperatorMetrics']>>;

const ROBINHOOD_CHAIN_ID = '4663';

function solanaActionFamilies(byAction: Record<string, number>): PublicSolanaActionFamilyCounts {
  return {
    cleanActions: (byAction.CLEAN_CLAIM ?? 0) + (byAction.CLEAN_RECOVER ?? 0) + (byAction.CLEAN_BURN ?? 0),
    swaps: byAction.SWAP ?? 0,
    sends: byAction.SEND ?? 0,
    crossChainActions: byAction.CROSS_CHAIN ?? 0,
  };
}

function evmActionFamilies(crossChainActions = 0): PublicEvmActionFamilyCounts {
  return { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions };
}

function networkStats<TActions extends PublicActionFamilyCounts>(actions: TActions, values: Pick<PublicNetworkStats, 'transactionsSponsored' | 'networkFeesSponsored' | 'supportedTokens'>): PublicNetworkStats<TActions> {
  const primaryActions = 'cleanActions' in actions ? actions.cleanActions : actions.bridgeActions;
  return { totalGaslessActions: primaryActions + actions.swaps + actions.sends + actions.crossChainActions, actions, ...values };
}

export function buildPublicStats(network: SolanaNetwork, metrics: OperatorMetrics, supportedTokens = 0): PublicStats {
  const solanaActions = solanaActionFamilies(metrics.successfulLogicalByAction);
  const crossChainForRobinhood = metrics.successfulLogicalCrossChainByDestination[ROBINHOOD_CHAIN_ID] ?? 0;
  const networks: PublicStats['networks'] = {
    solana: networkStats(solanaActions, { transactionsSponsored: metrics.publicSponsoredTransactions, networkFeesSponsored: { atomicAmount: metrics.publicSponsoredLamports, decimals: 9, symbol: 'SOL' }, supportedTokens }),
    robinhood: networkStats(evmActionFamilies(crossChainForRobinhood), { transactionsSponsored: 0, networkFeesSponsored: null, supportedTokens: 0 }),
    base: networkStats(evmActionFamilies(), { transactionsSponsored: 0, networkFeesSponsored: null, supportedTokens: 0 }),
    bnb: networkStats(evmActionFamilies(), { transactionsSponsored: 0, networkFeesSponsored: null, supportedTokens: 0 }),
  };
  return {
    schemaVersion: 'public-stats-v2',
    network,
    totals: { successfulActions: networks.solana.totalGaslessActions, sponsoredTransactions: networks.solana.transactionsSponsored, sponsoredLamports: metrics.publicSponsoredLamports, supportedTokens, byAction: metrics.successfulByAction, byActionFamily: solanaActions },
    networks,
  };
}
