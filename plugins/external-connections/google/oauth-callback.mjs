import { createServer } from 'node:http';
import { GoogleOAuthAttempt, GoogleOAuthError } from './oauth.mjs';

/** Call only after explicit user login action. Does not open a browser itself. */
export async function startGoogleOAuthCallback({ clientId, scopes, onExchange, timeoutMs = 300000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new GoogleOAuthError('INVALID_TIMEOUT');
  let attempt;
  let state = 'waiting';
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // Callers may attach their UI observer after the callback has settled.
  completion.catch(() => {});
  let timer;
  let expectedHost;
  function page(response, status, message) {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' });
    response.end(message);
  }
  function shutdown() {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
  }
  const server = createServer((incoming, outgoing) => {
    const invalidRequest = incoming.method !== 'GET' || incoming.headers.host !== expectedHost || incoming.headers.origin !== undefined || !incoming.url?.startsWith('/callback?');
    if (invalidRequest) { page(outgoing, 400, 'Invalid callback.'); return; }
    if (state !== 'waiting') { page(outgoing, 409, 'This sign-in attempt has ended.'); return; }
    let exchange;
    try { exchange = attempt.consumeCallback(`http://${expectedHost}${incoming.url}`); }
    catch (failure) {
      page(outgoing, 400, 'Sign-in was not completed. Return to Paseo.');
      if (failure instanceof GoogleOAuthError && ['CONSENT_NOT_COMPLETED', 'OAUTH_ATTEMPT_EXPIRED', 'OAUTH_ATTEMPT_ENDED'].includes(failure.code)) {
        state = 'ended'; shutdown(); rejectCompletion(failure);
      }
      return;
    }
    state = 'exchanging';
    clearTimeout(timer);
    // Code exchange runs only after a valid, one-use state/PKCE callback.
    Promise.resolve().then(() => onExchange(exchange)).then(result => {
      state = 'ended'; page(outgoing, 200, 'Sign-in completed. Return to Paseo.'); shutdown(); resolveCompletion(result);
    }).catch(() => {
      state = 'ended'; page(outgoing, 500, 'Sign-in could not be completed. Return to Paseo and retry.'); shutdown(); rejectCompletion(new GoogleOAuthError('TOKEN_EXCHANGE_FAILED'));
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  expectedHost = `127.0.0.1:${server.address().port}`;
  try {
    attempt = new GoogleOAuthAttempt({ clientId, scopes, redirectUri: `http://${expectedHost}/callback` });
  } catch (failure) { shutdown(); throw failure; }
  function cancel(code = 'OAUTH_CANCELLED') {
    if (state !== 'waiting') return false;
    state = 'ended'; attempt.cancel(); shutdown(); server.closeAllConnections(); rejectCompletion(new GoogleOAuthError(code)); return true;
  }
  timer = setTimeout(() => cancel('OAUTH_ATTEMPT_EXPIRED'), timeoutMs);
  timer.unref();
  return { authorizationUrl: attempt.authorizationUrl(), completion, cancel: () => cancel() };
}
