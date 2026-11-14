import { expect, it } from "vitest";
import type { WorkspaceTaskFinalization } from "@getpaseo/protocol/messages";
import { reviewTaskFinalization } from "./finalize.js";

const task: WorkspaceTaskFinalization = {
  id: "approval",
  phase: "pending",
  workspaceId: "task",
  serverId: "host",
  root: "/fixture/task",
  rootDevice: 1,
  rootInode: 2,
  branch: "task-reviewed",
  headSha: "a".repeat(40),
  sourceWorkspaceId: "source",
  repository: "identity",
  evidenceId: "evidence",
  appliedRevision: "b".repeat(40),
  disposableRoots: ["node_modules/"],
  ownershipProof: "creator-and-parent-evidence",
  ownershipRevision: "ownership",
  lead: { serverId: "host", roomWorkspaceId: "room", logicalId: "logical", anchorAgentId: "lead" },
  approvedAt: "now",
  updatedAt: "now",
};
function fixture() {
  const calls: string[] = [];
  const client = {
    inspectWorkspaceTaskFinalization: async (id: string) => {
      calls.push(`inspect:${id}`);
      return { workspaceId: id, name: "Task", previewToken: "same-connection", task, blockers: [] };
    },
    applyWorkspaceTaskFinalization: async (token: string) => {
      calls.push(`apply:${token}`);
      return { task: { ...task, phase: "retired" as const } };
    },
    getWorkspaceTaskFinalization: async (id: string) => {
      calls.push(`status:${id}`);
      return { task };
    },
  };
  const interaction = {
    interactive: true,
    preview: () => {
      calls.push("preview");
    },
    confirm: async () => {
      calls.push("confirm");
      return `finalize ${task.headSha}`;
    },
  };
  return { client, interaction, calls };
}
it("reviews and explicitly confirms the exact tip on the same connected client before apply", async () => {
  const f = fixture();
  const result = await reviewTaskFinalization(f.client, "task", "apply", f.interaction);
  expect(result).toEqual({ task: { ...task, phase: "retired" } });
  expect(f.calls).toEqual(["inspect:task", "preview", "confirm", "apply:same-connection"]);
});
it("inspect and status never apply or ask for an approval token from another invocation", async () => {
  const f = fixture();
  await reviewTaskFinalization(f.client, "task", "inspect", f.interaction);
  await reviewTaskFinalization(f.client, "task", "status", f.interaction);
  expect(f.calls).toEqual(["inspect:task", "status:task"]);
});
it("refuses noninteractive or generic yes responses without silently approving cleanup", async () => {
  const f = fixture();
  await expect(
    reviewTaskFinalization(f.client, "task", "apply", { ...f.interaction, interactive: false }),
  ).rejects.toThrow("Interactive");
  await expect(
    reviewTaskFinalization(f.client, "task", "apply", {
      ...f.interaction,
      confirm: async () => "yes",
    }),
  ).rejects.toThrow("canceled");
  expect(f.calls).not.toContain("apply:same-connection");
});
