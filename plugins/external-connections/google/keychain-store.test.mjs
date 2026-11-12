import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGoogleKeychainStore } from './keychain-store.mjs';
function fakeSpawn(reply, code = 0) {
  return (path, argv, options) => {
    assert.equal(path, '/trusted/helper');
    assert.deepEqual(argv, []);
    assert.equal(options.shell, false);
    assert.equal(options.env.GOOGLE_TOKEN, undefined);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => queueMicrotask(() => { child.stdout.write(JSON.stringify(reply)); child.emit('close', code); }));
    return child;
  };
}
test('read uses private pipe, no argv or env credential', async () => {
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: fakeSpawn({ status: 'ok', value: 'fixture' }) });
  assert.equal(await store.read('account'), 'fixture');
});
test('missing credential is distinct from inaccessible Keychain', async () => {
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: fakeSpawn({ status: 'not_found' }, 1) });
  assert.equal(await store.read('account'), null);
  const blocked = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: fakeSpawn({ status: 'keychain_unavailable', value: 'private' }, 1) });
  await assert.rejects(blocked.read('account'), { message: 'KEYCHAIN_UNAVAILABLE' });
});
test('write and delete acknowledge only successful helper exit', async () => {
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: fakeSpawn({ status: 'ok' }) });
  assert.equal(await store.write('account', 'fixture'), undefined);
  assert.equal(await store.delete('account'), undefined);
});
test('malformed helper response cannot expose raw output', async () => {
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: fakeSpawn({ status: 'ok' }) });
  await assert.rejects(store.read('account'), { message: 'KEYCHAIN_INVALID_RESPONSE' });
});
test('invalid account is rejected without spawning helper', () => {
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: () => assert.fail('must not spawn') });
  assert.throws(() => store.read('../x'), { code: 'INVALID_ACCOUNT' });
});

test('hung helper is killed and reports bounded timeout', async () => {
  let killed = false;
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', timeoutMs: 10, spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => { killed = true; }; return child;
  } });
  await assert.rejects(store.read('account'), { code: 'KEYCHAIN_HELPER_TIMEOUT' });
  assert.equal(killed, true);
});
test('oversized helper output is killed and never returned', async () => {
  let killed = false;
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => { killed = true; };
    child.stdin.on('finish', () => queueMicrotask(() => child.stdout.write('x'.repeat(65537)))); return child;
  } });
  await assert.rejects(store.read('account'), { code: 'KEYCHAIN_INVALID_RESPONSE' });
  assert.equal(killed, true);
});

test('trusted helper verifier runs before each spawn and refuses tampered helper', async () => {
  let spawned = false;
  const store = createGoogleKeychainStore({ helperPath: '/trusted/helper', verifyHelper: () => { throw new Error('digest mismatch'); }, spawnProcess: () => { spawned = true; } });
  await assert.rejects(store.read('account'), { code: 'KEYCHAIN_HELPER_UNAVAILABLE' });
  assert.equal(spawned, false);
});
