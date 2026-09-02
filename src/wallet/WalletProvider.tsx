import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AppProvider,
  useConnectWallet,
  useDisconnectWallet,
  useConnectorClient,
  useWallet as useConnectorWallet,
  useWalletConnectors,
  useWalletConnectUri,
  type WalletConnectorId,
  type WalletConnectorMetadata,
} from '@solana/connector/react';
import { QRCodeSVG } from 'qrcode.react';
import { appNetwork } from '../config/network';
import { CONNECTION_TIMEOUT_MS, createWalletBrowserLinks, createWalletConnectorConfig, isWalletConnectConnector, isWalletConnectPairingUri, safeWalletIcon, WALLETCONNECT_TIMEOUT_MS } from './connectorConfig';
import { connectorForWallet, directoryWalletState, filterWalletDirectory, officialWalletUrl, orderWalletDirectory, SOLANA_WALLET_DIRECTORY, walletEntryMatchesConnector, type WalletDirectoryEntry } from './walletDirectory';
import { transitionWalletDialog, type WalletDialogAction, type WalletDialogView } from './walletDialogState';
import { filterWalletConnectors, readRecentConnector, rememberConnectedConnector } from './walletPreferences';
import { formatWalletAddress, WalletContext, type WalletContextValue } from './walletContext';
import { signWalletStandardTransaction, walletChainForNetwork } from './walletStandardSigning';

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? '';
const { config: connectorConfig, mobile: mobileConfig } = createWalletConnectorConfig(
  window.location.origin,
  appNetwork,
  import.meta.env.DEV,
  walletConnectProjectId,
);

function connectionErrorMessage(error: unknown, walletName: string) {
  const message = error instanceof Error ? error.message : '';
  if (/reject|declin|denied|cancel/i.test(message)) return 'Connection cancelled.';
  return `Could not connect to ${walletName}. Unlock the wallet and try again.`;
}

function noWalletMessage() {
  const mobile = matchMedia('(pointer: coarse)').matches;
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  if (android) return 'Install or open a compatible Solana wallet, then try again.';
  if (ios) return 'Try a WalletConnect wallet or a browser with Solana wallet support.';
  if (mobile) return 'Open GASLESS in a compatible wallet or browser, then try again.';
  return 'Install or enable a compatible Solana wallet extension, then try again.';
}

function readyConnectorLabel(connector: Pick<WalletConnectorMetadata, 'name'>) {
  return /mobile wallet adapter/i.test(connector.name) ? 'READY' : 'INSTALLED';
}

function WalletRow({ connector, connecting, label, onConnect }: {
  connector: WalletConnectorMetadata;
  connecting: boolean;
  label: string;
  onConnect: (connectorId: WalletConnectorId) => void;
}) {
  const icon = safeWalletIcon(connector.icon);
  return <button type="button" aria-busy={connecting} onClick={() => onConnect(connector.id)}>
    {icon ? <img src={icon} alt="" /> : <span className="wallet-monogram" aria-hidden="true">{connector.name.slice(0, 1)}</span>}
    <span><strong>{connector.name}</strong><small>{connecting ? 'CONNECTING...' : label}</small></span>
  </button>;
}

function DirectoryWalletIcon({ entry }: { entry: WalletDirectoryEntry }) {
  const [failed, setFailed] = useState(false);
  return failed || !entry.icon
    ? <span className="wallet-monogram" aria-hidden="true">{entry.name.slice(0, 1)}</span>
    : <img src={entry.icon} alt="" onError={() => setFailed(true)} />;
}

function DirectoryWalletRow({ entry, connector, connecting, recentConnectorId, onConnect }: {
  entry: WalletDirectoryEntry;
  connector: WalletConnectorMetadata | null;
  connecting: boolean;
  recentConnectorId: WalletConnectorId | null;
  onConnect: (connectorId: WalletConnectorId) => void;
}) {
  const state = directoryWalletState(entry, connector, recentConnectorId);
  if (connector) return <WalletRow connector={connector} connecting={connecting} label={state} onConnect={onConnect} />;
  const href = officialWalletUrl(entry);
  const content = <><DirectoryWalletIcon entry={entry} /><span><strong>{entry.name}</strong><small>{state}</small></span></>;
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{content}</a>
    : <button type="button" disabled>{content}</button>;
}

function GaslessWalletBridge({ children }: { children: ReactNode }) {
  const connectors = useWalletConnectors();
  const walletState = useConnectorWallet();
  const connectorClient = useConnectorClient();
  const { connect: connectWallet, isConnecting, error: connectorError, resetError } = useConnectWallet();
  const { disconnect: disconnectWallet } = useDisconnectWallet();
  const { uri: walletConnectUri, clearUri: clearWalletConnectUri } = useWalletConnectUri();
  const [dialogView, setDialogView] = useState<WalletDialogView>('closed');
  const [query, setQuery] = useState('');
  const [selectedConnectorId, setSelectedConnectorId] = useState<WalletConnectorId | null>(null);
  const [recentConnectorId, setRecentConnectorId] = useState<WalletConnectorId | null>(() => readRecentConnector(localStorage));
  const [localError, setLocalError] = useState('');
  const [walletConnectRetryAvailable, setWalletConnectRetryAvailable] = useState(false);
  const walletBrowserLinks = useMemo(() => createWalletBrowserLinks(window.location.href, matchMedia('(pointer: coarse)').matches), []);
  const compatibleConnectors = useMemo(() => connectors.filter((item) => item.ready), [connectors]);
  const recentConnector = compatibleConnectors.find((item) => item.id === recentConnectorId && !isWalletConnectConnector(item)) ?? null;
  const detectedConnectors = compatibleConnectors.filter((item) => item.id !== recentConnectorId && !isWalletConnectConnector(item));
  const walletConnectConnector = compatibleConnectors.find(isWalletConnectConnector) ?? null;
  const matchingWalletDirectory = useMemo(() => orderWalletDirectory(filterWalletDirectory(SOLANA_WALLET_DIRECTORY, query), compatibleConnectors), [compatibleConnectors, query]);
  const moreConnectors = filterWalletConnectors(compatibleConnectors.filter((connector) => !SOLANA_WALLET_DIRECTORY.some((entry) => walletEntryMatchesConnector(entry, connector))), query);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingWalletBrowserLinks = walletBrowserLinks.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));
  const activeConnector = compatibleConnectors.find((item) => item.id === walletState.connectorId) ?? null;
  const selectedConnector = compatibleConnectors.find((item) => item.id === selectedConnectorId) ?? null;
  const connecting = walletState.isConnecting || isConnecting;
  const account = walletState.status === 'connected' ? walletState.session?.selectedAccount.account ?? null : null;
  const walletConnectPairingUri = isWalletConnectPairingUri(walletConnectUri) ? walletConnectUri : null;
  const dialogOpen = dialogView !== 'closed';
  const showMore = dialogView === 'directory';
  const showWalletConnect = dialogView === 'walletconnect';
  const changeDialogView = useCallback((action: WalletDialogAction) => {
    setDialogView((current) => transitionWalletDialog(current, action));
  }, []);

  const cleanupConnection = useCallback(async () => {
    clearWalletConnectUri();
    try { await disconnectWallet(); } catch { /* The local state still resets below. */ }
  }, [clearWalletConnectUri, disconnectWallet]);

  const connect = useCallback(async (connectorId: WalletConnectorId) => {
    const connector = compatibleConnectors.find((item) => item.id === connectorId);
    if (!connector) return;
    setSelectedConnectorId(connectorId);
    setWalletConnectRetryAvailable(false);
    setLocalError('');
    const isWalletConnect = isWalletConnectConnector(connector);
    if (isWalletConnect) changeDialogView('show-walletconnect');
    resetError();
    try {
      await connectWallet(connectorId, { silent: false, allowInteractiveFallback: false });
    } catch (error) {
      setLocalError(connectionErrorMessage(error, connector.name));
      setSelectedConnectorId(null);
      if (isWalletConnect) {
        setWalletConnectRetryAvailable(true);
        await cleanupConnection();
      }
    }
  }, [changeDialogView, cleanupConnection, compatibleConnectors, connectWallet, resetError]);

  const cancelConnection = useCallback(async () => {
    setSelectedConnectorId(null);
    setWalletConnectRetryAvailable(false);
    setLocalError('');
    await cleanupConnection();
  }, [cleanupConnection]);

  const closeDialog = useCallback(() => {
    if (connecting || selectedConnectorId || walletConnectUri) void cancelConnection();
    changeDialogView('close');
    setQuery('');
  }, [cancelConnection, changeDialogView, connecting, selectedConnectorId, walletConnectUri]);

  const leaveDirectory = useCallback(() => {
    if (connecting || selectedConnectorId || walletConnectUri) void cancelConnection();
    changeDialogView('back');
    setQuery('');
  }, [cancelConnection, changeDialogView, connecting, selectedConnectorId, walletConnectUri]);

  const leaveWalletConnect = useCallback(() => {
    if (connecting || selectedConnectorId || walletConnectUri) void cancelConnection();
    changeDialogView('back');
  }, [cancelConnection, changeDialogView, connecting, selectedConnectorId, walletConnectUri]);

  const cancelWalletConnect = useCallback(async () => {
    await cancelConnection();
    changeDialogView('back');
  }, [cancelConnection, changeDialogView]);

  const disconnect = useCallback(async () => {
    changeDialogView('close');
    await cancelConnection();
  }, [cancelConnection, changeDialogView]);

  useEffect(() => {
    if (!connecting || !selectedConnector) return;
    const isWalletConnect = isWalletConnectConnector(selectedConnector);
    const timeout = isWalletConnect ? WALLETCONNECT_TIMEOUT_MS : CONNECTION_TIMEOUT_MS;
    const timer = window.setTimeout(() => {
      setLocalError(isWalletConnect ? 'WalletConnect pairing expired. Start a new QR code.' : `Could not connect to ${selectedConnector.name}. Unlock the wallet and try again.`);
      setWalletConnectRetryAvailable(isWalletConnect);
      setSelectedConnectorId(null);
      void cleanupConnection();
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [cleanupConnection, connecting, selectedConnector]);

  useEffect(() => {
    if (!dialogOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeDialog(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [closeDialog, dialogOpen]);

  useEffect(() => {
    if (!rememberConnectedConnector(localStorage, walletState.status, walletState.connectorId)) return;
    setRecentConnectorId(walletState.connectorId);
    setSelectedConnectorId(null);
    setWalletConnectRetryAvailable(false);
    setLocalError('');
    clearWalletConnectUri();
    changeDialogView('close');
  }, [changeDialogView, clearWalletConnectUri, walletState.connectorId, walletState.status]);

  const signTransaction = useCallback(async (transaction: Uint8Array) => {
    window.performance?.mark('gasless-wallet:T5-live-account-reread');
    const snapshot = connectorClient?.getSnapshot();
    const selectedWallet = snapshot?.selectedWallet;
    const currentAccount = snapshot?.wallet.status === 'connected' ? snapshot.wallet.session.selectedAccount.account : null;
    if (!selectedWallet || !account || !currentAccount || currentAccount.address !== account.address || !activeConnector) throw new Error('The connected wallet cannot sign Solana transactions.');
    window.performance?.mark('gasless-wallet:T6-sign-transaction-invoke');
    return signWalletStandardTransaction({ wallet: selectedWallet, account: currentAccount, transaction, chain: walletChainForNetwork(appNetwork), connectorName: activeConnector.name });
  }, [account, activeConnector, connectorClient]);

  const error = localError || (connectorError ? connectionErrorMessage(connectorError, selectedConnector?.name ?? 'wallet') : '');
  const value = useMemo<WalletContextValue>(() => ({
    account,
    connected: Boolean(account),
    connecting,
    error,
    wallet: activeConnector ? { name: activeConnector.name, icon: safeWalletIcon(activeConnector.icon) } : null,
    requestConnection: () => { setLocalError(''); setWalletConnectRetryAvailable(false); setQuery(''); resetError(); changeDialogView('open'); },
    disconnect,
    signTransaction,
  }), [account, activeConnector, changeDialogView, connecting, disconnect, error, resetError, signTransaction]);

  return <WalletContext.Provider value={value}>
    {children}
    {dialogOpen && <div className="wallet-dialog-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title" onPointerDown={(event) => event.stopPropagation()}>
        <header><div><small>SOLANA WALLETS</small><h2 id="wallet-dialog-title">{account ? 'Wallet connected' : showMore || showWalletConnect ? 'Select wallet' : 'Connect wallet'}</h2></div><button type="button" aria-label="Close wallet dialog" onClick={closeDialog}>&times;</button></header>
        {account ? <div className="connected-wallet">
          <span>{activeConnector?.name ?? 'CONNECTED ACCOUNT'}</span><strong>{formatWalletAddress(account.address)}</strong>
          <button type="button" onClick={() => void navigator.clipboard.writeText(account.address)}>COPY ADDRESS</button>
          <button type="button" onClick={() => void disconnect()}>DISCONNECT</button>
        </div> : showWalletConnect ? <div className="wallet-more wallet-more--qr">
          <button className="wallet-back" type="button" onClick={leaveWalletConnect}>&larr; BACK</button>
          {walletConnectPairingUri ? <div className="wallet-qr"><QRCodeSVG value={walletConnectPairingUri} size={220} /><strong>SCAN WITH A COMPATIBLE WALLET</strong><small>Use a WalletConnect-compatible mobile wallet to scan this QR.</small><button type="button" onClick={() => void cancelWalletConnect()}>CANCEL</button></div> : <div className="wallet-qr-status"><strong>{connecting ? 'CREATING SECURE QR...' : 'PAIRING IS NOT ACTIVE'}</strong><small>{walletConnectRetryAvailable ? 'The previous pairing ended. Start a fresh QR code.' : 'WalletConnect is preparing a new pairing code.'}</small></div>}
          {walletConnectRetryAvailable && walletConnectConnector && <button className="wallet-retry" type="button" onClick={() => void connect(walletConnectConnector.id)}>RETRY WALLETCONNECT</button>}
          {!walletConnectProjectId && <p className="wallet-setup-note">WalletConnect QR will be available after its project ID is configured.</p>}
        </div> : showMore ? <div className="wallet-more">
          <button className="wallet-back" type="button" onClick={leaveDirectory}>&larr; BACK</button>
          <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search wallets..." aria-label="Search wallets" />
          <div className="wallet-directory-scroll"><div className="wallet-directory"><small>AVAILABLE WALLETS</small><div className="wallet-list">
              {moreConnectors.map((item) => <WalletRow key={item.id} connector={item} connecting={connecting && selectedConnectorId === item.id} label={item.id === recentConnectorId ? 'RECENT' : readyConnectorLabel(item)} onConnect={(id) => void connect(id)} />)}
              {matchingWalletDirectory.map((entry) => {
                const connector = connectorForWallet(entry, compatibleConnectors);
                return <DirectoryWalletRow key={entry.id} entry={entry} connector={connector} connecting={Boolean(connector && connecting && selectedConnectorId === connector.id)} recentConnectorId={recentConnectorId} onConnect={(id) => void connect(id)} />;
              })}
            </div></div>
            {matchingWalletBrowserLinks.length > 0 && <div className="wallet-directory"><small>OPEN IN WALLET APP</small><div className="wallet-list">
              {matchingWalletBrowserLinks.map((item) => <a key={item.id} href={item.href} target="_blank" rel="noopener noreferrer"><span className="wallet-monogram" aria-hidden="true">{item.name.slice(0, 1)}</span><span><strong>{item.name}</strong><small>OPEN IN WALLET</small></span></a>)}
            </div></div>}
          </div>
          {!matchingWalletDirectory.length && !moreConnectors.length && !matchingWalletBrowserLinks.length && <div className="wallet-empty"><strong>NO MATCHING WALLET</strong><p>{noWalletMessage()}</p></div>}
        </div> : <>
          {recentConnector && <div className="wallet-section"><small>RECENT</small><div className="wallet-list"><WalletRow connector={recentConnector} connecting={connecting && selectedConnectorId === recentConnector.id} label="RECENT" onConnect={(id) => void connect(id)} /></div></div>}
          {detectedConnectors.length > 0 && <div className="wallet-section"><small>DETECTED</small><div className="wallet-list">{detectedConnectors.map((item) => <WalletRow key={item.id} connector={item} connecting={connecting && selectedConnectorId === item.id} label={readyConnectorLabel(item)} onConnect={(id) => void connect(id)} />)}</div></div>}
          {!recentConnector && !detectedConnectors.length && <div className="wallet-empty"><p>{noWalletMessage()}</p></div>}
          <button className="wallet-more-trigger" type="button" onClick={() => changeDialogView('show-directory')}>MORE WALLETS <span aria-hidden="true">&gt;</span></button>
        </>}
        {error && <p className="connection-message" role="alert">{error}</p>}
        <p className="wallet-note">Connecting only shares your public wallet address.</p>
      </section>
    </div>}
  </WalletContext.Provider>;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  return <AppProvider connectorConfig={connectorConfig} mobile={mobileConfig}>
    <GaslessWalletBridge>{children}</GaslessWalletBridge>
  </AppProvider>;
}
