import { createContext, useContext } from 'react';
import type { WalletAccount } from '@wallet-standard/base';

export type WalletContextValue = {
  account: WalletAccount | null;
  connected: boolean;
  connecting: boolean;
  error: string;
  wallet: { name: string; icon: string | null } | null;
  requestConnection: () => void;
  disconnect: () => Promise<void>;
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
};

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used inside WalletProvider.');
  return context;
}

export function formatWalletAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
