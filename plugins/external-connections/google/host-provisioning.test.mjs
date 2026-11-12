import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHostGoogleService } from './host-provisioning.mjs';

test('unconfigured status does not compile helper or read Keychain', async t => {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'paseo-host-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = createHostGoogleService({ stateDirectory: dir, runtimeMode: 'development', prepareDevelopmentStore: async () => assert.fail('must not compile') });
  assert.deepEqual(await service.status(), { status: 'setup-required', scopes: [], reason: 'oauth-client-missing' });
  await service.dispose();
});
test('explicit development configure prepares only once and keeps secrets out of file/status', async t => {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'paseo-host-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let prepared = 0;
  const data = new Map();
  const service = createHostGoogleService({ stateDirectory: dir, runtimeMode: 'development', prepareDevelopmentStore: async ({ directory }) => { prepared++; assert.equal(directory, path.join(dir, 'native-helper')); return { read: async key => data.get(key) ?? null, write: async (key, value) => data.set(key, value), delete: async key => data.delete(key) }; } });
  await service.configure({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'private-fixture' });
  assert.equal(prepared, 1);
  assert.deepEqual(await service.status(), { status: 'not-connected', scopes: [] });
  assert.equal((await fs.readFile(path.join(dir, 'google-client.json'), 'utf8')).includes('private-fixture'), false);
  await service.dispose();
});
test('packaged verification failure does not fall back to dev compile', async t => {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'paseo-host-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = createHostGoogleService({ stateDirectory: dir, runtimeMode: 'packaged', resolvePackagedHelper: () => { throw new Error('bad signature'); }, prepareDevelopmentStore: async () => assert.fail('must not fallback') });
  await assert.rejects(service.configure({ clientId: 'fixture.apps.googleusercontent.com' }), /bad signature/);
  await service.dispose();
});
