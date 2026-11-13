import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPersistenceHandle } from "../../agent-sdk-types.js";
import { claudeConfigDir, claudeTranscriptPath } from "./project-dir.js";

/** Fail closed when the SDK's process-wide config differs from this provider profile.
 * Never change process.env to delete a session belonging to a different profile.
 */
export async function deleteClaudeNativeSession(
  handle: AgentPersistenceHandle,
  configDir: string,
  remove: typeof deleteSession = deleteSession,
): Promise<void> {
  if (
    handle.provider !== "claude" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(handle.sessionId) ||
    (handle.nativeHandle != null && handle.nativeHandle !== handle.sessionId)
  )
    throw new Error("Native deletion requires an exact Claude session ID");
  const cwd = handle.metadata?.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    throw new Error("Native deletion requires the recorded project directory");
  const root = await realpath(configDir);
  if (root !== (await realpath(claudeConfigDir(process.env))))
    throw new Error("Claude SDK config differs from the recorded provider profile");
  const projects = path.join(root, "projects");
  if ((await realpath(projects)) !== projects)
    throw new Error("Claude projects directory must not be an alias");
  const transcript = await claudeTranscriptPath({
    cwd,
    sessionId: handle.sessionId,
    configDir: root,
  });
  const info = await lstat(transcript);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (await realpath(transcript)) !== transcript ||
    !transcript.startsWith(projects + path.sep)
  )
    throw new Error("Untrusted Claude transcript path");
  // The SDK removes both the transcript and its exact subagent-transcript directory.
  await remove(handle.sessionId, { dir: cwd });
}
