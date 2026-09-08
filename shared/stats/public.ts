import type { SolanaNetwork } from '../transactions/types.js';

export type PublicStatsNetwork = 'solana' | 'robinhood' | 'base' | 'bnb';

interface PublicSharedActionFamilyCounts {
  swaps: number;
  sends: number;
  crossChainActions: number;
}

export interface PublicSolanaActionFamilyCounts extends PublicSharedActionFamilyCounts {
  cleanActions: number;
}

export interface PublicEvmActionFamilyCounts extends PublicSharedActionFamilyCounts {
  bridgeActions: number;
}

export type PublicActionFamilyCounts = PublicSolanaActionFamilyCounts | PublicEvmActionFamilyCounts;

export interface PublicNetworkFeeTotal {
  atomicAmount: string;
  decimals: number;
  symbol: string;
}

export interface PublicNetworkStats<TActions extends PublicActionFamilyCounts = PublicActionFamilyCounts> {
  totalGaslessActions: number;
  transactionsSponsored: number;
  actions: TActions;
  networkFeesSponsored: PublicNetworkFeeTotal | null;
  supportedTokens: number;
}

export interface PublicStats {
  schemaVersion: 'public-stats-v2';
  network: SolanaNetwork;
  totals: {
    successfulActions: number;
    sponsoredTransactions: number;
    sponsoredLamports: string;
    supportedTokens: number;
    byAction: Record<string, number>;
    byActionFamily: PublicSolanaActionFamilyCounts;
  };
  networks: {
    solana: PublicNetworkStats<PublicSolanaActionFamilyCounts>;
    robinhood: PublicNetworkStats<PublicEvmActionFamilyCounts>;
    base: PublicNetworkStats<PublicEvmActionFamilyCounts>;
    bnb: PublicNetworkStats<PublicEvmActionFamilyCounts>;
  };
}

export type PublicStatsResponse = Omit<Partial<PublicStats>, 'totals' | 'networks'> & {
  totals?: Partial<PublicStats['totals']>;
  networks?: Partial<Record<PublicStatsNetwork, Partial<Omit<PublicNetworkStats, 'actions' | 'networkFeesSponsored'>> & { actions?: Partial<PublicSolanaActionFamilyCounts & PublicEvmActionFamilyCounts>; networkFeesSponsored?: Partial<PublicNetworkFeeTotal> | null }>>;
};

export function emptyPublicNetworkStats(network: PublicStatsNetwork): PublicNetworkStats {
  const shared = { swaps: 0, sends: 0, crossChainActions: 0 };
  const actions: PublicActionFamilyCounts = network === 'solana' ? { cleanActions: 0, ...shared } : { bridgeActions: 0, ...shared };
  return { totalGaslessActions: 0, transactionsSponsored: 0, actions, networkFeesSponsored: null, supportedTokens: 0 };
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function actions(value: Partial<PublicSolanaActionFamilyCounts & PublicEvmActionFamilyCounts> | undefined, network: PublicStatsNetwork): PublicActionFamilyCounts {
  const shared = {
    swaps: count(value?.swaps),
    sends: count(value?.sends),
    crossChainActions: count(value?.crossChainActions),
  };
  return network === 'solana'
    ? { cleanActions: count(value?.cleanActions), ...shared }
    : { bridgeActions: count(value?.bridgeActions), ...shared };
}

function fee(value: Partial<PublicNetworkFeeTotal> | null | undefined): PublicNetworkFeeTotal | null {
  if (!value || typeof value.atomicAmount !== 'string' || !/^\d+$/.test(value.atomicAmount) || !Number.isInteger(value.decimals) || Number(value.decimals) < 0 || Number(value.decimals) > 18 || typeof value.symbol !== 'string' || !value.symbol) return null;
  return { atomicAmount: value.atomicAmount, decimals: Number(value.decimals), symbol: value.symbol };
}

export function selectPublicNetworkStats(stats: PublicStatsResponse | null, network: 'solana'): PublicNetworkStats<PublicSolanaActionFamilyCounts>;
export function selectPublicNetworkStats(stats: PublicStatsResponse | null, network: Exclude<PublicStatsNetwork, 'solana'>): PublicNetworkStats<PublicEvmActionFamilyCounts>;
export function selectPublicNetworkStats(stats: PublicStatsResponse | null, network: PublicStatsNetwork): PublicNetworkStats;
export function selectPublicNetworkStats(stats: PublicStatsResponse | null, network: PublicStatsNetwork): PublicNetworkStats {
  const selected = stats?.networks?.[network];
  if (selected) {
    const selectedActions = actions(selected.actions, network);
    return {
      totalGaslessActions: count(selected.totalGaslessActions),
      transactionsSponsored: count(selected.transactionsSponsored),
      actions: selectedActions,
      networkFeesSponsored: fee(selected.networkFeesSponsored),
      supportedTokens: count(selected.supportedTokens),
    };
  }

  if (network !== 'solana') return emptyPublicNetworkStats(network);
  const legacy = stats?.totals;
  const byAction = legacy?.byAction ?? {};
  const selectedActions = actions(legacy?.byActionFamily ?? {
    cleanActions: count(byAction.CLEAN_CLAIM) + count(byAction.CLEAN_RECOVER) + count(byAction.CLEAN_BURN),
    swaps: count(byAction.SWAP),
    sends: count(byAction.SEND),
    crossChainActions: count(byAction.CROSS_CHAIN),
  }, 'solana') as PublicSolanaActionFamilyCounts;
  const derivedTotal = selectedActions.cleanActions + selectedActions.swaps + selectedActions.sends + selectedActions.crossChainActions;
  const sponsoredLamports = typeof legacy?.sponsoredLamports === 'string' && /^\d+$/.test(legacy.sponsoredLamports) ? legacy.sponsoredLamports : '0';
  return {
    totalGaslessActions: count(legacy?.successfulActions) || derivedTotal,
    transactionsSponsored: count(legacy?.sponsoredTransactions) || count(legacy?.successfulActions),
    actions: selectedActions,
    networkFeesSponsored: { atomicAmount: sponsoredLamports, decimals: 9, symbol: 'SOL' },
    supportedTokens: count(legacy?.supportedTokens),
  };
}

export function formatPublicNetworkFee(value: PublicNetworkFeeTotal | null) {
  if (!value) return '—';
  const scale = 10n ** BigInt(value.decimals);
  const amount = BigInt(value.atomicAmount);
  const whole = amount / scale;
  const precision = Math.min(value.decimals, 5);
  if (precision === 0) return `${whole.toLocaleString()} ${value.symbol}`;
  const remainder = (amount % scale).toString().padStart(value.decimals, '0').slice(0, precision);
  return `${whole.toLocaleString()}.${remainder} ${value.symbol}`;
}
