import type { WalletConnectorId, WalletConnectorMetadata } from '@solana/connector/react';

export type WalletEcosystem = 'solana' | 'evm';

export type WalletDirectoryEntry = {
  id: string;
  name: string;
  aliases?: string[];
  icon?: string;
  ecosystems: WalletEcosystem[];
  installUrl?: string;
  homepageUrl?: string;
  supportsWalletStandard?: boolean;
  supportsWalletConnect?: boolean;
  supportsMobileHandoff?: boolean;
  featured?: boolean;
};

// Descriptive catalog only. ConnectorKit remains the authority for whether a
// wallet is present and connectable in the current browser.
export const SOLANA_WALLET_DIRECTORY: readonly WalletDirectoryEntry[] = [
  { id: 'backpack', name: 'Backpack', ecosystems: ['solana', 'evm'], installUrl: 'https://backpack.app/download', homepageUrl: 'https://backpack.app/', supportsWalletStandard: true, featured: true },
  { id: 'jupiter', name: 'Jupiter Wallet', aliases: ['Jupiter Extension'], ecosystems: ['solana'], installUrl: 'https://jup.ag/wallet', homepageUrl: 'https://jup.ag/wallet', supportsWalletStandard: true, featured: true },
  { id: 'glow', name: 'Glow', ecosystems: ['solana'], installUrl: 'https://glow.app/', homepageUrl: 'https://glow.app/', supportsWalletStandard: true },
  { id: 'nightly', name: 'Nightly', ecosystems: ['solana'], installUrl: 'https://wallet.nightly.app/', homepageUrl: 'https://wallet.nightly.app/', supportsWalletStandard: true },
  { id: 'exodus', name: 'Exodus', ecosystems: ['solana', 'evm'], installUrl: 'https://www.exodus.com/solana-wallet', homepageUrl: 'https://www.exodus.com/solana-wallet', supportsWalletStandard: true, supportsWalletConnect: true },
  { id: 'trust', name: 'Trust Wallet', ecosystems: ['solana', 'evm'], installUrl: 'https://trustwallet.com/browser-extension', homepageUrl: 'https://trustwallet.com/', supportsWalletStandard: true },
  { id: 'coinbase', name: 'Coinbase Wallet', aliases: ['Coinbase', 'Base', 'Base Wallet'], ecosystems: ['solana', 'evm'], installUrl: 'https://www.coinbase.com/wallet/downloads', homepageUrl: 'https://www.coinbase.com/wallet/downloads', supportsMobileHandoff: true },
  { id: 'brave', name: 'Brave Wallet', aliases: ['Brave'], ecosystems: ['solana', 'evm'], installUrl: 'https://brave.com/wallet/', homepageUrl: 'https://brave.com/wallet/', supportsWalletStandard: true },
  { id: 'metamask', name: 'MetaMask', ecosystems: ['solana', 'evm'], installUrl: 'https://metamask.io/download/', homepageUrl: 'https://metamask.io/', supportsWalletStandard: true },
  { id: 'okx', name: 'OKX Wallet', aliases: ['OKX'], ecosystems: ['solana', 'evm'], installUrl: 'https://web3.okx.com/download', homepageUrl: 'https://web3.okx.com/', supportsWalletStandard: true },
  { id: 'ledger', name: 'Ledger', ecosystems: ['solana', 'evm'], installUrl: 'https://www.ledger.com/coin/wallet/solana', homepageUrl: 'https://www.ledger.com/coin/wallet/solana' },
  { id: 'bitget', name: 'Bitget Wallet', aliases: ['BitKeep'], ecosystems: ['solana', 'evm'], installUrl: 'https://web3.bitget.com/wallet', homepageUrl: 'https://web3.bitget.com/wallet', supportsWalletStandard: true },
  { id: 'safepal', name: 'SafePal', ecosystems: ['solana', 'evm'], installUrl: 'https://www.safepal.com/en/download', homepageUrl: 'https://www.safepal.com/en/' },
  { id: 'tokenpocket', name: 'TokenPocket', ecosystems: ['solana', 'evm'], installUrl: 'https://www.tokenpocket.pro/', homepageUrl: 'https://www.tokenpocket.pro/', supportsMobileHandoff: true },
  { id: 'mathwallet', name: 'MathWallet', aliases: ['Math Wallet'], ecosystems: ['solana', 'evm'], installUrl: 'https://www.mathwallet.org/en-us/', homepageUrl: 'https://www.mathwallet.org/en-us/', supportsWalletConnect: true },
  { id: 'coin98', name: 'Coin98', ecosystems: ['solana', 'evm'], installUrl: 'https://coin98.com/wallet', homepageUrl: 'https://coin98.com/wallet', supportsWalletStandard: true },
  { id: 'phantom', name: 'Phantom', ecosystems: ['solana', 'evm'], installUrl: 'https://phantom.com/download', homepageUrl: 'https://phantom.com/', supportsWalletStandard: true, featured: true },
  { id: 'solflare', name: 'Solflare', ecosystems: ['solana'], installUrl: 'https://www.solflare.com/', homepageUrl: 'https://www.solflare.com/', supportsWalletStandard: true, featured: true },
  { id: 'walletconnect', name: 'WalletConnect', ecosystems: ['solana', 'evm'], supportsWalletConnect: true, supportsMobileHandoff: true },
] as const;

function normalizeWalletName(value: string) {
  return value.toLowerCase().replace(/wallet-standard:/g, '').replace(/\b(wallet|extension|app)\b/g, '').replace(/[^a-z0-9]/g, '');
}

export function walletEntryMatchesConnector(entry: WalletDirectoryEntry, connector: Pick<WalletConnectorMetadata, 'id' | 'name'>) {
  const connectorValues = [String(connector.id), connector.name].map(normalizeWalletName);
  const entryValues = [entry.id, entry.name, ...(entry.aliases ?? [])].map(normalizeWalletName);
  return connectorValues.some((connectorValue) => entryValues.some((entryValue) => connectorValue === entryValue));
}

export function connectorForWallet(entry: WalletDirectoryEntry, connectors: readonly WalletConnectorMetadata[]) {
  return connectors.find((connector) => connector.ready && walletEntryMatchesConnector(entry, connector)) ?? null;
}

export function filterWalletDirectory(entries: readonly WalletDirectoryEntry[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) => [entry.name, ...(entry.aliases ?? [])].some((value) => value.toLowerCase().includes(normalized)));
}

export function orderWalletDirectory(entries: readonly WalletDirectoryEntry[], connectors: readonly WalletConnectorMetadata[]) {
  return entries.map((entry, index) => ({ entry, index, detected: entry.id !== 'walletconnect' && Boolean(connectorForWallet(entry, connectors)) }))
    .sort((left, right) => {
      if (left.entry.id === 'walletconnect') return 1;
      if (right.entry.id === 'walletconnect') return -1;
      if (left.detected !== right.detected) return left.detected ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function directoryWalletState(entry: WalletDirectoryEntry, connector: WalletConnectorMetadata | null, recentConnectorId: WalletConnectorId | null) {
  if (entry.id === 'walletconnect') return connector ? 'QR / MOBILE' : 'UNAVAILABLE';
  if (connector?.id === recentConnectorId) return 'RECENT';
  if (connector) return /mobile wallet adapter/i.test(connector.name) ? 'READY' : 'INSTALLED';
  if (entry.installUrl || entry.homepageUrl) return 'INSTALL / OPEN';
  return 'UNAVAILABLE';
}

export function officialWalletUrl(entry: WalletDirectoryEntry) {
  const candidate = entry.installUrl ?? entry.homepageUrl;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
