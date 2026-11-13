#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalPaths, labEnv, resolvePlan } from "../../../scripts/isolated-lab.mjs";

/** Opt-in workflow boundary. It is not an OS sandbox for arbitrary shell commands. */
export function assertIsolatedDevEnvironment(root, env) {
  if (env.PASEO_ISOLATED_DEV !== "1") throw new Error("Explicit isolated dev mode is required");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".lab-config.json"), "utf8"));
  if (!Array.isArray(manifest.protectedRoots) || manifest.protectedRoots.length === 0)
    throw new Error("Protected runtime roots are required");
  const plan = resolvePlan(root, manifest);
  assertLocalPaths(plan);
  const expected = { ...labEnv(plan, {}), PASEO_ISOLATED_DEV: "1" };
  for (const key of [
    "PASEO_HOME",
    "PASEO_DEV_ROOT",
    "PASEO_DEV_MANAGED_HOME",
    "PASEO_LISTEN",
    "PASEO_DAEMON_ENDPOINT",
    "PASEO_DEV_DAEMON_ENDPOINT",
    "PASEO_ELECTRON_USER_DATA_DIR",
    "EXPO_PORT",
    "EXPO_DEV_URL",
  ]) {
    if (env[key] !== expected[key])
      throw new Error(`Isolated dev requires its explicit lab ${key}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (/^(PASEO_|EXPO_)/.test(key) && value !== undefined && value !== expected[key])
      throw new Error(`Inherited override is not allowed in isolated dev: ${key}`);
    if (["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(key) && value)
      throw new Error(`Inherited execution override is not allowed: ${key}`);
  }
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected explicit lab root");
    assertIsolatedDevEnvironment(process.argv[2], process.env);
  } catch (error) {
    console.error(`[isolated-dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
