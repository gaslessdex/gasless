import { getDefaultConfig, getDefaultMobileConfig, type MobileWalletAdapterConfig, type WalletConnectorMetadata } from '@solana/connector/react';
type AppNetwork = 'devnet' | 'mainnet-beta';

export type WalletBrowserLink = { id: 'phantom-browser' | 'solflare-browser'; name: string; href: string };

export function createWalletConnectorConfig(origin: string, network: AppNetwork, debug = false, walletConnectProjectId = '') {
  const projectId = walletConnectProjectId.trim();
  const config = getDefaultConfig({
    appName: 'GASLESS',
    appUrl: origin,
    autoConnect: false,
    debug,
    network,
    walletConnect: projectId ? { projectId } : undefined,
  });
  const defaults = getDefaultMobileConfig({ appName: 'GASLESS', appUrl: origin, network });
  const mobile: MobileWalletAdapterConfig = {
    appIdentity: { ...defaults.appIdentity, icon: '/favicon.svg' },
    chains: [network === 'devnet' ? 'solana:devnet' : 'solana:mainnet'],
  };
  return { config, mobile };
}

export const CONNECTION_TIMEOUT_MS = 20_000;
export const WALLETCONNECT_TIMEOUT_MS = 120_000;

export function isWalletConnectPairingUri(uri: string | null): uri is string {
  return Boolean(uri?.startsWith('wc:'));
}

export function isWalletConnectConnector(connector: Pick<WalletConnectorMetadata, 'id' | 'name'>) {
  const id = String(connector.id).toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = connector.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return id.includes('walletconnect') || name === 'walletconnect';
}

export function createWalletBrowserLinks(pageUrl: string, mobile: boolean): WalletBrowserLink[] {
  if (!mobile) return [];
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'https:') return [];
    const target = encodeURIComponent(page.href);
    const referrer = encodeURIComponent(page.origin);
    return [
      { id: 'phantom-browser', name: 'Phantom', href: `https://phantom.app/ul/browse/${target}?ref=${referrer}` },
      { id: 'solflare-browser', name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${target}?ref=${referrer}` },
    ];
  } catch {
    return [];
  }
}

export function safeWalletIcon(icon: string) {
  return /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(icon) ? icon : null;
}
