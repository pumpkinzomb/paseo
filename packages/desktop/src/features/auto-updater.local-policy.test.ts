import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
}));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: vi.fn() } }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks }));
vi.mock("./app-distribution-policy.js", () => ({ allowsUpstreamAppUpdates: () => false }));
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  installAppUpdateOnQuit,
} from "./auto-updater.js";
it("never initializes, checks, downloads, or installs upstream for a local distribution", async () => {
  const input = { currentVersion: "0.15.4", releaseChannel: "stable" as const };
  const result = await checkForAppUpdate({ ...input, intent: "manual" });
  expect(result.hasUpdate).toBe(false);
  expect(result.readyToInstall).toBe(false);
  expect((await downloadAndInstallUpdate(input)).installed).toBe(false);
  expect(await installAppUpdateOnQuit({ ...input, signal: new AbortController().signal })).toBe(
    false,
  );
  for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
});
