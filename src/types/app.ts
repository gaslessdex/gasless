export type Feature = 'claim' | 'swap' | 'send';
export type Theme = 'light' | 'dark';

export const FEATURE_COPY: Record<Feature, { index: string; description: string }> = {
  claim: { index: '01', description: 'Recover SOL locked in unused token accounts.' },
  swap: { index: '02', description: 'Swap supported tokens without holding SOL.' },
  send: { index: '03', description: 'Send supported tokens even with zero SOL.' },
};
