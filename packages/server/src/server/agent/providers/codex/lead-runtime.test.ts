import { mkdtemp, mkdir, rm, access, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { codexLeadRuntimePaths, resolveCodexLeadRuntime } from "./lead-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-lead-codex-"));
  roots.push(root);
  return root;
}
const config: AgentSessionConfig = {
  provider: "codex",
  cwd: "/source/project",
  instructionProfile: "paseo-lead",
};
const environment = {
  HOME: "/native/home",
  CODEX_HOME: "/native/codex",
  OPENAI_API_KEY: "explicit-fixture-key",
};

describe("Codex lead runtime", () => {
  test("creates one fixed scope without copying auth and preserves explicit environment", async () => {
    const paseoHome = await fixture();
    const input = { config, environment, isResume: false, paseoHome };
    const first = await resolveCodexLeadRuntime(input);
    const second = await resolveCodexLeadRuntime(input);
    expect(first.runtime).toEqual(second.runtime);
    expect(first.environment).toMatchObject({
      HOME: first.runtime?.home,
      CODEX_HOME: first.runtime?.codexHome,
      OPENAI_API_KEY: "explicit-fixture-key",
    });
    expect(first.config.cwd).toBe(first.runtime?.cwd);
    expect(first.runtime?.projectCwd).toBe(config.cwd);
    await expect(access(path.join(first.runtime!.codexHome, "auth.json"))).rejects.toThrow();
    expect(environment.HOME).toBe("/native/home");
  });

  test("resumes only marked scopes and does not move legacy native sessions", async () => {
    const paseoHome = await fixture();
    const initial = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: false,
      paseoHome,
    });
    const resumed = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: true,
      paseoHome,
      resumeMetadata: { paseoLeadRuntime: initial.runtime },
    });
    expect(resumed.runtime).toEqual(initial.runtime);
    const legacy = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: true,
      paseoHome,
    });
    expect(legacy.status).toBe("legacy-unisolated");
    expect(legacy.config).toBe(config);
    expect(legacy.environment).toBe(environment);
  });

  test("worker environment stays untouched and no runtime is created", async () => {
    const paseoHome = await fixture();
    const worker = { ...config, instructionProfile: undefined };
    const result = await resolveCodexLeadRuntime({
      config: worker,
      environment,
      isResume: false,
      paseoHome,
    });
    expect(result).toEqual({ config: worker, environment });
    await expect(access((await codexLeadRuntimePaths(paseoHome)).home)).rejects.toThrow();
  });

  test("rejects a moved runtime marker instead of reading a different auth home", async () => {
    const paseoHome = await fixture();
    const initial = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: false,
      paseoHome,
    });
    await expect(
      resolveCodexLeadRuntime({
        config,
        environment,
        isResume: true,
        paseoHome: path.join(paseoHome, "other"),
        resumeMetadata: { paseoLeadRuntime: initial.runtime },
      }),
    ).rejects.toThrow("runtime home changed");
  });

  test("places development homes outside the outermost repository with a stable identity", async () => {
    const parent = await fixture();
    const repository = path.join(parent, "repo");
    const paseoHome = path.join(repository, "nested", ".dev", "paseo-home");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(path.join(repository, "nested", ".git"), { recursive: true });
    const result = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: false,
      paseoHome,
    });
    const paths = await codexLeadRuntimePaths(paseoHome);
    expect(result.runtime).toMatchObject(paths);
    expect(paths.cwd).not.toContain(`${repository}${path.sep}`);
    expect(paths.cwd).toContain(`${path.sep}.paseo-lead-runtimes${path.sep}`);
    expect(await codexLeadRuntimePaths(paseoHome)).toEqual(paths);
    expect(await codexLeadRuntimePaths(path.join(repository, "other-home"))).not.toEqual(paths);
    await expect(access(path.join(paseoHome, "lead-runtime"))).rejects.toThrow();
  });
  test.each(["home", "codexHome", "cwd"] as const)("rejects %s symlink escape", async (key) => {
    const paseoHome = await fixture();
    const external = await fixture();
    const paths = await codexLeadRuntimePaths(paseoHome);
    await mkdir(path.dirname(paths[key]), { recursive: true });
    await symlink(external, paths[key], "dir");
    await expect(
      resolveCodexLeadRuntime({ config, environment, isResume: false, paseoHome }),
    ).rejects.toThrow("must not redirect");
  });

  test("allows a symlink for PASEO_HOME itself but not managed descendants", async () => {
    const parent = await fixture();
    const realHome = await fixture();
    const paseoHome = path.join(parent, "paseo-home");
    await symlink(realHome, paseoHome, "dir");
    const result = await resolveCodexLeadRuntime({
      config,
      environment,
      isResume: false,
      paseoHome,
    });
    expect(result.status).toBe("isolated");
  });
});
