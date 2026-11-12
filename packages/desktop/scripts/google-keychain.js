const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function helperPath(appOutDir) {
  return path.join(appOutDir, 'Paseo.app', 'Contents', 'Helpers', 'paseo-google-keychain');
}
function compileArguments(source, output, arch) {
  const targets = { arm64: 'arm64-apple-macos13.0', x64: 'x86_64-apple-macos13.0' };
  if (!targets[arch]) throw new Error('Unsupported Google Keychain helper architecture');
  return ['-O', '-target', targets[arch], source, '-o', output];
}
function buildGoogleKeychainHelper({ appOutDir, arch }) {
  if (process.platform !== 'darwin') throw new Error('Google Keychain helper requires a macOS build host');
  const source = path.resolve(__dirname, '../../../plugins/external-connections/google/keychain-helper.swift');
  const output = helperPath(appOutDir);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const run = (args) => execFileSync('/usr/bin/swiftc', args, { stdio: 'pipe', timeout: 120000 });
  if (arch !== 'universal') {
    run(compileArguments(source, output, arch));
  } else {
    const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.google-keychain-'));
    try {
      const arm = path.join(temporary, 'arm64');
      const intel = path.join(temporary, 'x64');
      run(compileArguments(source, arm, 'arm64'));
      run(compileArguments(source, intel, 'x64'));
      execFileSync('/usr/bin/lipo', ['-create', arm, intel, '-output', output], { stdio: 'pipe', timeout: 30000 });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  fs.chmodSync(output, 0o755);
  // afterPack precedes electron-builder signing; no ad-hoc signature here.
  return output;
}
function verifyGoogleKeychainHelper(appOutDir) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', helperPath(appOutDir)], { stdio: 'pipe', timeout: 10000 });
}
module.exports = { helperPath, compileArguments, buildGoogleKeychainHelper, verifyGoogleKeychainHelper };
