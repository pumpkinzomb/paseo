import { describe, expect, it } from "vitest";
import { inheritSupervisedLoginShellEnv } from "./environment.js";

function supervisedEnvironment(): NodeJS.ProcessEnv {
  return {
    PASEO_DEV_UPDATE_CONTROL_DIR: "/private/supervisor/generation",
    PASEO_DEV_UPDATE_GENERATION: "generation-1",
    PASEO_HOME: "/private/runtime/home",
    PASEO_LISTEN: "127.0.0.1:16781",
    EXPO_DEV_URL: "http://localhost:18091",
    EXPO_PUBLIC_LOCAL_DAEMON: "localhost:16781",
    APP_VARIANT: "development",
    BROWSER: "none",
    PATH: "/usr/bin",
  };
}

describe("supervised login-shell environment", () => {
  it("restores supervisor settings and deletes injected endpoints and execution flags", () => {
    const env = supervisedEnvironment();
    const original = { ...env };
    inheritSupervisedLoginShellEnv({
      env,
      isPackaged: false,
      inherit: () => {
        Object.assign(env, {
          PASEO_HOME: "/live/home",
          PASEO_LISTEN: "127.0.0.1:6767",
          PASEO_DEV_UPDATE_CONTROL_DIR: "/wrong/control",
          PASEO_DEV_UPDATE_GENERATION: "wrong-generation",
          PASEO_DAEMON_ENDPOINT: "localhost:6767",
          EXPO_DEV_URL: "http://live:8081",
          EXPO_PUBLIC_LOCAL_DAEMON: "localhost:6767",
          EXPO_PUBLIC_INJECTED: "unexpected",
          NODE_OPTIONS: "--require /wrong/injected.js",
          ELECTRON_RUN_AS_NODE: "1",
          APP_VARIANT: "production",
          BROWSER: "open",
          PATH: "/user/tools:/usr/bin",
          ORDINARY_SHELL_SETTING: "kept",
        });
      },
    });
    expect(env).toEqual({
      ...original,
      PATH: "/user/tools:/usr/bin",
      ORDINARY_SHELL_SETTING: "kept",
    });
  });

  it("restores deleted values and retains intentionally supplied protected values", () => {
    const env = { ...supervisedEnvironment(), NODE_OPTIONS: "--max-old-space-size=4096" };
    inheritSupervisedLoginShellEnv({
      env,
      isPackaged: false,
      inherit: () => {
        delete env.EXPO_DEV_URL;
        env.NODE_OPTIONS = "--require /wrong.js";
      },
    });
    expect(env.EXPO_DEV_URL).toBe("http://localhost:18091");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("restores the boundary even if shell inheritance throws", () => {
    const env = supervisedEnvironment();
    const original = { ...env };
    expect(() =>
      inheritSupervisedLoginShellEnv({
        env,
        isPackaged: false,
        inherit: () => {
          env.PASEO_HOME = "/live";
          throw new Error("shell failed");
        },
      }),
    ).toThrow("shell failed");
    expect(env).toEqual(original);
  });

  it.each([
    { isPackaged: false, env: {} },
    { isPackaged: false, env: { PASEO_DEV_UPDATE_CONTROL_DIR: "/control" } },
    { isPackaged: true, env: supervisedEnvironment() },
  ])("keeps normal and packaged startup behavior unchanged: %j", ({ isPackaged, env }) => {
    const environment: NodeJS.ProcessEnv = { ...env };
    inheritSupervisedLoginShellEnv({
      env: environment,
      isPackaged,
      inherit: () => {
        environment.PASEO_HOME = "/shell/home";
        environment.NODE_OPTIONS = "shell-options";
      },
    });
    expect(environment.PASEO_HOME).toBe("/shell/home");
    expect(environment.NODE_OPTIONS).toBe("shell-options");
  });
});
