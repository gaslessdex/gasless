export type Feature = 'claim' | 'bridge' | 'swap' | 'send';
export type Theme = 'light' | 'dark';

export const FEATURE_COPY: Record<Feature, { title: string; description: string }> = {
  claim: { title: 'CLEAN', description: 'Recover SOL locked in unused token accounts.' },
  bridge: { title: 'BRIDGE', description: 'Move supported assets between networks without keeping gas tokens.' },
  swap: { title: 'SWAP', description: 'Swap supported tokens without holding the network gas token.' },
  send: { title: 'SEND', description: 'Send supported tokens without holding the network gas token.' },
};
