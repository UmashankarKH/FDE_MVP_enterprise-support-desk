import React, { useEffect } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { ShieldCheck, LogIn } from 'lucide-react';
import { loginRequest, tokenRequest } from '../../authConfig';

// The "authenticate on screen" step of the live demo flow: nothing behind this
// gate renders until the user has signed in with Entra ID, and every backend
// call downstream (LiveChatInterface, AdminDashboard) uses the resulting token.
export const LoginGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  // Warm the API-scope token cache the moment sign-in succeeds, instead of
  // waiting for the first chat/dashboard click to discover there's no cached
  // token yet. This matters because acquireTokenSilent with no cached/
  // refresh token falls back to a hidden-iframe SSO renewal, which browsers
  // with strict third-party-cookie blocking (Brave Shields, Safari ITP)
  // block outright - and the *interactive* fallback for that (a popup)
  // only works when it happens synchronously inside a user click, which a
  // background click-time token fetch never is. Doing it here, right after
  // login, sidesteps both problems for the vast majority of requests.
  useEffect(() => {
    if (!isAuthenticated || accounts.length === 0) return;
    instance
      .acquireTokenSilent({ ...tokenRequest, account: accounts[0] })
      .catch((err) => {
        console.warn('Token priming failed, will retry on first API call:', err);
        // Safe to use redirect here (unlike inside a click handler) - we're
        // not mid-interaction with anything the user would lose on nav away.
        instance.acquireTokenRedirect(tokenRequest).catch((redirectErr) => {
          console.error('Token priming redirect fallback also failed:', redirectErr);
        });
      });
  }, [isAuthenticated, accounts, instance]);

  if (isAuthenticated) {
    return <>{children}</>;
  }

  const handleLogin = () => {
    // Full-page redirect instead of a popup: more reliable when the user
    // already has an active Azure SSO session, since the popup+polling
    // handshake can complete faster than the parent window can detect it.
    instance.loginRedirect(loginRequest).catch((err) => {
      console.error('Login failed:', err);
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center space-y-6">
        <div className="w-14 h-14 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mx-auto">
          <ShieldCheck className="w-7 h-7" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Enterprise Support Desk</h1>
          <p className="text-sm text-slate-400 mt-1">Sign in with your organizational account to continue.</p>
        </div>
        <button
          onClick={handleLogin}
          className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-5 py-3 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-cyan-500/20"
        >
          <LogIn className="w-4 h-4" />
          <span>Sign in with Microsoft Entra ID</span>
        </button>
        <p className="text-xs text-slate-500">Secured by Azure AD / Entra ID · Single sign-on</p>
      </div>
    </div>
  );
};
