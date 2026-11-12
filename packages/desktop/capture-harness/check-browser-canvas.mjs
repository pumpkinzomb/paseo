import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolvePlan, assertLocalPaths, labEnv } from "../../../scripts/isolated-lab.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const plan = resolvePlan(
  root,
  JSON.parse(fs.readFileSync(path.join(root, ".lab-config.json"), "utf8")),
);
assertLocalPaths(plan);
const out = path.join(plan.state, "browser-canvas-test");
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, "packages/app/src/desktop/browser/resident-webviews.ts")],
  outfile: path.join(out, "resident-webviews.js"),
  bundle: true,
  format: "iife",
  globalName: "BrowserCanvasHarness",
  platform: "browser",
  // The fixture supplies profileHost explicitly. App-host discovery and overlay
  // stacking are outside this pixel test; webview lifecycle/style code is real.
  plugins: [
    {
      name: "fixture-host-adapters",
      setup(build) {
        build.onResolve({ filter: /^@\/(desktop\/host|lib\/overlay-root)$/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("host")
            ? "export const getDesktopHost = () => undefined;"
            : "export const WEB_SURFACE_PLANE = {browser:0,overlay:1};",
          loader: "js",
        }));
      },
    },
  ],
});
const child = spawn(
  path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  [path.join(root, "packages/desktop/capture-harness/browser-canvas.cjs")],
  {
    cwd: root,
    env: { ...labEnv(plan, process.env), PASEO_CANVAS_TEST_OUT: out },
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  throw error;
});
process.exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
