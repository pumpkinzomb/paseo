import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleConnectionService } from './host-service.mjs';
import { googleReadScopes } from './rest.mjs';
const clientId = 'fixture.apps.googleusercontent.com';
function setup() {
  const records = new Map();
  const issued = [];
  const revoked = [];
  let stopped = false;
  let callback;
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  completion.catch(() => {});
  const service = createGoogleConnectionService({ clientId,
    store: { read: async key => records.get(key) ?? null, write: async (key, value) => { records.set(key, value); }, delete: async key => { records.delete(key); } },
    request: async () => Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', scope: googleReadScopes.docs }),
    openCallback: async options => { callback = options.onExchange; return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1', completion, cancel: () => { reject(new Error('cancelled')); return true; } }; },
    createBridge: () => ({ start: async () => {}, openSession: input => { issued.push(input); return { url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'Bearer fixture-bridge' }, expiresAt: 1 }; }, revokeAgent: agent => revoked.push(agent), stop: async () => { stopped = true; } }),
  });
  async function finish() {
    const value = await callback(new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code: 'fake' }));
    resolve(value);
    await new Promise(yes => setImmediate(yes));
  }
  return { service, records, issued, revoked, finish, stopped: () => stopped };
}
test('missing config fails closed and never pretends connected', async () => {
  assert.deepEqual(await createGoogleConnectionService().status(), { status: 'setup-required', scopes: [], reason: 'oauth-client-missing' });
  assert.deepEqual(await createGoogleConnectionService({ clientId }).status(), { status: 'setup-required', scopes: [], reason: 'secure-store-unavailable' });
});
test('UI interface returns only URL/status; host launch derives stored scopes', async () => {
  const { service, issued, finish } = setup();
  assert.deepEqual(await service.status(), { status: 'not-connected', scopes: [] });
  const begin = await service.begin([googleReadScopes.docs]);
  assert.deepEqual(Object.keys(begin), ['authorizationUrl']);
  assert.deepEqual(await service.status(), { status: 'authorizing', scopes: [] });
  await assert.rejects(service.openAgent({ agentId: 'a', provider: 'codex' }), /GOOGLE_AUTH_IN_PROGRESS/);
  await finish();
  assert.deepEqual(await service.status(), { status: 'credentials-stored', scopes: [googleReadScopes.docs] });
  const launch = await service.openAgent({ agentId: 'a', provider: 'codex', scopes: [googleReadScopes.gmail] });
  assert.equal(launch.headers.Authorization, 'Bearer fixture-bridge');
  assert.deepEqual(issued, [{ agentId: 'a', provider: 'codex', scopes: [googleReadScopes.docs] }]);
  await service.dispose();
});
test('forget removes host credentials and revokes active agent grants', async () => {
  const { service, finish, records, revoked } = setup();
  await service.begin([googleReadScopes.docs]); await finish();
  await service.openAgent({ agentId: 'a', provider: 'claude' });
  await service.forget();
  assert.equal(records.size, 0);
  assert.deepEqual(revoked, ['a']);
  await assert.rejects(service.openAgent({ agentId: 'b', provider: 'codex' }), /LOGIN_REQUIRED/);
  await service.dispose();
});
test('cancel ends login; dispose stops bridge and forbids future work', async () => {
  const { service, stopped } = setup();
  await service.begin([googleReadScopes.docs]);
  assert.equal(await service.cancel(), true);
  await service.dispose();
  assert.equal(stopped(), true);
  await assert.rejects(service.begin([googleReadScopes.docs]), /GOOGLE_SERVICE_STOPPED/);
});
