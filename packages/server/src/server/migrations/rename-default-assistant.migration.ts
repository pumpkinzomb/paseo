// COMPAT(leadAgentRename): added on 2026-11-11, delete after 2027-05-11 once
// installations created before the "Lead agent" rename have started at least once.
//
// The default assistant used to store "Assistant" as its agent title, scratch project
// customName and scratch workspace title. This renames only values that still equal
// that auto-generated default and belong to the assistant: agents carrying the
// `paseo.role=assistant` label, and projects/workspaces rooted in a scratch directory
// produced by `assistantWorkspaceDirectory`. User-chosen names, user projects the
// assistant was opened in, and every other record stay untouched. Re-running it is a
// no-op because renamed values no longer match the legacy default.
import type { Logger } from "pino";

import type { AgentStorage } from "../agent/agent-storage.js";
import {
  DEFAULT_ASSISTANT_DISPLAY_NAME,
  LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME,
  isAssistantScratchDirectory,
} from "../default-assistant/index.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";

export interface RenameDefaultAssistantResult {
  agents: number;
  projects: number;
  workspaces: number;
}

export async function renameLegacyDefaultAssistantNames(options: {
  paseoHome: string;
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<RenameDefaultAssistantResult> {
  const result: RenameDefaultAssistantResult = { agents: 0, projects: 0, workspaces: 0 };
  const isScratch = (directory: string) =>
    isAssistantScratchDirectory({ paseoHome: options.paseoHome, directory });

  for (const project of await options.projectRegistry.list()) {
    if (project.customName !== LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME) continue;
    if (!isScratch(project.rootPath)) continue;
    const updated = await options.projectRegistry.update(project.projectId, (current) =>
      current.customName === LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME
        ? { ...current, customName: DEFAULT_ASSISTANT_DISPLAY_NAME }
        : current,
    );
    if (updated?.customName === DEFAULT_ASSISTANT_DISPLAY_NAME) result.projects += 1;
  }

  for (const workspace of await options.workspaceRegistry.listAll()) {
    if (workspace.title !== LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME) continue;
    if (!isScratch(workspace.cwd)) continue;
    const updated = await options.workspaceRegistry.update(workspace.workspaceId, (current) =>
      current.title === LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME
        ? { ...current, title: DEFAULT_ASSISTANT_DISPLAY_NAME }
        : current,
    );
    if (updated?.title === DEFAULT_ASSISTANT_DISPLAY_NAME) result.workspaces += 1;
  }

  for (const record of await options.agentStorage.listAll()) {
    if (record.labels["paseo.role"] !== "assistant") continue;
    if (record.title !== LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME) continue;
    await options.agentStorage.upsert({ ...record, title: DEFAULT_ASSISTANT_DISPLAY_NAME });
    result.agents += 1;
  }

  if (result.agents + result.projects + result.workspaces > 0) {
    options.logger.info(result, "Renamed legacy default assistant names to Lead agent");
  }
  return result;
}
