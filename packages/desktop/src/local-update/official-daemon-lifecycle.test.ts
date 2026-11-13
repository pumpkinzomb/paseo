import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cli: vi.fn(),
  invocation: vi.fn(),
  entry: vi.fn(),
}));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("@getpaseo/server/daemon-control", () => ({
  readDaemonInstance: mocks.read,
  startDaemonInstance: mocks.start,
  stopDaemonInstance: mocks.stop,
}));
vi.mock("../daemon/runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.invocation,
  resolveDaemonRunnerEntrypoint: mocks.entry,
}));
vi.mock("../daemon/cli/external.js", () => ({ runExternalCliJsonCommand: mocks.cli }));
vi.mock("../integrations/cli-install/index.js", () => ({
  getBundledCliShimPath: () => "/bundled/cli",
}));
import { createOfficialDaemonLifecycle } from "./official-daemon-lifecycle.js";
const original = {
  uid: process.getuid!(),
  home: "/private/fixture",
  serverId: "srv_test",
  pid: 100,
  startedAt: "old",
  listen: "127.0.0.1:12345",
  version: "1.0.0",
};
const capability = {
  schemaVersion: 1 as const,
  token: "a".repeat(32),
  oldRevision: "b".repeat(40),
  nextRevision: "c".repeat(40),
  nextVersion: "1.1.0",
  original,
};
const authority = () => ({
  verifyApprovedCapability: vi.fn().mockResolvedValue(undefined),
  verifyRunningBundle: vi.fn().mockResolvedValue(undefined),
  assertCommittedAdmission: vi.fn().mockResolvedValue(undefined),
});
beforeEach(() => vi.resetAllMocks());
it("denied main approval cannot probe, stop or start", async () => {
  const a = authority();
  a.verifyApprovedCapability.mockRejectedValue(Error("denied"));
  const lifecycle = createOfficialDaemonLifecycle(capability, a);
  await expect(lifecycle.stopOfficial(original)).rejects.toThrow("denied");
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
});
it("requires committed admission before accessing original process", async () => {
  const a = authority();
  a.assertCommittedAdmission.mockRejectedValue(Error("unsealed"));
  const lifecycle = createOfficialDaemonLifecycle(capability, a);
  await expect(lifecycle.stopOfficial(original)).rejects.toThrow("unsealed");
  expect(mocks.read).not.toHaveBeenCalled();
});
it("does not adopt an existing process during approved start", async () => {
  mocks.read.mockResolvedValue(original);
  const a = authority();
  const lifecycle = createOfficialDaemonLifecycle(capability, a);
  await expect(lifecycle.startApprovedRevision(capability.nextRevision, original)).rejects.toThrow(
    "Refusing to adopt",
  );
  expect(a.verifyRunningBundle).toHaveBeenCalledWith(capability.nextRevision, "1.1.0");
  expect(mocks.start).not.toHaveBeenCalled();
});
it("rejects changed status identity instead of routing by listen alone", async () => {
  mocks.read.mockResolvedValue(original);
  mocks.cli.mockResolvedValue({
    localDaemon: "running",
    ...original,
    serverId: "other",
    daemonVersion: "1.0.0",
  });
  await expect(
    createOfficialDaemonLifecycle(capability, authority()).readExactInstance(),
  ).rejects.toThrow("probe changed");
});
