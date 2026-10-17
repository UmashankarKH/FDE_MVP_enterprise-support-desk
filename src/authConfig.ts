// Entra ID (Azure AD) config for the fde-frontend-portal SPA app registration.
// Values here are not secret (public client IDs) - safe to ship in the bundle.
// Rebuilt 2026-08-27 after the resource-group wipe - old fde-frontend-ui and
// the stale fde-backend-api registrations were deleted and replaced with
// fresh ones (see Entra ID > App registrations).
import { Configuration, PopupRequest } from '@azure/msal-browser';

const TENANT_ID = import.meta.env.VITE_ENTRA_TENANT_ID || '4020cb3d-7a97-47db-a7cf-405934fdefd8';
const FRONTEND_CLIENT_ID = import.meta.env.VITE_ENTRA_FRONTEND_CLIENT_ID || 'c03da22a-d36f-4ba1-8771-6edfb4cded92';
const BACKEND_CLIENT_ID = import.meta.env.VITE_ENTRA_BACKEND_CLIENT_ID || '2acb70df-1343-479c-ae97-c3a04c42cc9d';

export const msalConfig: Configuration = {
  auth: {
    clientId: FRONTEND_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    // localStorage (not sessionStorage) so the cached tokens/refresh token
    // survive a tab close or reload, not just the current tab's lifetime.
    // sessionStorage was forcing acquireTokenSilent to start from zero (no
    // cached token, no refresh token) far more often than necessary, which
    // is what was driving the hidden-iframe SSO renewal -> Brave-blocked ->
    // timed_out -> popup-blocked failure chain seen during testing.
    cacheLocation: 'localStorage',
  },
};

// Scope for the backend API (fde-backend-api) - this is what gets sent as the
// bearer token audience so the backend can validate it.
export const backendApiScope = `api://${BACKEND_CLIENT_ID}/access_as_user`;

export const loginRequest: PopupRequest = {
  scopes: ['openid', 'profile', backendApiScope],
};

export const tokenRequest: PopupRequest = {
  scopes: [backendApiScope],
};
