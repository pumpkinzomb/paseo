import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
test("local package is offline, ad-hoc signed, and declares no upstream updater", () => {
  const config = require("../packages/desktop/electron-builder.local.cjs");
  assert.equal(config.appId, "sh.paseo.local");
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.extraMetadata.paseoDistribution.updatePolicy, "local-only");
  assert.match(config.extraMetadata.paseoDistribution.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(config.electronDist, /electron\/dist$/);
  assert.match(config.directories.output, /\.lab\/packaged$/);
});
