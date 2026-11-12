import { expect, test } from "vitest";
import { builtinHostContext } from "./host-context.js";
test("only trusted external-connections builtin gets daemon-owned paths", () => {
  expect(builtinHostContext("external-connections", "/trusted/plugins/external-connections", "/host/plugin-settings")).toEqual({ stateDirectory: "/host/plugin-settings/external-connections-host", pluginDirectory: "/trusted/plugins/external-connections", runtimeMode: "packaged" });
  expect(builtinHostContext("other", "/trusted/other", "/host/plugin-settings")).toBeUndefined();
  expect(builtinHostContext("../external-connections", "/trusted/other", "/host/plugin-settings")).toBeUndefined();
});
test("missing or relative host paths fail closed", () => {
  expect(builtinHostContext("external-connections", "/trusted/plugin")).toBeUndefined();
  expect(builtinHostContext("external-connections", "/trusted/plugin", "relative")).toBeUndefined();
  expect(builtinHostContext("external-connections", "relative", "/host/settings")).toBeUndefined();
});
