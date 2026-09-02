import type { WalletConnectorId, WalletConnectorMetadata } from '@solana/connector/react';

export const RECENT_WALLET_KEY = 'gasless:last-wallet-connector';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readRecentConnector(storage: PreferenceStorage): WalletConnectorId | null {
  const value = storage.getItem(RECENT_WALLET_KEY)?.trim();
  return value ? value as WalletConnectorId : null;
}

export function rememberSuccessfulConnector(storage: PreferenceStorage, connectorId: WalletConnectorId) {
  storage.setItem(RECENT_WALLET_KEY, connectorId);
}

export function rememberConnectedConnector(storage: PreferenceStorage, status: string, connectorId: WalletConnectorId | null) {
  if (status !== 'connected' || !connectorId) return false;
  rememberSuccessfulConnector(storage, connectorId);
  return true;
}

export function filterWalletConnectors(connectors: WalletConnectorMetadata[], query: string) {
  const normalized = query.trim().toLowerCase();
  return connectors.filter((connector) => connector.ready && (!normalized || connector.name.toLowerCase().includes(normalized)));
}
