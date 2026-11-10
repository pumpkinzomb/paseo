import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePlan, assertLocalPaths, labEnv } from "./isolated-lab.mjs";
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-boundary-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "lab"),
    live = path.join(base, "live");
  fs.mkdirSync(root);
  fs.mkdirSync(live);
  return {
    root,
    live,
    m: {
      role: "development-lab",
      root,
      protectedRoots: [live],
      daemonPort: 6778,
      metroPort: 8092,
    },
  };
}
test("lab paths and ports separate from live", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  assert.equal(p.home, path.join(fs.realpathSync(f.root), ".lab/paseo-home"));
  assertLocalPaths(p);
});
test("reject live root and reserved ports", (t) => {
  const f = fixture(t);
  assert.throws(() => resolvePlan(f.root, { ...f.m, protectedRoots: [f.root] }), /overlaps/);
  for (const port of [6768, 8084])
    assert.throws(() => resolvePlan(f.root, { ...f.m, daemonPort: port }), /Unsafe/);
});
test("reject outputs and workspace dependencies linked to runtime", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  fs.symlinkSync(f.live, path.join(f.root, "node_modules"));
  assert.throws(() => assertLocalPaths(p), /escapes/);
});
test("strip inherited live endpoints and data seeding", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  const e = labEnv(p, {
    PATH: "/bin",
    PASEO_HOME: f.live,
    PASEO_DEV_SEED_HOME: f.live,
    PASEO_DEV_RESET_HOME: "1",
    PASEO_LISTEN: "127.0.0.1:6768",
    EXPO_DEV_URL: "http://localhost:8084",
    NODE_OPTIONS: "--import /unwanted",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(e.PASEO_HOME, p.home);
  assert.equal(e.PASEO_LISTEN, "127.0.0.1:6778");
  assert.equal(e.EXPO_DEV_URL, "http://localhost:8092");
  assert.equal(e.PASEO_DEV_SEED_HOME, undefined);
  assert.equal(e.PASEO_DEV_RESET_HOME, undefined);
  assert.equal(e.NODE_OPTIONS, undefined);
});
test("reject changed lab identity", (t) => {
  const f = fixture(t);
  assert.throws(() => resolvePlan(f.root, { ...f.m, root: f.live }), /identity/);
});

test("reject live state symlink nested under lab", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  fs.mkdirSync(path.join(f.root, ".lab"));
  fs.symlinkSync(f.live, path.join(f.root, ".lab/paseo-home"));
  assert.throws(() => assertLocalPaths(p), /escapes/);
});
