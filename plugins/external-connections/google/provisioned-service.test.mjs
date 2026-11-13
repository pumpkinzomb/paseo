import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProvisionedGoogleService } from "./provisioned-service.mjs";

test("provisioning saves public clientId in file and secret only in injected secure store", async (t) => {
  const temp = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "paseo-google-provision-"),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const records = new Map();
  const store = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    delete: async (key) => {
      records.delete(key);
    },
  };
  const service = createProvisionedGoogleService({ stateDirectory: temp, store });
  t.after(() => service.dispose());
  assert.equal((await service.status()).reason, "oauth-client-missing");
  assert.deepEqual(
    await service.configure({
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
    }),
    { configured: true },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, "google-client.json"), "utf8")), {
    clientId: "fixture.apps.googleusercontent.com",
  });
  assert.equal(JSON.parse(records.get("paseo-google-client")).clientSecret, "fixture-secret");
  assert.deepEqual(await service.status(), { status: "not-connected", scopes: [] });
  assert.equal(JSON.stringify(await service.status()).includes("fixture-secret"), false);
});
test("missing secure store and invalid client config fail closed", async (t) => {
  const temp = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "paseo-google-provision-"),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const service = createProvisionedGoogleService({ stateDirectory: temp });
  t.after(() => service.dispose());
  await assert.rejects(
    service.configure({ clientId: "fixture.apps.googleusercontent.com" }),
    /SECURE_STORE_UNAVAILABLE/,
  );
  assert.deepEqual(await fs.readdir(temp), []);
});
