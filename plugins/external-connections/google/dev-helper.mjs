import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { createGoogleKeychainStore } from './keychain-store.mjs';

function fail() { throw new Error('DEV_SECURE_STORE_UNAVAILABLE'); }
function hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function ownedPrivateDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) fail();
}

/** Trusted desktop development startup only. Never register this function as RPC. */
export async function provisionGoogleDevelopmentStore({ directory }) {
  if (process.platform !== 'darwin' || !path.isAbsolute(directory)) fail();
  // Source is fixed to this trusted checkout module; no source/helper path input.
  const source = fileURLToPath(new URL('./keychain-helper.swift', import.meta.url));
  if (fs.realpathSync(source) !== source) fail();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  ownedPrivateDirectory(directory);
  const temporary = fs.mkdtempSync(path.join(directory, '.build-'));
  const output = path.join(directory, 'paseo-google-keychain');
  try {
    const built = path.join(temporary, 'paseo-google-keychain');
    await run('/usr/bin/swiftc', ['-O', source, '-o', built], { timeout: 120000, maxBuffer: 65536 });
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'sh.paseo.google-keychain.development', built], { timeout: 10000, maxBuffer: 65536 });
    await run('/usr/bin/codesign', ['--verify', '--strict', built], { timeout: 10000, maxBuffer: 65536 });
    fs.chmodSync(built, 0o500);
    const expected = hash(built);
    // Never trust a persistent manifest: expected digest comes from this build.
    if (fs.existsSync(output)) {
      const previous = fs.lstatSync(output);
      if (previous.isSymbolicLink() || !previous.isFile() || previous.uid !== process.getuid()) fail();
    }
    fs.renameSync(built, output);
    function verifyHelper() {
      ownedPrivateDirectory(directory);
      const info = fs.lstatSync(output);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || hash(output) !== expected) fail();
    }
    verifyHelper();
    return createGoogleKeychainStore({ helperPath: output, verifyHelper });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
