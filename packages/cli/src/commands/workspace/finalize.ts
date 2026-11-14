import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
import type {
  WorkspaceTaskFinalizationPreview,
  WorkspaceTaskFinalization,
} from "@getpaseo/protocol/messages";
import type { SingleResult } from "../../output/index.js";

export interface FinalizationConnection {
  inspectWorkspaceTaskFinalization(id: string): Promise<WorkspaceTaskFinalizationPreview>;
  applyWorkspaceTaskFinalization(token: string): Promise<{ task: WorkspaceTaskFinalization }>;
  getWorkspaceTaskFinalization(id: string): Promise<{ task: WorkspaceTaskFinalization | null }>;
}
export interface FinalizationInteraction {
  interactive: boolean;
  preview(value: WorkspaceTaskFinalizationPreview): void;
  confirm(message: string): Promise<string>;
}

export async function reviewTaskFinalization(
  client: FinalizationConnection,
  id: string,
  mode: "inspect" | "status" | "apply",
  interaction: FinalizationInteraction,
) {
  if (mode === "status") return client.getWorkspaceTaskFinalization(id);
  const preview = await client.inspectWorkspaceTaskFinalization(id);
  if (mode === "inspect") return preview;
  if (preview.blockers.length || !preview.task || !preview.previewToken)
    throw new Error(`Task finalization blocked: ${preview.blockers.join("; ")}`);
  if (!interaction.interactive)
    throw new Error(
      "Interactive reviewed completion is required. Use --inspect or the same connected SDK client to review and apply.",
    );
  interaction.preview(preview);
  const expected = `finalize ${preview.task.headSha}`;
  const answer = await interaction.confirm(
    `This removes the exact task checkout and local branch, including its owned generated outputs. Conversation/native history and retained source review are preserved. Declare this entire task complete by typing '${expected}': `,
  );
  if (answer.trim() !== expected) throw new Error("Task completion canceled; nothing was retired");
  return client.applyWorkspaceTaskFinalization(preview.previewToken);
}

interface FinalizationCommandData {
  workspaceId: string;
  result: Awaited<ReturnType<typeof reviewTaskFinalization>>;
}
export async function runFinalizeCommand(
  id: string,
  options: { daemonTarget: DaemonTarget; inspect?: boolean; status?: boolean },
  _command: Command,
): Promise<SingleResult<FinalizationCommandData>> {
  if (options.inspect && options.status) throw new Error("Choose --inspect or --status");
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    let mode: "inspect" | "status" | "apply" = "apply";
    if (options.inspect) mode = "inspect";
    else if (options.status) mode = "status";
    const data = await reviewTaskFinalization(client, id, mode, {
      interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      preview: (value) => process.stderr.write(`${JSON.stringify(value, null, 2)}\n`),
      confirm: async (message) => {
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await prompt.question(message);
        } finally {
          prompt.close();
        }
      },
    });
    return {
      type: "single",
      data: { workspaceId: id, result: data },
      schema: {
        idField: "workspaceId",
        columns: [],
        renderHuman: (result) => JSON.stringify(result.data, null, 2),
      },
    };
  } finally {
    await client.close();
  }
}
