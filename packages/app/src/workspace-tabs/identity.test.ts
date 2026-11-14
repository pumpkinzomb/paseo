import { z } from "zod";
import { WorkspaceLayoutPersistedStateSchema } from "@/stores/workspace-layout-storage";
import { panelResourceKey } from "@/panels/panel-manifest";
import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

describe("New tab identity", () => {
  it("stays outside deterministic target identity", () => {
    const target = { kind: "new_tab" } as const;

    expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
    expect(workspaceTabTargetsEqual(target, target)).toBe(false);
    expect(() => buildDeterministicWorkspaceTabId(target)).toThrow(
      "New tabs do not have deterministic target identities",
    );
  });
});

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("working diff tab identity", () => {
  const target = {
    kind: "working_diff" as const,
    focusPath: "src/example.ts",
    focusRequestId: 1,
  };

  it("normalizes file focus navigation", () => {
    expect(
      normalizeWorkspaceTabTarget({
        ...target,
        focusPath: " src\\example.ts ",
      }),
    ).toEqual(target);
  });

  it("treats focus as navigation state rather than tab identity", () => {
    expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, focusPath: "src/other.ts" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, focusRequestId: 2 })).toBe(false);
    const workingDiffId = buildDeterministicWorkspaceTabId(target);
    const otherFocusId = buildDeterministicWorkspaceTabId({
      ...target,
      focusPath: "src/other.ts",
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: target.focusPath,
    });

    expect(workingDiffId).toBe("working_diff");
    expect(workingDiffId).toBe(otherFocusId);
    expect(workingDiffId).not.toBe(fileId);
  });
});

describe("workspace utility panel identity", () => {
  it.each(["files", "pull_request"] as const)(
    "normalizes and deterministically keys %s",
    (kind) => {
      const target = { kind };

      expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
      expect(buildDeterministicWorkspaceTabId(target)).toBe(kind);
      expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    },
  );
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});

describe("plugin panel tab identity", () => {
  it("normalizes exact workspace and agent context", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "plugin",
        pluginId: " review ",
        panelId: " details ",
        context: "agent",
        agentId: " agent-1 ",
      }),
    ).toEqual({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });
  });

  it("gives workspace and agent instances distinct stable ids", () => {
    const workspace = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "workspace",
    });
    const agent = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });

    expect(workspace).toBe("plugin_workspace_6_review_7_details");
    expect(agent).toBe("plugin_agent_6_review_7_details_7_agent-1");
  });
});

it("pins development source and evidence in file and diff target identity", () => {
  const developmentReview = {
    serverId: "host",
    parentWorkspaceId: "parent",
    workspaceId: "source",
    evidenceId: "review-a",
  };
  const file = { kind: "file" as const, path: " spaced\tname\n", developmentReview };
  expect(normalizeWorkspaceTabTarget(file)).toEqual(file);
  expect(panelResourceKey(file)).not.toBe(
    panelResourceKey({
      ...file,
      developmentReview: { ...developmentReview, workspaceId: "other" },
    }),
  );
  expect(
    workspaceTabTargetsEqual(file, {
      ...file,
      developmentReview: { ...developmentReview, evidenceId: "review-b" },
    }),
  ).toBe(false);
  expect(buildDeterministicWorkspaceTabId(file)).not.toBe(
    buildDeterministicWorkspaceTabId({ kind: "file", path: file.path }),
  );
  const diff = { kind: "working_diff" as const, developmentReview };
  expect(normalizeWorkspaceTabTarget(diff)).toEqual(diff);
  expect(panelResourceKey(diff)).not.toBe(panelResourceKey({ kind: "working_diff" }));
  expect(workspaceTabTargetsEqual(diff, { kind: "working_diff" })).toBe(false);
  expect(buildDeterministicWorkspaceTabId(diff)).not.toBe("working_diff");
});

it("keeps pinned file identity stable across persisted property order changes", () => {
  const target = {
    kind: "file" as const,
    path: "same.ts",
    developmentReview: {
      serverId: "host",
      parentWorkspaceId: "parent",
      workspaceId: "source",
      scopeToken: "token",
      evidenceId: "capture",
    },
  };
  const persisted = WorkspaceLayoutPersistedStateSchema.parse(
    JSON.parse(
      JSON.stringify({
        layoutByWorkspace: {
          workspace: {
            root: {
              kind: "pane",
              pane: {
                id: "pane",
                tabIds: ["file"],
                focusedTabId: "file",
                tabs: [{ tabId: "file", target, createdAt: 0 }],
              },
            },
            focusedPaneId: "pane",
          },
        },
      }),
    ),
  );
  const node = persisted.layoutByWorkspace.workspace.root;
  if (node.kind !== "pane") throw new Error("fixture pane missing");
  const stored = z
    .object({
      pane: z.object({
        tabs: z.array(
          z.object({
            target: z.object({
              kind: z.literal("file"),
              path: z.string(),
              developmentReview: z.object({
                scopeToken: z.string(),
                serverId: z.string(),
                parentWorkspaceId: z.string(),
                workspaceId: z.string(),
                evidenceId: z.string(),
              }),
            }),
          }),
        ),
      }),
    })
    .parse(node);
  const restored = stored.pane.tabs[0].target;
  if (!restored) throw new Error("fixture target missing");
  expect(workspaceTabTargetsEqual(target, restored)).toBe(true);
  expect(buildDeterministicWorkspaceTabId(restored)).toBe(buildDeterministicWorkspaceTabId(target));
  expect(panelResourceKey(restored)).toBe(panelResourceKey(target));
});
