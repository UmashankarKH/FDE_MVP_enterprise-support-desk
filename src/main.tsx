import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {PublicClientApplication, EventType} from '@azure/msal-browser';
import {MsalProvider} from '@azure/msal-react';
import App from './App.tsx';
import {msalConfig} from './authConfig.ts';
import './index.css';

const msalInstance = new PublicClientApplication(msalConfig);

// MSAL Browser v3+ requires an explicit, awaited initialize() before ANY
// other instance method - getAllAccounts(), setActiveAccount(), etc. It sets
// up the crypto/cache subsystem asynchronously. The old code below called
// getAllAccounts() synchronously right after `new PublicClientApplication`,
// with no initialize() at all - that throws
// BrowserAuthError: uninitialized_public_client_application, and since this
// runs at module top level (before React ever mounts), the thrown error
// kills the entire script before createRoot(...).render(...) is reached -
// the app just shows a blank page with nothing in the DOM. MsalProvider
// would also call initialize() itself on mount, but that's too late here
// since getAllAccounts() runs before MsalProvider ever renders.
async function bootstrap() {
  await msalInstance.initialize();

  // Keep MSAL's "active account" pointed at whoever just signed in, so
  // acquireTokenSilent() in LiveChatInterface knows who to get a token for.
  msalInstance.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      // @ts-ignore - payload is AuthenticationResult on login success
      msalInstance.setActiveAccount(event.payload.account);
    }
  });

  const existingAccounts = msalInstance.getAllAccounts();
  if (existingAccounts.length > 0) {
    msalInstance.setActiveAccount(existingAccounts[0]);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </StrictMode>,
  );
}

bootstrap();
