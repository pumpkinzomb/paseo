import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

it("preload exposes only literal local-update status and validated token requests", async () => {
  const invoke = vi.fn(async () => ({}));
  let bridge:
    | { localUpdate: { status(): Promise<unknown>; request(token: string): Promise<void> } }
    | undefined;
  const source = readFileSync(fileURLToPath(new URL("../preload.ts", import.meta.url)), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(output, {
    exports: {},
    window: { addEventListener: vi.fn() },
    process: { argv: [], platform: "darwin" },
    require: (name: string) => {
      if (name !== "electron") throw Error("Unexpected runtime import");
      return {
        contextBridge: {
          exposeInMainWorld: (_key: string, value: typeof bridge) => {
            bridge = value;
          },
        },
        ipcRenderer: { invoke },
        webUtils: {},
      };
    },
  });
  await bridge!.localUpdate.status();
  expect(invoke).toHaveBeenLastCalledWith("local-update:status");
  await bridge!.localUpdate.request("a".repeat(64));
  expect(invoke).toHaveBeenLastCalledWith("local-update:request", "a".repeat(64));
  await expect(bridge!.localUpdate.request("../../app")).rejects.toThrow(
    "Invalid local update token",
  );
  expect(invoke).toHaveBeenCalledTimes(2);
});
