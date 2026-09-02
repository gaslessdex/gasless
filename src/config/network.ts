import { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains';

export type AppNetwork = 'devnet' | 'mainnet-beta';

function readAppNetwork(): AppNetwork {
  const configured = import.meta.env.VITE_APP_NETWORK?.trim();

  if (!configured) return 'devnet';
  if (configured === 'devnet' || configured === 'mainnet-beta') return configured;

  throw new Error(`Unsupported VITE_APP_NETWORK: ${configured}`);
}

export const appNetwork = readAppNetwork();
const appOperatingMode = import.meta.env.VITE_APP_OPERATING_MODE?.trim() || 'devnet';
if (!['devnet', 'private-mainnet'].includes(appOperatingMode) || (appOperatingMode === 'private-mainnet') !== (appNetwork === 'mainnet-beta')) throw new Error('VITE_APP_OPERATING_MODE does not match VITE_APP_NETWORK.');
export const appNetworkLabel = appOperatingMode === 'private-mainnet' ? 'PRIVATE MAINNET' : 'DEVNET';
export const walletChain = appNetwork === 'devnet' ? SOLANA_DEVNET_CHAIN : SOLANA_MAINNET_CHAIN;
export function explorerTransactionUrl(signature: string) {
  const cluster = appNetwork === 'devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}
