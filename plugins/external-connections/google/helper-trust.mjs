import { realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class GoogleHelperTrustError extends Error {
  constructor() {
    super("SECURE_STORE_UNAVAILABLE");
    this.name = "GoogleHelperTrustError";
    this.code = "SECURE_STORE_UNAVAILABLE";
  }
}
function signedIdentity(filePath) {
  const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", filePath], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (verified.error || verified.status !== 0) throw new GoogleHelperTrustError();
  const info = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", filePath], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (info.error || info.status !== 0) throw new GoogleHelperTrustError();
  const identifier = /^Identifier=(.+)$/m.exec(info.stderr)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(info.stderr)?.[1];
  if (!identifier || !team || team === "not set") throw new GoogleHelperTrustError();
  return { identifier, team };
}

/** Derive from the real host executable, never an editable helper-path setting. */
export function resolveTrustedGoogleHelper({
  execPath = process.execPath,
  platform = process.platform,
  realpath = realpathSync,
  inspect = signedIdentity,
} = {}) {
  if (platform !== "darwin") throw new GoogleHelperTrustError();
  let actual;
  try {
    actual = realpath(execPath);
  } catch {
    throw new GoogleHelperTrustError();
  }
  const marker = ".app/Contents/";
  const index = actual.indexOf(marker);
  if (index < 0) throw new GoogleHelperTrustError();
  const bundle = actual.slice(0, index + ".app".length);
  const expected = path.join(bundle, "Contents", "Helpers", "paseo-google-keychain");
  let helper;
  try {
    helper = realpath(expected);
  } catch {
    throw new GoogleHelperTrustError();
  }
  if (helper !== expected) throw new GoogleHelperTrustError();
  const appIdentity = inspect(bundle);
  const helperIdentity = inspect(helper);
  if (
    appIdentity.identifier !== "sh.paseo.desktop" ||
    !appIdentity.team ||
    appIdentity.team !== helperIdentity.team
  )
    throw new GoogleHelperTrustError();
  return helper;
}
