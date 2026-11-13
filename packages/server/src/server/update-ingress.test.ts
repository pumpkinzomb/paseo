import { expect, it } from "vitest";
import pino from "pino";
import { AgentManager } from "./agent/agent-manager.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { UpdateAdmissionFence } from "./update-quiescence.js";
it("blocks agent creation, provider prompts and browser commands before any provider work", async () => {
  const updateAdmission = new UpdateAdmissionFence();
  const manager = new AgentManager({
    clients: {},
    logger: pino({ level: "silent" }),
    updateAdmission,
  });
  const broker = new BrowserToolsBroker({ updateAdmission });
  updateAdmission.close();
  await expect(
    manager.createAgent({ provider: "codex", cwd: "/isolated" }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("update_in_progress");
  expect(() => manager.streamAgent("missing", "do not send")).toThrow("update_in_progress");
  const result = await broker.execute({ command: { command: "list_tabs" } });
  expect(JSON.stringify(result)).toContain("update_in_progress");
  expect(updateAdmission.pending).toBe(0);
  updateAdmission.open();
  expect(() => manager.streamAgent("missing", "do not send")).not.toThrow("update_in_progress");
});

it("keeps real agent and browser ingress closed during shutdown cleanup", async () => {
  const updateAdmission = new UpdateAdmissionFence();
  const manager = new AgentManager({
    clients: {},
    logger: pino({ level: "silent" }),
    updateAdmission,
  });
  const broker = new BrowserToolsBroker({ updateAdmission });
  updateAdmission.sealForShutdown();
  // Lease disposal and plugin teardown may both attempt to reopen admission.
  updateAdmission.open();
  updateAdmission.interrupt();
  await expect(
    manager.createAgent({ provider: "codex", cwd: "/isolated" }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("update_in_progress");
  expect(() => manager.streamAgent("missing", "do not send")).toThrow("update_in_progress");
  expect(JSON.stringify(await broker.execute({ command: { command: "list_tabs" } }))).toContain(
    "update_in_progress",
  );
  expect(updateAdmission.pending).toBe(0);
});
