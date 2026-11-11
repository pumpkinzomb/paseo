import assert from "node:assert/strict";
import test from "node:test";
import { validateWithPorts, validationEnvironment } from "./dev-update-validation.mjs";

function fixture(overrides = {}) {
  const events = [];
  const config = { serverId: "fixture", daemonPort: 19201 };
  let running = false;
  const runtime = {
    ready: async () => {
      events.push("ready");
    },
    exited: Promise.resolve({ code: 0 }),
    requestQuit: async () => {
      events.push("quit");
      running = false;
    },
    stopMetro: async () => {
      events.push("metro-stop");
    },
    ...overrides.runtime,
  };
  return {
    events,
    options: {
      config,
      root: "/isolated/candidate",
      control: "/isolated/control",
      launch: async () => {
        events.push("launch");
        running = true;
        return runtime;
      },
      inspect: async () => {
        events.push("hydrate");
        return { hydrated: true, route: "/h/fixture" };
      },
      readDaemon: async () => (running ? { serverId: "fixture", listen: "127.0.0.1:19201" } : null),
      ...overrides.ports,
    },
  };
}

test("validation environment inherits no credentials, provider state or HOME", () => {
  const env = validationEnvironment("/private/fixture", {
    HOME: "/real/home",
    PATH: "/node/bin",
    OPENAI_API_KEY: "never",
    PASEO_HOME: "/live/home",
    NODE_OPTIONS: "--require secrets",
    GITHUB_TOKEN: "never",
    SSH_AUTH_SOCK: "/ssh",
    EXPO_DEV_URL: "http://live",
  });
  assert.equal(env.HOME, "/private/fixture/os-home");
  assert.equal(env.PATH, "/node/bin");
  for (const name of [
    "OPENAI_API_KEY",
    "PASEO_HOME",
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "EXPO_DEV_URL",
  ])
    assert.equal(env[name], undefined);
});
test("success requires desktop, daemon and hydrated UI then normal owned cleanup", async () => {
  const f = fixture();
  const result = await validateWithPorts(f.options);
  assert.equal(result.normalQuit, true);
  assert.equal(result.retainedProcesses, false);
  assert.deepEqual(f.events, ["launch", "ready", "hydrate", "quit", "metro-stop"]);
});
test("renderer failure still quits desktop and Metro without forcekill", async () => {
  const f = fixture({
    ports: {
      inspect: async () => {
        throw new Error("renderer failed");
      },
    },
  });
  await assert.rejects(
    validateWithPorts(f.options),
    (error) => error.message.includes("renderer failed") && error.retainedProcesses === false,
  );
  assert.deepEqual(f.events, ["launch", "ready", "quit", "metro-stop"]);
});
test("unhydrated UI cannot pass", async () => {
  const f = fixture({ ports: { inspect: async () => ({ hydrated: false }) } });
  await assert.rejects(validateWithPorts(f.options), /did not hydrate/);
});
test("quit failure reports retained processes while still attempting Metro stop", async () => {
  const f = fixture({
    runtime: {
      requestQuit: async () => {
        throw new Error("quit refused");
      },
    },
    ports: { readDaemon: async () => null },
  });
  await assert.rejects(
    validateWithPorts(f.options),
    (error) => error.retainedProcesses === true && error.message.includes("quit refused"),
  );
  assert.ok(f.events.includes("metro-stop"));
});
test("launch failure reports uncertain retained processes instead of pretending cleanup", async () => {
  const f = fixture({
    ports: {
      launch: async () => {
        throw new Error("launch failed");
      },
    },
  });
  await assert.rejects(validateWithPorts(f.options), (error) => error.retainedProcesses === true);
});
