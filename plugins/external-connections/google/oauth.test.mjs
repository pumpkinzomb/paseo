import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuthAttempt } from './oauth.mjs';
import { googleReadScopes } from './rest.mjs';

test('authorization uses S256, selected scopes and one-use callback state', () => {
  const attempt = new GoogleOAuthAttempt({ clientId: 'fixture.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:49152/callback', scopes: [googleReadScopes.docs] });
  const url = new URL(attempt.authorizationUrl());
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), googleReadScopes.docs);
  assert.equal(url.searchParams.has('code_verifier'), false);
  const callback = new URL('http://127.0.0.1:49152/callback');
  callback.searchParams.set('state', url.searchParams.get('state'));
  callback.searchParams.set('code', 'fixture-code');
  const exchange = attempt.consumeCallback(callback.toString());
  assert.equal(exchange.get('code'), 'fixture-code');
  assert.equal(exchange.get('code_verifier').length, 43);
  assert.throws(() => attempt.consumeCallback(callback.toString()), { code: 'OAUTH_ATTEMPT_ENDED' });
});

function attempt(overrides = {}) {
  return new GoogleOAuthAttempt({ clientId: 'fixture.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:49152/callback', scopes: [googleReadScopes.gmail], ...overrides });
}
function callback(flow) {
  const url = new URL('http://127.0.0.1:49152/callback');
  url.searchParams.set('state', new URL(flow.authorizationUrl()).searchParams.get('state'));
  url.searchParams.set('code', 'fixture-code');
  return url;
}
for (const redirectUri of ['https://evil.example/callback', 'http://localhost:49152/callback', 'http://127.0.0.1/callback', 'http://user@127.0.0.1:49152/callback', 'http://127.0.0.1:49152/callback?x=1']) {
  test(`rejects redirect ${redirectUri}`, () => assert.throws(() => attempt({ redirectUri }), { code: 'INVALID_REDIRECT' }));
}
test('write scopes require a separate implementation and approval', () => {
  assert.throws(() => attempt({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }), { code: 'UNSUPPORTED_SCOPE' });
});
test('wrong state does not consume a valid attempt', () => {
  const flow = attempt();
  const valid = callback(flow);
  const bad = new URL(valid);
  bad.searchParams.set('state', 'wrong');
  assert.throws(() => flow.consumeCallback(bad.href), { code: 'INVALID_STATE' });
  assert.equal(flow.consumeCallback(valid.href).get('code'), 'fixture-code');
});
test('duplicated state is rejected', () => {
  const flow = attempt();
  const url = callback(flow);
  url.searchParams.append('state', url.searchParams.get('state'));
  assert.throws(() => flow.consumeCallback(url.href), { code: 'INVALID_STATE' });
});
test('wrong callback endpoint is rejected', () => {
  const flow = attempt();
  const url = callback(flow);
  url.pathname = '/other';
  assert.throws(() => flow.consumeCallback(url.href), { code: 'INVALID_CALLBACK' });
});
test('expiration and cancellation invalidate the attempt', () => {
  let time = 0;
  const flow = attempt({ clock: () => time });
  const url = callback(flow);
  time = 300000;
  assert.throws(() => flow.consumeCallback(url.href), { code: 'OAUTH_ATTEMPT_EXPIRED' });
  assert.throws(() => flow.authorizationUrl(), { code: 'OAUTH_ATTEMPT_ENDED' });
  const cancelled = attempt();
  cancelled.cancel();
  assert.throws(() => cancelled.authorizationUrl(), { code: 'OAUTH_ATTEMPT_ENDED' });
});
test('denied consent consumes attempt without exposing provider message', () => {
  const flow = attempt();
  const url = callback(flow);
  url.searchParams.set('error', 'private-provider-description');
  assert.throws(() => flow.consumeCallback(url.href), { message: 'CONSENT_NOT_COMPLETED' });
  assert.throws(() => flow.consumeCallback(url.href), { code: 'OAUTH_ATTEMPT_ENDED' });
});
