import { createHash } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { resolvePaseoHome } from "../../../paseo-home.js";

export const CodexLeadRuntimeSchema = z.object({
  version: z.literal(1),
  home: z.string(),
  codexHome: z.string(),
  cwd: z.string(),
  projectCwd: z.string(),
});
export type CodexLeadRuntime = z.infer<typeof CodexLeadRuntimeSchema>;

export async function codexLeadRuntimePaths(paseoHome = resolvePaseoHome()) {
  const canonicalHome = await canonicalFuturePath(path.resolve(paseoHome));
  // Development PASEO_HOME often lives inside the source checkout. Use one
  // stable sibling outside the outermost repo rather than loading its config.
  let outermostRepository: string | undefined;
  for (let parent = canonicalHome; ; parent = path.dirname(parent)) {
    try {
      await lstat(path.join(parent, ".git"));
      outermostRepository = parent;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (path.dirname(parent) === parent) break;
  }
  const identity = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 24);
  const root = outermostRepository
    ? path.join(path.dirname(outermostRepository), ".paseo-lead-runtimes", identity, "codex")
    : path.join(canonicalHome, "lead-runtime", "codex");
  const home = path.join(root, "home");
  return { home, codexHome: path.join(home, ".codex"), cwd: path.join(root, "workspace") };
}

async function canonicalFuturePath(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(directory));
  }
}

async function prepareRuntime(runtime: CodexLeadRuntime, paseoHome: string): Promise<void> {
  const expected = await codexLeadRuntimePaths(await canonicalFuturePath(paseoHome));
  for (const key of ["home", "codexHome", "cwd"] as const) {
    if ((await canonicalFuturePath(runtime[key])) !== expected[key]) {
      throw new Error(
        "Paseo lead runtime paths must not redirect outside their managed directories.",
      );
    }
  }
  // A managed HOME does not prevent Codex from discovering project config at cwd.
  // Refuse a managed scratch root nested in a repository rather than loading it.
  for (let parent = await canonicalFuturePath(runtime.cwd); ; parent = path.dirname(parent)) {
    try {
      await lstat(path.join(parent, ".git"));
      throw new Error(
        "Paseo lead runtime must be outside Git repositories; the managed fallback directory is inside a repository.",
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (path.dirname(parent) === parent) break;
  }
  await mkdir(runtime.codexHome, { recursive: true });
  await mkdir(runtime.cwd, { recursive: true });
}

export async function resolveCodexLeadRuntime(input: {
  config: AgentSessionConfig;
  environment: Record<string, string>;
  resumeMetadata?: Record<string, unknown>;
  isResume: boolean;
  paseoHome?: string;
}): Promise<{
  config: AgentSessionConfig;
  environment: Record<string, string>;
  runtime?: CodexLeadRuntime;
  status?: "isolated" | "legacy-unisolated";
}> {
  const marker = input.resumeMetadata?.paseoLeadRuntime;
  if (input.config.instructionProfile !== "paseo-lead" && marker === undefined) {
    return { config: input.config, environment: input.environment };
  }
  if (input.isResume && marker === undefined) {
    // Never move native histories or credentials merely to reopen an existing session.
    return { config: input.config, environment: input.environment, status: "legacy-unisolated" };
  }
  const paths = await codexLeadRuntimePaths(input.paseoHome);
  const runtime: CodexLeadRuntime = input.isResume
    ? CodexLeadRuntimeSchema.parse(marker)
    : { version: 1, ...paths, projectCwd: input.config.cwd };
  for (const key of ["home", "codexHome", "cwd"] as const) {
    if (runtime[key] !== paths[key]) {
      throw new Error(
        "The Paseo lead runtime home changed. Restore its original PASEO_HOME or create a new lead session.",
      );
    }
  }
  await prepareRuntime(runtime, input.paseoHome ?? resolvePaseoHome());
  return {
    config: { ...input.config, cwd: runtime.cwd, instructionProfile: "paseo-lead" },
    environment: {
      ...input.environment,
      HOME: runtime.home,
      USERPROFILE: runtime.home,
      CODEX_HOME: runtime.codexHome,
      XDG_CONFIG_HOME: path.join(runtime.home, ".config"),
      XDG_DATA_HOME: path.join(runtime.home, ".local", "share"),
      XDG_CACHE_HOME: path.join(runtime.home, ".cache"),
      XDG_STATE_HOME: path.join(runtime.home, ".local", "state"),
    },
    runtime,
    status: "isolated",
  };
}
