const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("./developer-id-policy.cjs");
const env = {
  PASEO_SIGNING_TEAM_ID: "A1B2C3D4E5",
  PASEO_SIGNING_IDENTITY: "Developer ID Application: Test Person (A1B2C3D4E5)",
};
const settings = policy.readSettings(env);
const signature = `Authority=${settings.identity}\nTeamIdentifier=${settings.teamId}\nCodeDirectory flags=0x10000(runtime)`;
test("requires explicit personal or organization identity, never guesses a team", () => {
  assert.deepEqual(settings, {
    teamId: env.PASEO_SIGNING_TEAM_ID,
    identity: env.PASEO_SIGNING_IDENTITY,
  });
  for (const input of [
    {},
    { ...env, PASEO_SIGNING_IDENTITY: "-" },
    { ...env, PASEO_SIGNING_IDENTITY: "Apple Development: Test (A1B2C3D4E5)" },
    { ...env, PASEO_SIGNING_TEAM_ID: "OTHERTEAM1" },
  ])
    assert.throws(() => policy.readSettings(input));
});
test("requires valid private-key-backed identity listing", () => {
  policy.verifyIdentityListing(settings, `  1) ${"a".repeat(40)} "${settings.identity}"`);
  assert.throws(() => policy.verifyIdentityListing(settings, "0 valid identities found"));
  assert.throws(() =>
    policy.verifyIdentityListing(
      settings,
      `  1) ${"a".repeat(40)} "${settings.identity}" (CSSMERR_TP_CERT_EXPIRED)`,
    ),
  );
});
test("preflight only reads identity inventory and rejects automatic visible smoke", () => {
  const calls = [];
  policy.preflight(env, (cmd, args) => {
    calls.push([cmd, args]);
    return `  1) ${"a".repeat(40)} "${settings.identity}"`;
  });
  assert.deepEqual(calls, [["/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]]]);
  assert.throws(() =>
    policy.preflight({ ...env, PASEO_DESKTOP_SMOKE: "1" }, () => assert.fail("must not run")),
  );
});
test("same team, Developer ID authority and hardened runtime are mandatory", () => {
  policy.verifySignature(settings, signature, { requireRuntime: true });
  for (const text of [
    "Signature=adhoc",
    signature.replace("A1B2C3D4E5", "Z9Z9Z9Z9Z9"),
    signature.replace("(runtime)", "()"),
  ])
    assert.throws(() => policy.verifySignature(settings, text, { requireRuntime: true }));
});
test("notary preparation returns only keychain-profile commands, never submits", () => {
  const plan = policy.notarizationPlan({
    profile: "paseo-personal",
    archive: "/tmp/Paseo.zip",
    app: "/tmp/Paseo.app",
  });
  assert.deepEqual(plan[0], [
    "xcrun",
    "notarytool",
    "submit",
    "/tmp/Paseo.zip",
    "--keychain-profile",
    "paseo-personal",
    "--wait",
  ]);
  assert.equal(plan.length, 4);
  assert.throws(() =>
    policy.notarizationPlan({
      profile: "password\nsecret",
      archive: "/tmp/a.zip",
      app: "/tmp/a.app",
    }),
  );
});
test("verifies all nested Mach-O with same team and does not sign or launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-signing-"));
  try {
    const app = path.join(root, "Paseo.app");
    const main = path.join(app, "Contents/MacOS/Paseo");
    const nested = path.join(app, "Contents/Frameworks/Helper.app/Contents/MacOS/Helper");
    for (const file of [main, nested]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from("cffaedfe", "hex"));
    }
    const calls = [];
    policy.verifyBundle(app, settings, (cmd, args) => {
      calls.push(args);
      return signature;
    });
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((args) => args[0] === "-d").length, 2);
    assert.throws(() =>
      policy.verifyBundle(app, settings, (_cmd, args) =>
        args.includes(nested) ? "TeamIdentifier=OTHERTEAM1" : signature,
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Developer ID config never auto-publishes/notarizes and never weakens runtime", () => {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try {
    const config = require("../../packages/desktop/electron-builder.developer-id.cjs");
    assert.equal(config.forceCodeSigning, true);
    assert.equal(config.mac.identity, "Test Person (A1B2C3D4E5)");
    assert.equal(config.mac.hardenedRuntime, true);
    assert.equal(config.mac.notarize, false);
    assert.equal(config.publish, null);
    assert.equal(config.extraMetadata.paseoDistribution.updatePolicy, "local-only");
    for (const filename of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
      const text = fs.readFileSync(
        path.join(__dirname, "../../packages/desktop/build", filename),
        "utf8",
      );
      assert.doesNotMatch(
        text,
        /disable-library-validation|allow-dyld-environment-variables|get-task-allow/,
      );
    }
  } finally {
    for (const key of Object.keys(env)) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
