import { app } from "electron";
import {
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint,
} from "../daemon/runtime-paths.js";
import { runExternalCliJsonCommand } from "../daemon/cli/external.js";
import { getBundledCliShimPath } from "../integrations/cli-install/index.js";
import {
  validateExactDaemonUpdate,
  type ExactDaemonUpdate,
  type HandoffIdentity,
} from "./installed-daemon-handoff.js";

/** Trusted main-owned verifier functions, not booleans or renderer arguments. */
export interface OfficialUpdateAuthority {
  verifyApprovedCapability(capability: ExactDaemonUpdate): Promise<void>;
  verifyRunningBundle(revision: string, version: string): Promise<void>;
  /** Requires the exact daemon admission ticket irreversibly committed to shutdown. */
  assertCommittedAdmission(expected: HandoffIdentity): Promise<void>;
}
function sameInstance(a: HandoffIdentity, b: HandoffIdentity) {
  return ["uid", "home", "serverId", "pid", "startedAt", "listen", "version"].every(
    (key) => a[key as keyof HandoffIdentity] === b[key as keyof HandoffIdentity],
  );
}

/** Actual official APIs; not registered on IPC or enabled in production. */
export function createOfficialDaemonLifecycle(
  capability: ExactDaemonUpdate,
  authority: OfficialUpdateAuthority,
) {
  validateExactDaemonUpdate(capability);
  if (!app.isPackaged) throw Error("Installed bundle required for official update lifecycle");
  const c = structuredClone(capability);
  async function authorize() {
    if (c.original.uid !== process.getuid!()) throw Error("Update owner mismatch");
    await authority.verifyApprovedCapability(c);
  }
  async function readExactInstance(): Promise<HandoffIdentity | null> {
    await authorize();
    const first = await readDaemonInstance(c.original.home);
    if (!first) return null;
    const status = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      c.original.home,
      "--json",
    ])) as Record<string, unknown>;
    const second = await readDaemonInstance(c.original.home);
    if (
      !second ||
      second.pid !== first.pid ||
      second.startedAt !== first.startedAt ||
      second.uid !== c.original.uid ||
      second.serverId !== c.original.serverId ||
      second.listen !== c.original.listen ||
      status.localDaemon !== "running" ||
      status.pid !== second.pid ||
      status.startedAt !== second.startedAt ||
      status.serverId !== second.serverId ||
      status.listen !== second.listen ||
      typeof status.daemonVersion !== "string"
    )
      throw Error("Exact daemon probe changed or failed");
    return {
      uid: second.uid,
      home: c.original.home,
      serverId: second.serverId,
      pid: second.pid,
      startedAt: second.startedAt,
      listen: second.listen,
      version: status.daemonVersion,
    };
  }
  return {
    readExactInstance,
    async stopOfficial(expected: HandoffIdentity): Promise<void> {
      await authorize();
      if (!sameInstance(expected, c.original)) throw Error("Stop not bound to original instance");
      await authority.assertCommittedAdmission(expected);
      const live = await readExactInstance();
      if (!live || !sameInstance(live, expected))
        throw Error("Original daemon changed before official stop");
      const captured = await readDaemonInstance(c.original.home);
      if (!captured || captured.pid !== expected.pid || captured.startedAt !== expected.startedAt)
        throw Error("Original daemon replaced");
      const result = await stopDaemonInstance(c.original.home, {
        instance: captured,
        force: false,
        keepTerminals: true,
        timeoutMs: 20_000,
        requestShutdown: async (ready) => {
          if (
            ready.pid !== expected.pid ||
            ready.startedAt !== expected.startedAt ||
            ready.listen !== expected.listen
          )
            throw Error("Shutdown target changed");
          await authority.assertCommittedAdmission(expected);
          await runExternalCliJsonCommand([
            "daemon",
            "stop",
            "--host",
            ready.listen,
            "--keep-terminals",
            "--timeout",
            "20",
            "--json",
          ]);
        },
      });
      if (result.forced || !result.usedLifecycleRpc || (await readDaemonInstance(c.original.home)))
        throw Error("Graceful daemon stop not verified");
    },
    async startApprovedRevision(
      revision: string,
      original: HandoffIdentity,
    ): Promise<HandoffIdentity> {
      await authorize();
      if (
        !sameInstance(original, c.original) ||
        ![c.oldRevision, c.nextRevision].includes(revision)
      )
        throw Error("Start not bound to exact update");
      const version = revision === c.nextRevision ? c.nextVersion : c.original.version;
      await authority.verifyRunningBundle(revision, version);
      if (await readDaemonInstance(c.original.home))
        throw Error("Refusing to adopt existing daemon during update start");
      const invocation = createNodeEntrypointInvocation({
        entrypoint: resolveDaemonRunnerEntrypoint(),
        argvMode: "node-script",
        args: [],
        baseEnv: process.env,
      });
      const result = await startDaemonInstance({
        home: c.original.home,
        ...invocation,
        env: {
          ...invocation.env,
          PASEO_CLI: getBundledCliShimPath(),
          PASEO_INSTALLED_UPDATE_CONTROL: "1",
        },
        mode: "managed",
        desktopManaged: false,
        timeoutMs: 30_000,
      });
      if (!result.spawned) throw Error("Another daemon won update start");
      const live = await readExactInstance();
      if (
        !live ||
        live.pid !== result.instance.pid ||
        live.startedAt !== result.instance.startedAt ||
        live.version !== version
      )
        throw Error("Started approved daemon not verified");
      return live;
    },
  };
}
