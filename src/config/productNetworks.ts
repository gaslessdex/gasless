import type { Feature } from '../types/app.js';

export type ProductNetworkId = 'solana' | 'robinhood' | 'base' | 'bnb';
export type ProductEcosystem = 'svm' | 'evm';

export interface ProductNetwork {
  id: ProductNetworkId;
  displayName: string;
  shortName: string;
  ecosystem: ProductEcosystem;
  status: 'operational' | 'coming-soon';
  productionFunctional: boolean;
  actions: readonly Feature[];
}

export const PRODUCT_NETWORKS: readonly ProductNetwork[] = [
  { id: 'solana', displayName: 'Solana', shortName: 'SOLANA', ecosystem: 'svm', status: 'operational', productionFunctional: true, actions: ['claim', 'swap', 'send'] },
  { id: 'robinhood', displayName: 'Robinhood Chain', shortName: 'ROBINHOOD', ecosystem: 'evm', status: 'coming-soon', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
  { id: 'base', displayName: 'Base', shortName: 'BASE', ecosystem: 'evm', status: 'coming-soon', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
  { id: 'bnb', displayName: 'BNB Chain', shortName: 'BNB', ecosystem: 'evm', status: 'coming-soon', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
];

export const DEFAULT_PRODUCT_NETWORK = PRODUCT_NETWORKS[0];

export function productNetwork(id: ProductNetworkId) {
  return PRODUCT_NETWORKS.find((network) => network.id === id) ?? DEFAULT_PRODUCT_NETWORK;
}
