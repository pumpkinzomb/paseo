import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrustedGoogleHelper } from "./helper-trust.mjs";
const exe =
  "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
function fixture(overrides = {}) {
  return {
    platform: "darwin",
    execPath: exe,
    realpath: (value) => value,
    inspect: (value) => ({
      identifier: value.endsWith(".app") ? "sh.paseo.desktop" : "paseo-google-keychain",
      team: "FIXTURETEAM",
    }),
    ...overrides,
  };
}
test("helper path derives from outer signed Paseo bundle, not nested Electron helper", () => {
  assert.equal(
    resolveTrustedGoogleHelper(fixture()),
    "/Applications/Paseo.app/Contents/Helpers/paseo-google-keychain",
  );
});
test("standalone Node and unsupported OS fail closed", () => {
  assert.throws(() => resolveTrustedGoogleHelper(fixture({ execPath: "/usr/local/bin/node" })), {
    code: "SECURE_STORE_UNAVAILABLE",
  });
  assert.throws(() => resolveTrustedGoogleHelper(fixture({ platform: "linux" })), {
    code: "SECURE_STORE_UNAVAILABLE",
  });
});
test("helper symlink outside app rejected", () => {
  assert.throws(
    () =>
      resolveTrustedGoogleHelper(
        fixture({
          realpath: (value) => (value.endsWith("paseo-google-keychain") ? "/tmp/malicious" : value),
        }),
      ),
    { code: "SECURE_STORE_UNAVAILABLE" },
  );
});
test("wrong bundle identity or different helper signer rejected", () => {
  assert.throws(
    () =>
      resolveTrustedGoogleHelper(fixture({ inspect: () => ({ identifier: "evil", team: "X" }) })),
    { code: "SECURE_STORE_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      resolveTrustedGoogleHelper(
        fixture({
          inspect: (value) => ({
            identifier: value.endsWith(".app") ? "sh.paseo.desktop" : "helper",
            team: value.endsWith(".app") ? "ONE" : "TWO",
          }),
        }),
      ),
    { code: "SECURE_STORE_UNAVAILABLE" },
  );
});
