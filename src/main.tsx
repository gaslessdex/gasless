import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './app/App';
import { initializeSentry } from './monitoring/sentry';
import { WalletProvider } from './wallet/WalletProvider';
import { ApplicationActivityProvider } from './activity/applicationActivity';
import { BrowserVerificationGate } from './security/BrowserVerificationGate';

initializeSentry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApplicationActivityProvider>
      <BrowserVerificationGate>
        <WalletProvider>
          <App />
        </WalletProvider>
      </BrowserVerificationGate>
    </ApplicationActivityProvider>
  </StrictMode>,
);
