import { expect, it } from "vitest";
import { ProjectRemoveRequestSchema } from "./messages.js";
const request = {
  type: "project.remove.request",
  requestId: "request",
  projectId: "project",
  deleteSessions: { workspaceIds: ["workspace"], agentIds: ["agent"] },
};
it("only permits explicit original-session removal, never source/root directory deletion", () => {
  expect(
    ProjectRemoveRequestSchema.safeParse({ ...request, deleteNativeSessions: true }).success,
  ).toBe(true);
  expect(
    ProjectRemoveRequestSchema.safeParse({ ...request, deleteNativeSessions: false }).success,
  ).toBe(false);
  for (const extra of [
    { deleteSourceFiles: true },
    { sourcePaths: ["/Applications/Paseo.app"] },
    { deleteDirectory: "/Users/user/project" },
    { home: "/Users/user/.claude" },
    { sourcePaths: ["/Users/user", "/Users/user/project/link-to-live-app"] },
  ])
    expect(ProjectRemoveRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
});
it("keeps old local-record-only callers valid without silently expanding their deletion scope", () => {
  expect(ProjectRemoveRequestSchema.parse(request).deleteNativeSessions).toBeUndefined();
});
