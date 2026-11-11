import path from "node:path";
import { createDiscovery, validateDiscoveryConfig } from "./dev-update-discovery.mjs";
import { stageFullRelease } from "./dev-update-full-stage.mjs";
import { validateCandidateLaunch } from "./dev-update-validation.mjs";
import { readJson, readOptionalJson, verifyRelease, acquireLock } from "./dev-update-store.mjs";

/** Detection never chooses a new quit/restart policy. Only the existing supervisor applies queued code. */
export async function configuredDiscovery(
  control,
  {
    factory = createDiscovery,
    validateLaunch = validateCandidateLaunch,
    stageFull = stageFullRelease,
  } = {},
) {
  const runtime = await readJson(path.join(control, "config.json"));
  const source = await readOptionalJson(path.join(control, "update-discovery.json"));
  if (!source?.enabled) return null;
  const config = {
    ...source,
    releases: runtime.releases,
    protectedPaths: [
      control,
      runtime.releases,
      runtime.home,
      runtime.userData,
      ...(source.sourceRepository ? [source.sourceRepository] : []),
    ],
  };
  await validateDiscoveryConfig(config);
  return factory({
    config,
    control,
    readCurrent: async () => {
      const state = await readJson(path.join(control, "state.json"));
      const release = await verifyRelease(runtime.releases, state.current.id, state.current.digest);
      return { ...release, ...state.current, pending: state.pending, transition: state.transition };
    },
    stageFull: (options) => stageFull({ ...options, protectedPaths: config.protectedPaths }),
    validateLaunch: ({ root }) =>
      validateLaunch({ root, workRoot: path.join(config.cacheRoot, "validation") }),
  });
}

export async function runDiscoveryWatch(control, { signal, create = configuredDiscovery } = {}) {
  if (!signal) throw new Error("A watcher shutdown signal is required");
  const releaseLock = await acquireLock(control, "discovery-watcher.lock");
  let watcher;
  try {
    watcher = await create(control);
    if (!watcher) throw new Error("Update discovery is not enabled");
    watcher.start();
    if (!signal?.aborted)
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
  } finally {
    await watcher?.stop();
    await releaseLock();
  }
}
