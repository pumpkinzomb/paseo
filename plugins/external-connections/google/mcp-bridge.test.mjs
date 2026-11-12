import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleMcpBridge } from './mcp-bridge.mjs';
import { googleReadScopes } from './rest.mjs';

async function setup(t, overrides = {}) {
  const calls = [];
  const bridge = createGoogleMcpBridge({ getAccessToken: async scope => { calls.push(scope); return 'fixture-google-token'; }, request: async () => Response.json({ title: 'fixture document' }), ...overrides });
  await bridge.start();
  t.after(() => bridge.stop());
  const session = bridge.openSession({ agentId: 'agent-1', provider: 'codex', scopes: [googleReadScopes.docs] });
  async function rpc(method, params) {
    const response = await fetch(session.url, { method: 'POST', headers: { ...session.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  }
  return { bridge, session, calls, rpc };
}
test('authenticated initialize/list/call reads only granted Google service', async t => {
  const { rpc, calls, session } = await setup(t);
  assert.equal((await rpc('initialize', { protocolVersion: '2025-03-26' })).body.result.protocolVersion, '2025-03-26');
  const list = await rpc('tools/list');
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['docs.read']);
  const response = await rpc('tools/call', { name: 'docs.read', arguments: { id: 'fixture-doc' } });
  assert.deepEqual(response.body.result.content, [{ type: 'text', text: '{"title":"fixture document"}' }]);
  assert.deepEqual(calls, [{ agentId: 'agent-1', provider: 'codex', scope: googleReadScopes.docs }]);
  assert.equal(JSON.stringify(session).includes('fixture-google-token'), false);
});
test('unauthenticated request rejected before parsing body or using credentials', async t => {
  const { session, calls } = await setup(t);
  const response = await fetch(session.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' });
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});
test('browser Origin blocked even with valid bearer', async t => {
  const { session } = await setup(t);
  const response = await fetch(session.url, { method: 'POST', headers: { ...session.headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(response.status, 403);
});
test('ungranted scope and unknown writes never read credentials', async t => {
  const { rpc, calls } = await setup(t);
  const denied = await rpc('tools/call', { name: 'gmail.read', arguments: { id: 'fixture' } });
  assert.equal(denied.body.result.isError, true);
  assert.equal(denied.body.result.content[0].text, 'SCOPE_NOT_GRANTED');
  assert.equal((await rpc('tools/call', { name: 'gmail.send', arguments: {} })).body.error.code, -32602);
  assert.deepEqual(calls, []);
});
test('agent close revokes existing bridge headers', async t => {
  const { bridge, rpc, calls } = await setup(t);
  bridge.revokeAgent('agent-1');
  assert.equal((await rpc('tools/list')).status, 401);
  assert.deepEqual(calls, []);
});
test('expired bridge headers stop working', async t => {
  let now = 0;
  const { rpc } = await setup(t, { clock: () => now });
  now = 300000;
  assert.equal((await rpc('tools/list')).status, 401);
});
test('unexpected token broker errors cannot leak secrets to provider', async t => {
  const { rpc } = await setup(t, { getAccessToken: async () => { throw new Error('secret-token'); } });
  const response = await rpc('tools/call', { name: 'docs.read', arguments: { id: 'fixture' } });
  assert.equal(response.body.result.content[0].text, 'GOOGLE_TOOL_UNAVAILABLE');
});
test('stop disallows issuing new capabilities', async t => {
  const { bridge } = await setup(t);
  await bridge.stop();
  assert.throws(() => bridge.openSession({ agentId: 'x', provider: 'codex', scopes: [googleReadScopes.docs] }), { message: 'BRIDGE_NOT_STARTED' });
});

test('read-only session cannot use write tool even when guessing its name', async t => {
  const { rpc, calls } = await setup(t);
  const response = await rpc('tools/call', { name: 'docs.insertText', arguments: { id: 'x', text: 'y', revisionId: 'r' } });
  assert.equal(response.body.result.content[0].text, 'SCOPE_NOT_GRANTED');
  assert.deepEqual(calls, []);
});
