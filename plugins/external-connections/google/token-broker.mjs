import { googleWriteScopes } from './write.mjs';
import { googleReadScopes } from './rest.mjs';

export class GoogleTokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GoogleTokenError';
    this.code = code;
  }
}

const knownScopes = new Set([...Object.values(googleReadScopes), ...Object.values(googleWriteScopes)]);
function validScopes(scopes) {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.every(scope => knownScopes.has(scope));
}
function secret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\r\n]/.test(value);
}

/** Host-only. Store must be Keychain-backed; no filesystem fallback is provided. */
export function createGoogleTokenBroker({ clientId, store, request = fetch, clock = Date.now, onInvalidated = () => {}, getClientSecret = async () => null }) {
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new GoogleTokenError('INVALID_CLIENT_ID');
  const cached = new Map();
  const pending = new Map();

  function serialized(account, action) {
    if (typeof account !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) return Promise.reject(new GoogleTokenError('INVALID_ACCOUNT'));
    const previous = pending.get(account) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    pending.set(account, current);
    current.finally(() => { if (pending.get(account) === current) pending.delete(account); }).catch(() => {});
    return current;
  }

  async function load(account) {
    const raw = await store.read(account);
    if (raw === null) throw new GoogleTokenError('LOGIN_REQUIRED');
    let value;
    try { value = JSON.parse(raw); } catch { throw new GoogleTokenError('INVALID_STORED_CREDENTIAL'); }
    const invalid = !value || value.clientId !== clientId || !secret(value.refreshToken) || !validScopes(value.scopes);
    if (invalid) throw new GoogleTokenError('INVALID_STORED_CREDENTIAL');
    return value;
  }

  async function tokenRequest(form) {
    const bodyForm = new URLSearchParams(form);
    const clientSecret = await getClientSecret();
    if (clientSecret !== null) {
      if (!secret(clientSecret)) throw new GoogleTokenError('INVALID_CLIENT_CONFIGURATION');
      bodyForm.set('client_secret', clientSecret);
    }
    let response;
    let body;
    try {
      response = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyForm.toString(), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 65536) throw new Error('oversized');
      body = JSON.parse(text);
    } catch { throw new GoogleTokenError('TOKEN_NETWORK_OR_RESPONSE_ERROR'); }
    if (!response.ok) {
      if (body?.error === 'invalid_grant') throw new GoogleTokenError('LOGIN_REQUIRED');
      if (body?.error === 'invalid_client') throw new GoogleTokenError('OAUTH_CLIENT_CONFIGURATION_REQUIRED');
      throw new GoogleTokenError('TOKEN_REQUEST_FAILED');
    }
    const invalid = !secret(body?.access_token) || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(body.expires_in) || body.expires_in < 1 || body.expires_in > 86400;
    if (invalid) throw new GoogleTokenError('INVALID_TOKEN_RESPONSE');
    return body;
  }

  function responseScopes(body, fallback) {
    const scopes = body.scope === undefined ? fallback : typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
    if (!validScopes(scopes)) throw new GoogleTokenError('INVALID_GRANTED_SCOPES');
    return [...new Set(scopes)];
  }

  function cache(account, body, scopes) {
    cached.set(account, { token: body.access_token, expiresAt: clock() + body.expires_in * 1000, scopes });
  }

  return {
    acceptAuthorization({ account, exchange, requestedScopes }) {
      return serialized(account, async () => {
        if (!(exchange instanceof URLSearchParams) || exchange.get('client_id') !== clientId || exchange.get('grant_type') !== 'authorization_code' || !validScopes(requestedScopes)) throw new GoogleTokenError('INVALID_AUTHORIZATION_EXCHANGE');
        const body = await tokenRequest(exchange);
        // Token response may omit scope when identical to requested scopes (OAuth2).
        const scopes = responseScopes(body, requestedScopes);
        if (scopes.some(scope => !requestedScopes.includes(scope))) throw new GoogleTokenError('UNEXPECTED_GRANTED_SCOPES');
        if (!secret(body.refresh_token)) throw new GoogleTokenError('OFFLINE_CONSENT_REQUIRED');
        await store.write(account, JSON.stringify({ clientId, refreshToken: body.refresh_token, scopes }));
        cache(account, body, scopes);
        return { scopes: [...scopes] };
      });
    },
    getAccessToken({ account, scope }) {
      return serialized(account, async () => {
        if (!knownScopes.has(scope)) throw new GoogleTokenError('UNSUPPORTED_SCOPE');
        const active = cached.get(account);
        if (active && active.expiresAt > clock() + 30000) {
          if (!active.scopes.includes(scope)) throw new GoogleTokenError('SCOPE_NOT_GRANTED');
          return active.token;
        }
        const stored = await load(account);
        if (!stored.scopes.includes(scope)) throw new GoogleTokenError('SCOPE_NOT_GRANTED');
        let body;
        try {
          body = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: stored.refreshToken }));
        } catch (failure) {
          if (failure instanceof GoogleTokenError && failure.code === 'LOGIN_REQUIRED') {
            cached.delete(account);
            onInvalidated(account);
            await store.delete(account);
          }
          throw failure;
        }
        const scopes = responseScopes(body, stored.scopes);
        if (scopes.some(value => !stored.scopes.includes(value))) throw new GoogleTokenError('UNEXPECTED_GRANTED_SCOPES');
        if (!scopes.includes(scope)) throw new GoogleTokenError('SCOPE_NOT_GRANTED');
        const refreshToken = body.refresh_token ?? stored.refreshToken;
        if (!secret(refreshToken)) throw new GoogleTokenError('INVALID_TOKEN_RESPONSE');
        await store.write(account, JSON.stringify({ clientId, refreshToken, scopes }));
        cache(account, body, scopes);
        return body.access_token;
      });
    },
    status(account) {
      return serialized(account, async () => {
        try {
          const stored = await load(account);
          return { status: 'credentials-stored', scopes: [...stored.scopes] };
        } catch (failure) {
          if (failure instanceof GoogleTokenError && failure.code === 'LOGIN_REQUIRED') return { status: 'not-connected', scopes: [] };
          throw failure;
        }
      });
    },
    forget(account) {
      return serialized(account, async () => {
        cached.delete(account);
        onInvalidated(account);
        await store.delete(account);
      });
    },
  };
}
