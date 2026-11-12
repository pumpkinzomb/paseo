import { expect, it, vi } from "vitest";
import { Session } from "./session.js";

it("projects deleted-child hiding onto live project updates without deleting stored data", async () => {
  const emit = vi.fn();
  const descriptor = vi.fn();
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    wantsEvent: () => true,
    workspaceDirectory: { listVisibleProjects: async () => [] },
    directorySync: { sequenceProjectUpdate: (payload: unknown) => payload },
    buildProjectDescriptor: descriptor,
    emit,
  });
  await Reflect.get(session, "publishProjectUpdate").call(session, {
    kind: "upsert",
    project: { projectId: "deleted-child-project" },
  });
  expect(descriptor).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith({
    type: "project.update",
    payload: { kind: "remove", projectId: "deleted-child-project" },
  });
});

it("restores live project visibility when a new workspace makes the project visible again", async () => {
  const emit = vi.fn();
  const project = { projectId: "project" };
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    wantsEvent: () => true,
    workspaceDirectory: { listVisibleProjects: async () => [project] },
    directorySync: { sequenceProjectUpdate: (payload: unknown) => payload },
    buildProjectDescriptor: async () => project,
    emit,
  });
  await Reflect.get(session, "publishProjectUpdate").call(session, { kind: "upsert", project });
  expect(emit).toHaveBeenCalledWith({
    type: "project.update",
    payload: { kind: "upsert", project },
  });
});

it("uses the same visible projects for the separate project-list channel", async () => {
  const emit = vi.fn();
  const project = { projectId: "fresh-user-project" };
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    workspaceDirectory: { listVisibleProjects: async () => [project] },
    buildProjectDescriptor: async (entry: unknown) => entry,
    emit,
  });
  await Reflect.get(session, "handleProjectListRequest").call(session, {
    type: "project.list.request",
    requestId: "list",
  });
  expect(emit).toHaveBeenCalledWith({
    type: "project.list.response",
    payload: { requestId: "list", projects: [project] },
  });
});
