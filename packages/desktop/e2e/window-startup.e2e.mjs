import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-window-startup-")));
const modulePath = fileURLToPath(new URL("../dist/window/show-when-ready.js", import.meta.url));

async function launchWindowWithoutHiddenFrames() {
  const main = path.join(root, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
     const { showWindowWhenReady } = require(${JSON.stringify(modulePath)});
     app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
     app.whenReady().then(async () => {
       const win = global.mainWindow = new BrowserWindow({ show: false, paintWhenInitiallyHidden: false });
       showWindowWhenReady(win, { showOnLoad: true });
       await win.loadURL("data:text/html,<h1>Desktop ready</h1>");
       global.visibleAfterLoad = win.isVisible();
     });`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
  );
  const displayArgs = process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu"] : [];
  return electron.launch({
    args: ["--no-sandbox", ...displayArgs, main],
    env,
  });
}

async function expectLoadedDesktopIsShown(desktop) {
  await expect.poll(() => desktop.evaluate(() => global.visibleAfterLoad)).toBe(true);
  const page = await desktop.firstWindow();
  await expect(page.getByRole("heading", { name: "Desktop ready" })).toBeVisible();
}

const handoffPath = fileURLToPath(new URL("../dist/dev-update/handoff.js", import.meta.url));
const quitLifecyclePath = fileURLToPath(
  new URL("../dist/daemon/quit-lifecycle.js", import.meta.url),
);
const control = path.join(root, "control");
const updateUserData = path.join(root, "update-user-data");
const countsFile = path.join(root, "quit-counts.json");

async function launchUpdateWindow({ replacement = false } = {}) {
  const main = path.join(root, replacement ? "replacement.cjs" : "update.cjs");
  await writeFile(
    main,
    `
    const { app, BrowserWindow, webContents } = require("electron");
    const fs = require("node:fs");
    const { createDevUpdateHandoff } = require(${JSON.stringify(handoffPath)});
    const { createQuitLifecycle } = require(${JSON.stringify(quitLifecyclePath)});
    app.setPath("userData", ${JSON.stringify(updateUserData)});
    global.actualUserData = app.getPath("userData");
    const counts = { stop: 0, updater: 0, transportClose: 0 };
    const saveCounts = () => fs.writeFileSync(${JSON.stringify(countsFile)}, JSON.stringify(counts));
    saveCounts();
    const handoff = createDevUpdateHandoff({
      isPackaged: false,
      directory: ${JSON.stringify(control)},
      generation: "e2e-generation",
      windowCount: () => BrowserWindow.getAllWindows().length,
      webContentsCount: () => webContents.getAllWebContents().length,
      quit: () => app.quit(),
      onError: (error) => { throw error; },
    });
    const lifecycle = createQuitLifecycle({
      app,
      closeTransportSessions: () => { counts.transportClose++; saveCounts(); },
      isDevUpdateCommitted: handoff.isCommitted,
      stopDesktopManagedDaemonIfNeeded: async () => { counts.stop++; saveCounts(); return false; },
      installAppUpdateOnQuit: async () => { counts.updater++; saveCounts(); return false; },
      createUpdateDeadlineSignal: () => AbortSignal.timeout(1000),
      onStopError: (error) => { throw error; },
      onUpdateError: (error) => { throw error; },
    });
    app.on("before-quit", () => handoff.dispose());
    app.on("before-quit", lifecycle.handleBeforeQuit);
    app.on("window-all-closed", () => {});
    app.whenReady().then(async () => {
      const finish = handoff.beginWindowCreation();
      try {
        const win = global.mainWindow = new BrowserWindow({ show: true });
        await win.loadURL("data:text/html,<h1>${replacement ? "Replacement ready" : "Update waiting"}</h1><input aria-label='Draft'>");
      } finally { finish(); }
      handoff.start();
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(PASEO_|EXPO_)/.test(key) && key !== "ELECTRON_RUN_AS_NODE" && key !== "NODE_OPTIONS",
    ),
  );
  const displayArgs = process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu"] : [];
  return electron.launch({ args: ["--no-sandbox", ...displayArgs, main], env });
}

async function readHandoffResult() {
  try {
    return JSON.parse(await readFile(path.join(control, "result.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

let desktop;
try {
  desktop = await launchWindowWithoutHiddenFrames();
  await expectLoadedDesktopIsShown(desktop);
  console.log("Loaded desktop is visible without hidden compositor frames");
  await desktop.close();
  desktop = undefined;

  await mkdir(control, { mode: 0o700 });
  desktop = await launchUpdateWindow();
  const page = await desktop.firstWindow();
  await page.getByRole("textbox", { name: "Draft" }).fill("Unsent draft must remain untouched");
  await writeFile(
    path.join(control, "request.json"),
    JSON.stringify({
      schemaVersion: 1,
      generation: "e2e-generation",
      requestId: "renderer-release.1",
    }),
  );
  await expect.poll(async () => (await readHandoffResult())?.state).toBe("waiting-for-windows");
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "Unsent draft must remain untouched",
  );
  expect(await desktop.evaluate(() => global.actualUserData)).toBe(updateUserData);
  expect(JSON.parse(await readFile(countsFile, "utf8"))).toEqual({
    stop: 0,
    updater: 0,
    transportClose: 0,
  });
  console.log("Update request leaves the open renderer and unsent draft intact");

  const exited = desktop.waitForEvent("close", { timeout: 15_000 });
  // Only this isolated fixture's own window is voluntarily closed.
  await desktop.evaluate(() => global.mainWindow.close());
  await exited;
  desktop = undefined;
  expect(await readHandoffResult()).toMatchObject({
    schemaVersion: 1,
    generation: "e2e-generation",
    requestId: "renderer-release.1",
    state: "ready",
  });
  expect(JSON.parse(await readFile(countsFile, "utf8"))).toEqual({
    stop: 0,
    updater: 0,
    transportClose: 1,
  });
  console.log("Closed-window handoff exits Electron without stopping daemon or invoking updater");

  // A fresh supervisor generation would have a fresh control directory. Remove
  // this fixture request before manually modeling that relaunch with its profile.
  await rm(path.join(control, "request.json"));
  desktop = await launchUpdateWindow({ replacement: true });
  const replacementPage = await desktop.firstWindow();
  await expect(replacementPage.getByRole("heading", { name: "Replacement ready" })).toBeVisible();
  expect(await desktop.evaluate(() => global.actualUserData)).toBe(updateUserData);
  console.log("Replacement Electron window launches using the same isolated profile");
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
