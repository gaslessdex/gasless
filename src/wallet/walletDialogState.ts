export type WalletDialogView = 'closed' | 'chooser' | 'directory' | 'walletconnect';

export type WalletDialogAction = 'open' | 'show-directory' | 'show-walletconnect' | 'back' | 'close';

export function transitionWalletDialog(view: WalletDialogView, action: WalletDialogAction): WalletDialogView {
  switch (action) {
    case 'open':
      return 'chooser';
    case 'show-directory':
      return 'directory';
    case 'show-walletconnect':
      return 'walletconnect';
    case 'back':
      return view === 'walletconnect' ? 'directory' : 'chooser';
    case 'close':
      return 'closed';
  }
}
