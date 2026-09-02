import { formatWalletAddress, useWallet } from '../../wallet/walletContext';

export function WalletButton() {
  const { account, connected, connecting, requestConnection } = useWallet();
  const label = connecting
    ? 'CONNECTING'
    : account
      ? formatWalletAddress(account.address)
      : 'CONNECT WALLET';

  return <button className={`wallet-state${connected ? ' is-connected' : ''}`} type="button" onClick={requestConnection} disabled={connecting} aria-label={connected ? `Wallet ${label}. Open wallet controls.` : label}>
    <i /> {label}
  </button>;
}
