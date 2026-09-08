export const CROSS_CHAIN_SOURCE = { id: 'solana', name: 'Solana' } as const;

export const CROSS_CHAIN_INPUT_ASSETS = [
  { symbol: 'SOL', name: 'Solana', network: 'Solana' },
  { symbol: 'USDC', name: 'USD Coin', network: 'Solana' },
  { symbol: 'USDT', name: 'Tether', network: 'Solana' },
] as const;

const ROBINHOOD_OUTPUT_ASSETS = [
  { symbol: 'ETH', name: 'Ether', network: 'Robinhood Chain' },
  { symbol: 'USDG', name: 'Global Dollar', network: 'Robinhood Chain' },
] as const;

export const CROSS_CHAIN_DESTINATIONS = [
  { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, enabled: true, outputs: ROBINHOOD_OUTPUT_ASSETS },
  { id: 'base', name: 'Base', enabled: false, outputs: [] },
  { id: 'bnb', name: 'BNB Chain', enabled: false, outputs: [] },
] as const;

export const CROSS_CHAIN_OUTPUT_ASSETS = CROSS_CHAIN_DESTINATIONS[0].outputs;

export type CrossChainInputAsset = (typeof CROSS_CHAIN_INPUT_ASSETS)[number]['symbol'];
export type CrossChainOutputAsset = (typeof CROSS_CHAIN_OUTPUT_ASSETS)[number]['symbol'];
export type CrossChainDestinationId = (typeof CROSS_CHAIN_DESTINATIONS)[number]['id'];
